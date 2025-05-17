require('dotenv').config()
require('global-agent/bootstrap')

const express = require('express')
const axios = require('axios')
const ccxt = require('ccxt')
const ti = require('technicalindicators')
const fs = require('fs').promises

const app = express()
const port = process.env.PORT || 10000

const kucoin = new ccxt.kucoin({
    enableRateLimit: true,
    apiKey: process.env.KUCOIN_API_KEY,
    secret: process.env.KUCOIN_API_SECRET,
    password: process.env.KUCOIN_API_PASSPHRASE
})

let isMonitoring = true

let isServiceActive = false
const tokenStates = new Map()
const botStats = {
    startTime: new Date(),
    cyclesCompleted: 0,
    totalAlertsSent: 0,
    errors: []
}

async function logEvent(type, message, data = {}) {
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [${type}] ${message}`)

    botStats.errors.push({ timestamp, type, message, ...data })
    if (botStats.errors.length > 20) botStats.errors.shift()

    try {
        await fs.appendFile('/tmp/crypto-bot-logs.json',
            JSON.stringify({ timestamp, type, message, ...data }) + '\n'
        )
    } catch (err) { }
}

async function loadMarketsWithRetry() {
    for (let i = 0; i < 5; i++) {
        try {
            const markets = await kucoin.loadMarkets(true)

            console.log('Mercados cargados (ejemplos):', Object.keys(markets).slice(0, 3))

            const leveragedSymbols = Object.values(markets).filter(m => {
                const isLeveraged = m.leveraged || m.id.includes('3L') || m.id.includes('3S')
                return m.active && isLeveraged && m.quote === 'USDT'
            })

            console.log('Símbolos filtrados:', leveragedSymbols.map(m => m.symbol))
            return leveragedSymbols.map(m => m.symbol)
        } catch (error) {
            logEvent('ERROR', `Intento ${i + 1}/5 fallido`, { error: error.message })
            await new Promise(r => setTimeout(r, 15000 * (i + 1)))
        }
    }
    throw new Error('Fallo permanente al cargar mercados')
}

async function fetchOHLCV(symbol) {
    try {
        const ohlcv = await kucoin.fetchOHLCV(symbol, '15m', undefined, 100)
        if (!ohlcv || ohlcv.length < 21) throw new Error('Datos insuficientes')
        return ohlcv
    } catch (error) {
        logEvent('WARN', `Error OHLCV ${symbol}`, { error: error.message })
        return null
    }
}

function calculateIndicators(ohlcv) {
    try {
        const closes = ohlcv.map(c => c[4]).slice(-21)
        return {
            rsi: ti.RSI.calculate({ period: 14, values: closes }).pop(),
            lastClose: closes[closes.length - 1],
            changePercent: ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100
        }
    } catch (error) {
        logEvent('ERROR', 'Error cálculo indicadores', { error: error.message })
        return null
    }
}

async function sendTelegramAlert(message) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: `${message}\n\nActualizado: ${new Date().toLocaleString()}`,
                parse_mode: 'Markdown'
            },
            { timeout: 10000 }
        )
        return true
    } catch (error) {
        logEvent('ERROR', 'Error Telegram', { error: error.message })
        return false
    }
}

async function analyzeSymbol(symbol) {
    try {
        const ohlcv = await fetchOHLCV(symbol)
        if (!ohlcv) return false

        const indicators = calculateIndicators(ohlcv)
        if (!indicators) return false

        const lastState = tokenStates.get(symbol) || { sobrecompra: false, sobrevendido: false }
        const newState = {
            sobrecompra: indicators.rsi > 70,
            sobrevendido: indicators.rsi < 30,
            rsi: indicators.rsi
        }

        if ((newState.sobrecompra && !lastState.sobrecompra) ||
            (newState.sobrevendido && !lastState.sobrevendido)) {

            const alertMessage = `📈📉 *${symbol}*\n` +
                `RSI: ${indicators.rsi.toFixed(2)} ${newState.sobrecompra ? '🔴' : '🟢'}\n` +
                `Precio: ${indicators.lastClose.toFixed(4)} USDT\n` +
                `Cambio 15m: ${indicators.changePercent.toFixed(2)}%\n\n` +
                `${newState.sobrecompra
                    ? "🔥 *Mercado sobrecalentado*\n✅ Recomendación: **VENDER**"
                    : "❄️ *Mercado infravalorado*\n✅ Recomendación: **COMPRAR**"}`

            const success = await sendTelegramAlert(alertMessage)
            if (success) {
                botStats.totalAlertsSent++
                tokenStates.set(symbol, { ...newState, lastAlert: Date.now() })
            }
            return success
        }
        return false
    } catch (error) {
        logEvent('ERROR', `Error análisis ${symbol}`, { error: error.message })
        return false
    }
}

async function monitorCycle() {
    try {
        const symbols = await loadMarketsWithRetry()
        logEvent('INFO', `Iniciando ciclo con ${symbols.length} símbolos`)

        if (symbols.length === 0) {
            logEvent('CRITICAL', 'No se encontraron símbolos. Reiniciando...')
        }

            tokenStates.clear()

            let alertCount = 0

            for (const symbol of symbols) {
                if (!isServiceActive) break

                try {
                    const alertSent = await analyzeSymbol(symbol)
                    if (alertSent) alertCount++
                } catch (error) {
                    logEvent('ERROR', `Error procesando ${symbol}`, { error: error.message })
                }

                const remainingRequests = kucoin.lastResponseHeaders?.['x-ratelimit-remaining'] || 30
                const resetTime = kucoin.lastResponseHeaders?.['x-ratelimit-reset']

                if (remainingRequests < 5) {
                    const waitSeconds = Math.ceil((resetTime * 1000 - Date.now()) / 1000)
                    logEvent('WARN', `Rate limit crítico. Esperando ${waitSeconds}s`)
                    await new Promise(r => setTimeout(r, waitSeconds * 1000))
                } else {
                    await new Promise(r => setTimeout(r, 1500))
                }
            }

            botStats.cyclesCompleted++
            logEvent('INFO', `Ciclo completado. Alertas enviadas: ${alertCount}`)

            if (isServiceActive) setTimeout(monitorCycle, 300000)

        } catch (error) {
            logEvent('CRITICAL', 'Error recuperable en ciclo', { error: error.message })
            if (isServiceActive) setTimeout(monitorCycle, 60000)
        }
    }

function startHeartbeat() {
        setInterval(() => {
            if (botStats.cyclesCompleted > 0 && botStats.totalAlertsSent === 0) {
                logEvent('WARN', 'Heartbeat: Reiniciando monitorización')
                monitorCycle()
            }
        }, 600000)
    }

    app.get('/status', (req, res) => res.json({
        ...botStats,
        lastSuccessfulAlert: tokenStates.size > 0 ?
            new Date(Math.max(...Array.from(tokenStates.values()).map(s => s.lastAlert))) : null,
        activeSymbols: tokenStates.size
    }))

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => {
        console.log("⚠️ Apagando servicio...")
        isMonitoring = false
        process.exit(0)
    })

    function shutdown(reason) {
        logEvent('INFO', `Apagado por ${reason}`)
        isServiceActive = false
        setTimeout(() => process.exit(0), 5000)
    }

    app.get('/debug/limits', (req, res) => {
        res.json({
            remaining: kucoin.lastResponseHeaders?.['x-ratelimit-remaining'],
            reset: kucoin.lastResponseHeaders?.['x-ratelimit-reset']
        })
    })

    app.get('/', (req, res) => res.send('Bot activo'))

    app.listen(port, () => {
        console.log(`🚀 Servidor operativo en puerto ${port}`)
        monitorCycle().catch(console.error)
        startHeartbeat()
    })

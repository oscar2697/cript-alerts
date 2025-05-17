require('dotenv').config()
require('global-agent/bootstrap')

const express = require('express')
const axios = require('axios')
const ccxt = require('ccxt')
const ti = require('technicalindicators')
const fs = require('fs').promises

const app = express()
const port = process.env.PORT || 3000

const kucoin = new ccxt.kucoin({
    enableRateLimit: true,
    rateLimit: 20000,
    timeout: 45000,
    apiKey: process.env.KUCOIN_API_KEY,
    secret: process.env.KUCOIN_API_SECRET,
    password: process.env.KUCOIN_API_PASSPHRASE,
    options: { adjustForTimeDifference: true, version: 'v2' }
})

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
    for (let i = 0; i < 3; i++) {
        try {
            const markets = await kucoin.loadMarkets(true)
            return Object.values(markets)
                .filter(m => m.active && m.leveraged && m.quote === 'USDT')
                .map(m => m.symbol)
        } catch (error) {
            if (i === 2) throw error
            await new Promise(r => setTimeout(r, 10000 * (i + 1)))
        }
    }
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
                `Cambio 15m: ${indicators.changePercent.toFixed(2)}%`

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

        for (const symbol of symbols) {
            if (!isServiceActive) break
            await analyzeSymbol(symbol)
            await new Promise(r => setTimeout(r, 3000))
        }

        botStats.cyclesCompleted++
        logEvent('INFO', `Ciclo completado. Total alertas: ${botStats.totalAlertsSent}`)

    } catch (error) {
        logEvent('CRITICAL', 'Error ciclo monitoreo', { error: error.message })
    } finally {
        if (isServiceActive) setTimeout(monitorCycle, 300000)
    }
}

app.get('/status', (req, res) => res.json({
    ...botStats,
    lastSuccessfulAlert: tokenStates.size > 0 ?
        new Date(Math.max(...Array.from(tokenStates.values()).map(s => s.lastAlert))) : null,
    activeSymbols: tokenStates.size
}))

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

function shutdown(reason) {
    logEvent('INFO', `Apagado por ${reason}`)
    isServiceActive = false
    setTimeout(() => process.exit(0), 5000)
}

app.listen(port, () => {
    logEvent('INFO', `Servidor iniciado en puerto ${port}`)
    isServiceActive = true
    monitorCycle()
})
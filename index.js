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
        const ohlcv = await fetchOHLCV(symbol);
        if (!ohlcv) return false;

        const indicators = calculateIndicators(ohlcv);
        if (!indicators) return false;

        logEvent('DEBUG', `Analizando ${symbol}`, {
            rsi: indicators.rsi,
            lastClose: indicators.lastClose,
            changePercent: indicators.changePercent
        });

        const lastState = tokenStates.get(symbol) || { sobrecompra: false, sobrevendido: false };
        if (Date.now() - (lastState.lastAlert || 0) > 3600000) {
            tokenStates.delete(symbol);
        }

        const newState = {
            sobrecompra: indicators.rsi > 70,
            sobrevendido: indicators.rsi < 30,
            rsi: indicators.rsi,
            lastAlert: Date.now()
        };

        const shouldAlert = (
            (newState.sobrecompra && !lastState.sobrecompra) ||
            (newState.sobrevendido && !lastState.sobrevendido)
        ) && Math.abs(indicators.rsi - 50) > 20;

        if (shouldAlert) {
            const action = newState.sobrecompra ? "VENDER 🔴" : "COMPRAR 🟢";
            const alertMessage = `🚨 *ALERTA ${symbol}* 🚨\n` +
                `📊 RSI: ${indicators.rsi.toFixed(2)}\n` +
                `💰 Precio: ${indicators.lastClose.toFixed(4)} USDT\n` +
                `📈 Cambio 15m: ${indicators.changePercent.toFixed(2)}%\n\n` +
                `💡 Recomendación: **${action}**`;

            const success = await sendTelegramAlert(alertMessage);
            if (success) {
                logEvent('ALERT', `Alerta enviada: ${symbol}`, { rsi: indicators.rsi });
                botStats.totalAlertsSent++;
                tokenStates.set(symbol, newState);
                return true;
            }
        }
        return false;

    } catch (error) {
        logEvent('ERROR', `Error en ${symbol}`, {
            error: error.message,
            stack: error.stack
        });
        return false;
    }
}


async function monitorCycle() {
    try {
        const symbols = await loadMarketsWithRetry();
        logEvent('INFO', `Iniciando nuevo ciclo con ${symbols.length} símbolos`);

        tokenStates.clear();

        let alertCount = 0;
        const startTime = Date.now();

        for (const [index, symbol] of symbols.entries()) {
            if (!isServiceActive) break;

            const elapsed = Date.now() - startTime;
            const remaining = kucoin.lastResponseHeaders?.['x-ratelimit-remaining'] || 30;

            if (remaining < 10) {
                const waitTime = Math.floor(5000 * (index / symbols.length));
                logEvent('DEBUG', `Pausa preventiva: ${waitTime}ms`);
                await new Promise(r => setTimeout(r, waitTime));
            }

            const result = await analyzeSymbol(symbol);
            if (result) alertCount++;
        }

        logEvent('INFO', `Ciclo completado en ${((Date.now() - startTime) / 1000).toFixed(1)}s. Alertas: ${alertCount}`);

        const nextCycle = alertCount > 0 ? 300000 : 600000; 
        if (isServiceActive) setTimeout(monitorCycle, nextCycle);

    } catch (error) {
        logEvent('CRITICAL', 'Error en ciclo', {
            error: error.message,
            retryIn: '60s'
        });
        if (isServiceActive) setTimeout(monitorCycle, 60000);
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

require('dotenv').config()
require('global-agent/bootstrap')

const express = require('express')
const axios = require('axios')
const ccxt = require('ccxt')
const ti = require('technicalindicators')
const fs = require('fs').promises

const app = express()
const port = process.env.PORT || 3000

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
const telegramChatId = process.env.TELEGRAM_CHAT_ID

const kucoinConfig = {
    enableRateLimit: true,
    rateLimit: 20000,
    timeout: 45000,
    apiKey: process.env.KUCOIN_API_KEY,
    secret: process.env.KUCOIN_API_SECRET,
    password: process.env.KUCOIN_API_PASSPHRASE,
    options: {
        adjustForTimeDifference: true,
        recvWindow: 60000,
        version: 'v2'
    }
}

const kucoin = new ccxt.kucoin(kucoinConfig)

let isServiceActive = false
const tokenStates = new Map()
const botStats = {
    startTime: new Date(),
    cyclesCompleted: 0,
    totalAlertsTriggered: 0,
    totalAlertsSent: 0,
    failedAlerts: 0,
    lastSuccessfulAlert: null,
    errors: []
}

const LOG_FILE = '/tmp/crypto-bot-logs.json'

// --- Funciones mejoradas ---
async function saveLog(data) {
    try {
        const logs = JSON.parse(await fs.readFile(LOG_FILE, 'utf8').slice(-99))
        logs.push({ timestamp: new Date().toISOString(), ...data })
        await fs.writeFile(LOG_FILE, JSON.stringify(logs, null, 2))
    } catch (err) {
        await fs.writeFile(LOG_FILE, JSON.stringify([data]))
    }
}

function logEvent(type, message, data = {}) {
    const entry = `[${new Date().toISOString()}] [${type}] ${message}`
    console.log(entry)
    saveLog({ type, message, ...data })

    if (type === 'ERROR') {
        botStats.errors.push({
            timestamp: new Date().toISOString(),
            message,
            ...data
        })
        botStats.errors = botStats.errors.slice(-20)
    }
}

async function verifyKuCoinConnection() {
    try {
        const status = await kucoin.fetchStatus()
        if (status.status !== 'ok') throw new Error('Estado API no ok')

        const serverTime = await kucoin.fetchTime()
        const timeDiff = Math.abs(Date.now() - serverTime)
        if (timeDiff > 5000) logEvent('WARN', `Diferencia temporal: ${timeDiff}ms`)

        return true
    } catch (error) {
        logEvent('ERROR', 'Fallo conexión KuCoin', {
            error: error.message,
            code: error.code,
            credentials: {
                key: !!process.env.KUCOIN_API_KEY,
                secret: !!process.env.KUCOIN_API_SECRET,
                passphrase: !!process.env.KUCOIN_API_PASSPHRASE
            }
        })
        return false
    }
}

async function safeLoadMarkets() {
    try {
        const markets = await kucoin.loadMarkets(true)

        // Verificación de datos críticos
        const requiredSymbols = ['BTC/USDT', 'ETH/USDT']
        const missing = requiredSymbols.filter(s => !markets[s])
        if (missing.length > 0) throw new Error(`Símbolos faltantes: ${missing.join(', ')}`)

        return Object.values(markets)
            .filter(m => m.active && m.leveraged && m.quote === 'USDT')
            .map(m => m.symbol)

    } catch (error) {
        logEvent('ERROR', 'Fallo carga mercados', {
            error: error.message,
            lastRequest: kucoin.lastRequestUrl,
            responseStatus: kucoin.lastResponseStatusCode
        })
        process.exit(1)
    }
}

async function initializeService() {
    if (!await verifyKuCoinConnection()) process.exit(1)

    try {
        const symbols = await safeLoadMarkets()
        logEvent('INFO', `Mercados cargados: ${symbols.length} símbolos`)
        return symbols
    } catch (error) {
        logEvent('CRITICAL', 'Fallo inicialización', { stack: error.stack })
        process.exit(1)
    }
}

async function fetchWithRetry(symbol, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const ohlcv = await kucoin.fetchOHLCV(symbol, '15m', undefined, 100)
            if (ohlcv?.length >= 21) return ohlcv
            throw new Error('Datos insuficientes')
        } catch (error) {
            if (attempt === retries) throw error
            await new Promise(r => setTimeout(r, 5000 * attempt))
        }
    }
}

function calculateIndicators(ohlcv) {
    const closes = ohlcv.slice(-21).map(c => c[4])
    const volumes = ohlcv.slice(-20).map(c => c[5])

    return {
        lastClose: closes[closes.length - 1],
        changePercent: ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100,
        ema9: ti.EMA.calculate({ period: 9, values: closes }).pop(),
        ema21: ti.EMA.calculate({ period: 21, values: closes }).pop(),
        rsi: ti.RSI.calculate({ period: 14, values: closes }).pop(),
        volumeAvg: ti.SMA.calculate({ period: 20, values: volumes }).pop()
    }
}

async function sendTelegramAlert(message) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const { data } = await axios.post(
                `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
                {
                    chat_id: telegramChatId,
                    text: `${message}\n\n_Actualizado: ${new Date().toISOString()}_`,
                    parse_mode: 'Markdown'
                },
                { timeout: 10000 }
            )
            if (data.ok) return true
        } catch (error) {
            if (error.response?.status === 429) {
                await new Promise(r => setTimeout(r, error.response.headers['retry-after'] * 1000 || 15000))
            }
            if (attempt === 3) return false
            await new Promise(r => setTimeout(r, 5000))
        }
    }
}

async function analyzeAndAlert(symbol) {
    try {
        const ohlcv = await fetchWithRetry(symbol)
        const indicators = calculateIndicators(ohlcv)

        const lastState = tokenStates.get(symbol) || { sobrecompra: false, sobrevendido: false }
        const newState = {
            sobrecompra: indicators.rsi > 70,
            sobrevendido: indicators.rsi < 30,
            lastCheck: Date.now(),
            rsi: indicators.rsi
        }

        if ((newState.sobrecompra && !lastState.sobrecompra) ||
            (newState.sobrevendido && !lastState.sobrevendido)) {

            const message = `${newState.sobrecompra ? '📉' : '📈'} *${symbol}*\n` +
                `RSI: ${indicators.rsi.toFixed(2)} ${newState.sobrecompra ? '🔴' : '🟢'}\n` +
                `Precio: ${indicators.lastClose.toFixed(4)} USDT\n` +
                `Cambio 15m: ${indicators.changePercent.toFixed(2)}%`

            const success = await sendTelegramAlert(message)
            if (success) {
                botStats.totalAlertsSent++
                newState.lastAlert = Date.now()
            }
            tokenStates.set(symbol, newState)
            return success
        }
        return false
    } catch (error) {
        logEvent('ERROR', `Error en ${symbol}`, { error: error.message })
        return false
    }
}

async function monitorTokens() {
    try {
        const symbols = await initializeService()
        logEvent('INFO', `Iniciando monitoreo de ${symbols.length} tokens`)

        const BATCH_SIZE = 2
        const BATCH_DELAY = 10000

        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
            const batch = symbols.slice(i, i + BATCH_SIZE)
            await Promise.allSettled(batch.map(symbol => analyzeAndAlert(symbol)))

            const remaining = kucoin.lastResponseHeaders?.['x-ratelimit-remaining'] || 10
            if (remaining < 5) {
                const resetTime = parseInt(kucoin.lastResponseHeaders['x-ratelimit-reset'], 10) * 1000
                const waitTime = Math.max(resetTime - Date.now(), 0)
                logEvent('WARN', `Rate limit bajo. Esperando ${Math.round(waitTime / 1000)}s`)
                await new Promise(r => setTimeout(r, waitTime))
            }

            await new Promise(r => setTimeout(r, BATCH_DELAY))
        }

        botStats.cyclesCompleted++
        logEvent('INFO', `Ciclo completado. Próximo en 5m`)
        setTimeout(monitorTokens, 300000)

    } catch (error) {
        logEvent('CRITICAL', 'Fallo en monitoreo', { error: error.stack })
        process.exit(1)
    }
}

// --- Endpoints ---
app.use(express.json())

app.get('/', (req, res) => res.json({
    status: isServiceActive ? 'active' : 'inactive',
    uptime: Math.floor(process.uptime())
}))

app.get('/status', (req, res) => res.json({
    ...botStats,
    lastSuccessfulAlert: botStats.lastSuccessfulAlert?.toISOString(),
    startTime: botStats.startTime.toISOString()
}))

app.post('/restart', (req, res) => {
    isServiceActive = true
    tokenStates.clear()
    Object.assign(botStats, {
        cyclesCompleted: 0,
        totalAlertsTriggered: 0,
        totalAlertsSent: 0,
        failedAlerts: 0,
        errors: [],
        startTime: new Date()
    })
    monitorTokens()
    res.json({ status: 'restarting' })
})

// --- Manejo de procesos ---
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (err) => {
    logEvent('CRITICAL', 'Excepción no capturada', { stack: err.stack })
    shutdown('UNCAUGHT_EXCEPTION')
})
process.on('unhandledRejection', (reason) => {
    logEvent('CRITICAL', 'Promesa rechazada', { reason: reason.stack || reason })
    shutdown('UNHANDLED_REJECTION')
})

function shutdown(reason) {
    logEvent('WARN', `Apagado iniciado (${reason})`)
    isServiceActive = false
    setTimeout(() => process.exit(0), 5000)
}

// --- Inicialización ---
app.listen(port, () => {
    logEvent('INFO', `Servidor iniciado en puerto ${port}`)
    setTimeout(() => {
        initializeService()
            .then(() => {
                isServiceActive = true
                monitorTokens()
            })
            .catch(() => process.exit(1))
    }, 10000)
})
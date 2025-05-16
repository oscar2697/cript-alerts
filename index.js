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

const kucoin = new ccxt.kucoin({
    enableRateLimit: true,
    rateLimit: 3000,
    timeout: 30000,
    apiKey: process.env.KUCOIN_API_KEY,
    secret: process.env.KUCOIN_API_SECRET,
    password: process.env.KUCOIN_API_PASSPHRASE
})

const tokenStates = new Map()
let isMonitoringActive = false

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

async function saveLog(data) {
    try {
        let logs = []
        try {
            const existingData = await fs.readFile(LOG_FILE, 'utf8')
            logs = JSON.parse(existingData)
            if (logs.length >= 100) logs = logs.slice(-99)
        } catch (err) { }

        logs.push({ timestamp: new Date().toISOString(), ...data })
        await fs.writeFile(LOG_FILE, JSON.stringify(logs, null, 2))
    } catch (err) { }
}

function logEvent(type, message, data = {}) {
    const logData = { type, message, ...data }
    console.log(`[${new Date().toISOString()}] [${type}] ${message}`)
    saveLog(logData)
    if (type === 'ERROR') {
        botStats.errors.push({ time: new Date().toISOString(), message, ...data })
        if (botStats.errors.length > 20) botStats.errors.shift()
    }
}

async function getLeverageTokens() {
    try {
        const markets = await kucoin.loadMarkets(true)
        return Object.values(markets)
            .filter(m => m.active && m.leveraged && m.quote === 'USDT')
            .map(m => m.symbol)
    } catch (error) {
        logEvent('ERROR', 'Error cargando mercados', { error: error.stack })
        return []
    }
}

async function fetchWithRetry(symbol, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const ohlcv = await kucoin.fetchOHLCV(symbol, '15m', undefined, 100)
            if (!ohlcv || ohlcv.length < 21) throw new Error('Datos insuficientes')
            return ohlcv
        } catch (error) {
            if (i === retries - 1) throw error
            await new Promise(resolve => setTimeout(resolve, 5000 * (i + 1)))
        }
    }
}

function calculateIndicators(ohlcv) {
    try {
        const close = ohlcv.map(c => c[4]).slice(-21)
        const volume = ohlcv.map(c => c[5]).slice(-20)

        const ema9 = ti.EMA.calculate({ period: 9, values: close })
        const ema21 = ti.EMA.calculate({ period: 21, values: close })
        const rsi = ti.RSI.calculate({ period: 14, values: close })
        const volumeAvg = ti.SMA.calculate({ period: 20, values: volume })

        return {
            lastClose: close[close.length - 1],
            changePercent: ((close[close.length - 1] - close[close.length - 2]) / close[close.length - 2]) * 100,
            ema9: ema9[ema9.length - 1],
            ema21: ema21[ema21.length - 1],
            rsi: rsi[rsi.length - 1],
            volumeAvg: volumeAvg[volumeAvg.length - 1]
        }
    } catch (error) {
        logEvent('ERROR', 'Error calculando indicadores', { error: error.stack })
        return null
    }
}

async function sendTelegramAlert(message) {
    const MAX_RETRIES = 3
    for (let retry = 0; retry < MAX_RETRIES; retry++) {
        try {
            const response = await axios.post(
                `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
                {
                    chat_id: telegramChatId,
                    text: `${message}\n\n_Bot time: ${new Date().toISOString()}_`,
                    parse_mode: 'Markdown'
                },
                { timeout: 8000 }
            )

            if (response.data?.ok) {
                botStats.lastSuccessfulAlert = new Date()
                return { success: true }
            }
        } catch (error) {
            if (error.response?.status === 429) {
                const retryAfter = error.response.headers['retry-after'] || 15
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000))
            }
        }
        await new Promise(resolve => setTimeout(resolve, 5000))
    }
    return { success: false }
}

async function analyzeAndAlert(symbol) {
    try {
        const start = Date.now()
        const ohlcv = await fetchWithRetry(symbol)
        const indicators = calculateIndicators(ohlcv)
        if (!indicators) return false

        const currentRsi = indicators.rsi
        const lastState = tokenStates.get(symbol) || { sobrecompra: false, sobrevendido: false, lastAlert: 0 }

        const newState = {
            sobrecompra: currentRsi > 70,
            sobrevendido: currentRsi < 30,
            lastCheck: Date.now(),
            rsi: currentRsi
        }

        const shouldAlert = (newState.sobrecompra && !lastState.sobrecompra) ||
            (newState.sobrevendido && !lastState.sobrevendido)

        if (shouldAlert) {
            const condition = newState.sobrecompra ? "SOBRECOMPRADO 🔴" : "SOBREVENDIDO 🟢"
            const message = `${newState.sobrecompra ? "📉" : "📈"} *${symbol}* | ${condition}\n` +
                `💰 Precio: ${indicators.lastClose.toFixed(4)} USDT\n` +
                `📊 RSI: ${currentRsi.toFixed(2)}\n` +
                `🔄 Cambio 15m: ${indicators.changePercent.toFixed(2)}%`

            const result = await sendTelegramAlert(message)
            if (result.success) {
                newState.lastAlert = Date.now()
                botStats.totalAlertsSent++
                logEvent('INFO', `Alerta enviada: ${symbol}`)
            }
            tokenStates.set(symbol, newState)
            return result.success
        }
        return false
    } catch (error) {
        logEvent('ERROR', `Error analizando ${symbol}`, { error: error.stack })
        return false
    }
}

async function monitorTokens() {
    if (!isMonitoringActive) return

    try {
        logEvent('INFO', `Iniciando ciclo #${botStats.cyclesCompleted + 1}`)
        const symbols = await getLeverageTokens()
        if (!symbols.length) return

        let alertsSent = 0
        const CONCURRENCY = 3
        const BATCH_DELAY = 10000

        for (let i = 0; i < symbols.length; i += CONCURRENCY) {
            if (!isMonitoringActive) break

            const batch = symbols.slice(i, i + CONCURRENCY)
            const results = await Promise.allSettled(batch.map(symbol => analyzeAndAlert(symbol)))
            alertsSent += results.filter(r => r.status === 'fulfilled' && r.value).length

            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY))
        }

        botStats.cyclesCompleted++
        logEvent('INFO', `Ciclo completado. Alertas: ${alertsSent}`)
    } catch (error) {
        logEvent('ERROR', 'Error en monitorización', { error: error.stack })
    } finally {
        if (isMonitoringActive) setTimeout(monitorTokens, 300000)
    }
}

app.use(express.json())

app.get('/', (req, res) => {
    res.json({
        status: isMonitoringActive ? 'active' : 'inactive',
        uptime: Math.floor(process.uptime())
    })
})

app.get('/status', (req, res) => {
    res.json({
        ...botStats,
        lastSuccessfulAlert: botStats.lastSuccessfulAlert?.toISOString(),
        startTime: botStats.startTime.toISOString()
    })
})

app.post('/restart', (req, res) => {
    isMonitoringActive = true
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

process.on('SIGTERM', () => {
    isMonitoringActive = false
    setTimeout(() => process.exit(0), 5000)
})

process.on('SIGINT', () => {
    isMonitoringActive = false
    setTimeout(() => process.exit(0), 5000)
})

process.on('uncaughtException', (error) => {
    logEvent('ERROR', 'Excepción no capturada', { stack: error.stack })
    setTimeout(() => process.exit(1), 10000)
})

process.on('unhandledRejection', (reason) => {
    logEvent('ERROR', 'Promesa rechazada', { reason: reason.stack || reason })
})

setTimeout(() => {
    isMonitoringActive = true
    monitorTokens()
}, 15000)

app.listen(port, () => {
    logEvent('INFO', `Servidor iniciado en puerto ${port}`)
})
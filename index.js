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
    rateLimit: 15000,
    timeout: 60000,
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

async function verifyKuCoinConnection() {
    try {
        const response = await kucoin.fetchStatus()
        
        if (response.status !== 'ok') {
            throw new Error(`Estado de API inesperado: ${response.status}`)
        }

        const serverTime = await kucoin.fetchTime()
        const localTime = Date.now()
        const timeDifference = Math.abs(serverTime - localTime)
        
        if (timeDifference > 5000) {
            logEvent('WARN', `Diferencia temporal significativa: ${timeDifference}ms`)
        }

        return true
    } catch (error) {
        logEvent('ERROR', 'Fallo de conexión con KuCoin', {
            error: error.message,
            code: error.code,
            url: kucoin.urls.api,
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
        
        const requiredMarkets = [
            'BTC3L/USDT',
            'BTC3S/USDT',
            'ETH3L/USDT',
            'ETH3S/USDT'
        ]
        
        const missingMarkets = requiredMarkets.filter(m => !markets[m])
        if (missingMarkets.length > 0) {
            throw new Error(`Mercados esenciales faltantes: ${missingMarkets.join(', ')}`)
        }
        
        return Object.values(markets)
            .filter(m => m.active && m.leveraged && m.quote === 'USDT')
            .map(m => m.symbol)
            
    } catch (error) {
        logEvent('ERROR', 'Error crítico en carga de mercados', {
            error: error.message,
            lastRequest: kucoin.lastRequest,
            lastResponse: kucoin.lastResponse
        })
        process.exit(1)
    }
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
            .filter(m =>
                m.active !== false &&
                m.leveraged === true &&
                m.quote === 'USDT' &&
                m.symbol.endsWith("3L/USDT") || m.symbol.endsWith("3S/USDT")
            )
            .map(m => m.symbol)
    } catch (error) {
        logEvent('ERROR', 'Fallo crítico al cargar mercados', {
            error: error.message,
            stack: error.stack,
            apiStatus: kucoin.lastResponseHeaders ? kucoin.lastResponseHeaders['x-ratelimit-remaining'] : 'N/A'
        });
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

async function initializeService() {
    if (!await verifyKuCoinConnection()) {
        logEvent('ERROR', 'Verificación fallida: Revise sus credenciales y conexión')
        process.exit(1)
    }
    
    try {
        const symbols = await safeLoadMarkets()
        logEvent('INFO', `Inicialización exitosa. Símbolos cargados: ${symbols.length}`)
        return symbols
        
    } catch (error) {
        logEvent('ERROR', 'Fallo de inicialización crítica', {
            error: error.stack,
            environment: Object.keys(process.env).filter(k => k.startsWith('KUCOIN'))
        })
        process.exit(1)
    }
}

setTimeout(async () => {
    try {
        await initializeMarkets();
        isMonitoringActive = true;
        monitorTokens();
    } catch (error) {
        logEvent('ERROR', 'Fallo permanente al cargar mercados', {
            error: error.stack,
            action: 'Reiniciando servicio...'
        });
        process.exit(1);
    }
}, 15000);

async function initializeService() {
    try {
        logEvent('INFO', 'Verificando credenciales con KuCoin...')

        const balance = await kucoin.fetchBalance({ params: { type: 'main' } })
        if (!balance.info?.data) throw new Error('Respuesta inválida de KuCoin')

        logEvent('INFO', 'Cargando mercados...')
        const markets = await kucoin.loadMarkets(true)

        if (Object.keys(markets).length < 50) {
            throw new Error(`Solo se cargaron ${Object.keys(markets).length} mercados`)
        }

        const leverageTokens = Object.values(markets)
            .filter(m => m.active && m.leveraged && m.quote === 'USDT')
            .map(m => m.symbol)

        logEvent('INFO', `Lista de tokens actualizada: ${leverageTokens.length} símbolos`)
        return leverageTokens

    } catch (error) {
        logEvent('ERROR', 'Fallo en inicialización', {
            error: error.stack,
            lastRequest: kucoin.lastRequest,
            lastResponse: kucoin.lastResponse
        })
        process.exit(1)
    }
}

async function monitorTokens() {
    try {
        const symbols = await initializeService() 
        if (!symbols?.length) return

        logEvent('INFO', `Iniciando análisis de ${symbols.length} tokens...`)

        const BATCH_SIZE = 3
        const BATCH_DELAY = 15000

        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
            const batch = symbols.slice(i, i + BATCH_SIZE)
            await Promise.allSettled(batch.map(symbol => analyzeAndAlert(symbol)))
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY))

            const remaining = kucoin.lastResponseHeaders?.['x-ratelimit-remaining']
            if (remaining < 10) {
                const resetTime = parseInt(kucoin.lastResponseHeaders['x-ratelimit-reset'], 10)
                const waitTime = Math.max(resetTime * 1000 - Date.now(), 0)
                logEvent('WARN', `Rate limit alcanzado. Esperando ${waitTime}ms`)
                await new Promise(resolve => setTimeout(resolve, waitTime))
            }
        }

    } catch (error) {
        logEvent('ERROR', 'Fallo catastrófico', { error: error.stack })
        process.exit(1)
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

app.get('/debug-auth', async (req, res) => {
    try {
        const response = await kucoin.fetchBalance();
        res.json({
            status: 'success',
            account: response.info.data
        });
    } catch (error) {
        res.status(500).json({
            error: 'Fallo de autenticación',
            details: error.message,
            stack: error.stack
        });
    }
});

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

app.listen(port, async () => {
    logEvent('INFO', `Servidor iniciado en puerto ${port}`)
    
    setTimeout(async () => {
        try {
            await initializeService()
            isServiceActive = true
            monitorTokens()
        } catch (error) {
            logEvent('CRITICAL', 'Fallo de inicialización no recuperable', {
                error: error.stack
            })
            process.exit(1)
        }
    }, 25000)
})
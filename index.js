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
    rateLimit: 1000, 
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
        } catch (err) {
            logs = []
        }

        logs.push({
            timestamp: new Date().toISOString(),
            ...data
        })

        await fs.writeFile(LOG_FILE, JSON.stringify(logs, null, 2))
    } catch (err) {
        console.error('Error guardando logs:', err.message)
    }
}

function logEvent(type, message, data = {}) {
    const logData = { type, message, ...data }
    console.log(`[${new Date().toISOString()}] [${type}] ${message}`)
    saveLog(logData)

    if (type === 'ERROR') {
        botStats.errors.push({
            time: new Date().toISOString(),
            message,
            ...data
        })

        if (botStats.errors.length > 20) {
            botStats.errors.shift()
        }
    }
}

async function getLeverageTokens() {
    try {
        const markets = await kucoin.loadMarkets()

        const leverageTokens = Object.keys(markets).filter(symbol => {
            return /[0-9]+[LS]\/USDT$/.test(symbol)
        })

        logEvent('INFO', `Tokens apalancados encontrados: ${leverageTokens.length}`)
        return leverageTokens
    } catch (error) {
        logEvent('ERROR', 'Error al cargar los mercados de KuCoin', { error: error.message })
        return []
    }
}

async function fetchOHLCVData(symbol, timeframe = '15m', limit = 100) {
    try {
        const ohlcv = await kucoin.fetchOHLCV(symbol, timeframe, undefined, limit)

        if (!ohlcv || ohlcv.length < 21) {
            logEvent('WARN', `No hay suficientes datos para ${symbol}`)
            return null
        }

        return ohlcv
    } catch (error) {
        logEvent('ERROR', `Error al obtener datos OHLCV para ${symbol}`, { error: error.message })
        return null
    }
}


function calculateIndicators(ohlcv) {
    if (!ohlcv || ohlcv.length < 21) return null

    const close = ohlcv.map(candle => candle[4])
    const volume = ohlcv.map(candle => candle[5])

    if (close.length < 21 || volume.length < 20) return null

    try {
        const ema9 = ti.EMA.calculate({ period: 9, values: close })
        const ema21 = ti.EMA.calculate({ period: 21, values: close })
        const rsi = ti.RSI.calculate({ period: 14, values: close })
        const volumeAvg = ti.SMA.calculate({ period: 20, values: volume })

        if (ema9.length === 0 || ema21.length === 0 || rsi.length === 0 || volumeAvg.length === 0) {
            logEvent('WARN', `Cálculo de indicadores falló para algún indicador`)
            return null
        }

        return {
            lastClose: close[close.length - 1],
            changePercent: ((close[close.length - 1] - close[close.length - 2]) / close[close.length - 2]) * 100,
            ema9: ema9[ema9.length - 1],
            ema21: ema21[ema21.length - 1],
            rsi: rsi[rsi.length - 1],
            volumeAvg: volumeAvg[volumeAvg.length - 1]
        }
    } catch (error) {
        logEvent('ERROR', 'Error al calcular indicadores', { error: error.message })
        return null
    }
}

async function sendTelegramAlert(message) {
    if (!telegramBotToken || !telegramChatId) {
        logEvent('WARN', 'Configuración de Telegram incompleta')
        return { success: false, error: 'Configuración incompleta' }
    }

    const MAX_RETRIES = 3

    for (let retry = 0; retry < MAX_RETRIES; retry++) {
        try {
            logEvent('DEBUG', `Intento ${retry + 1}/${MAX_RETRIES} de enviar alerta a Telegram`)

            const botCheckUrl = `https://api.telegram.org/bot${telegramBotToken}/getMe`
            try {
                await axios.get(botCheckUrl, { timeout: 5000 })
            } catch (checkErr) {
                logEvent('ERROR', 'El bot de Telegram parece no estar activo', {
                    error: checkErr.message,
                    response: checkErr.response ? {
                        status: checkErr.response.status,
                        data: checkErr.response.data
                    } : 'No response'
                })

                await new Promise(resolve => setTimeout(resolve, 5000))
                continue
            }

            const response = await axios.post(
                `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
                {
                    chat_id: telegramChatId,
                    text: `${message}\n\n_Bot time: ${new Date().toISOString()}_`,
                    parse_mode: 'Markdown'
                },
                { timeout: 8000 }
            )

            if (response.data && response.data.ok) {
                logEvent('INFO', 'Alerta enviada a Telegram con éxito')
                botStats.lastSuccessfulAlert = new Date()
                return { success: true }
            } else {
                logEvent('WARN', 'Telegram respondió sin confirmar éxito', {
                    response: response.data
                })
            }

        } catch (error) {
            const errorDetails = {
                retry: retry + 1,
                error: error.message,
                response: error.response ? {
                    status: error.response.status,
                    data: error.response.data
                } : 'No response data'
            }

            logEvent('ERROR', `Error al enviar mensaje a Telegram (intento ${retry + 1}/${MAX_RETRIES})`, errorDetails)

            if (error.response?.status === 429) {
                const retryAfter = error.response.headers['retry-after'] || 10
                logEvent('INFO', `Rate limit alcanzado. Esperando ${retryAfter}s antes de reintentar (Telegram)`)
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000))
            } else if (error.response?.status === 400 && error.response?.data?.description?.includes('chat not found')) {
                logEvent('ERROR', 'El chat_id de Telegram es incorrecto', { chatId: telegramChatId })
                return { success: false, error: 'Chat ID incorrecto' }
            } else {
                await new Promise(resolve => setTimeout(resolve, 5000))
            }
        }
    }

    logEvent('ERROR', `Falló el envío a Telegram después de ${MAX_RETRIES} intentos`)
    return { success: false, error: `Falló después de ${MAX_RETRIES} intentos` }
}

async function sendTestMessages() {
    logEvent('INFO', 'Enviando mensajes de prueba...')

    const message = `🧪 *TEST ALERT* 🧪\nEste es un mensaje de prueba para verificar la configuración.\nHora del servidor: ${new Date().toISOString()}`
    const telegramResult = await sendTelegramAlert(message + '\n\n_Enviado a Telegram_')

    return {
        telegram: telegramResult,
        time: new Date().toISOString()
    }
}

async function analyzeAndAlert(symbol) {
    try {
        logEvent('DEBUG', `Analizando ${symbol}...`)
        const ohlcv = await fetchOHLCVData(symbol)
        if (!ohlcv) return false

        const indicators = calculateIndicators(ohlcv)
        if (!indicators) return false

        const lastRsi = indicators.rsi

        const lastState = tokenStates.get(symbol) || {
            sobrecompra: false,
            sobrevendido: false,
            lastAlert: 0,
            lastCheck: 0,
            rsi: null
        }

        const currentState = {
            sobrecompra: lastRsi > 70,
            sobrevendido: lastRsi < 30,
            lastAlert: lastState.lastAlert,
            lastCheck: Date.now(),
            rsi: lastRsi
        }

        logEvent('INFO', `[ANÁLISIS] ${symbol} - RSI: ${lastRsi.toFixed(2)} | Estado: ${currentState.sobrecompra ? 'SOBRECOMPRA' :
                currentState.sobrevendido ? 'SOBREVENTA' : 'NEUTRO'}`)

        const tiempoDesdeUltimaAlerta = Date.now() - lastState.lastAlert
        const MIN_TIME_BETWEEN_ALERTS = 15 * 60 * 1000

        const debemosEnviarAlerta =
            (currentState.sobrecompra && !lastState.sobrecompra) ||
            (currentState.sobrevendido && !lastState.sobrevendido) ||
            ((currentState.sobrecompra || currentState.sobrevendido) &&
                tiempoDesdeUltimaAlerta > MIN_TIME_BETWEEN_ALERTS)

        if (debemosEnviarAlerta) {
            botStats.totalAlertsTriggered++
            let condition, recommendation, emoji

            if (currentState.sobrecompra) {
                condition = "SOBRECOMPRADO 🔴"
                recommendation = "Considerar **VENDER**"
                emoji = "📉"
            } else if (currentState.sobrevendido) {
                condition = "SOBREVENDIDO 🟢"
                recommendation = "Considerar **COMPRAR**"
                emoji = "📈"
            } else {
                return false
            }

            const message = `${emoji} *${symbol}* | ${condition}\n`
                + `💰 Precio: ${indicators.lastClose.toFixed(4)} USDT\n`
                + `📊 RSI: ${lastRsi.toFixed(2)}\n`
                + `📶 EMA9/21: ${indicators.ema9.toFixed(4)} | ${indicators.ema21.toFixed(4)}\n`
                + `🔄 Cambio 15m: ${indicators.changePercent.toFixed(2)}%\n`
                + `\n${recommendation}`

            try {
                logEvent('INFO', `Enviando alertas para ${symbol}...`)
                const telegramResult = await sendTelegramAlert(message)

                if (telegramSent) {
                    logEvent('INFO', `✅ Alerta enviada a Telegram para ${symbol}`)
                } else {
                    logEvent('WARN', `❌ Error al enviar alerta a Telegram para ${symbol}`, { error: telegramResult.error })
                }

                if (telegramResult.success) {
                    botStats.totalAlertsSent++
                    currentState.lastAlert = Date.now()
                    tokenStates.set(symbol, currentState)
                    return true
                } else {
                    botStats.failedAlerts++
                    tokenStates.set(symbol, {
                        ...currentState,
                        lastAlert: lastState.lastAlert 
                    })
                }
            } catch (error) {
                logEvent('ERROR', `Error general enviando alertas para ${symbol}`, { error: error.message })
                botStats.failedAlerts++
            }
        } else {
            tokenStates.set(symbol, currentState)
        }
    } catch (err) {
        logEvent('ERROR', `Error analizando ${symbol}`, { error: err.message })
    }

    return false
}

async function monitorTokens() {
    if (!isMonitoringActive) {
        logEvent('WARN', 'Se intentó ejecutar monitorTokens() pero la monitorización está desactivada')
        return
    }

    try {
        logEvent('INFO', `Iniciando ciclo de monitoreo #${botStats.cyclesCompleted + 1}...`)

        const symbols = await getLeverageTokens()

        if (!symbols || symbols.length === 0) {
            logEvent('WARN', 'No se encontraron tokens para monitorizar')
            return
        }

        let alertasSent = 0

        for (const symbol of symbols) {
            if (!isMonitoringActive) {
                logEvent('WARN', 'Monitorización detenida durante el ciclo. Abortando.')
                break
            }

            const alertaSent = await analyzeAndAlert(symbol)

            if (alertaSent) alertasSent++

            await new Promise(resolve => setTimeout(resolve, 5000))
        }

        botStats.cyclesCompleted++
        logEvent('INFO', `Ciclo #${botStats.cyclesCompleted} completado. ${alertasSent} alertas enviadas. Próximo ciclo en 5 minutos...`)
    } catch (error) {
        logEvent('ERROR', 'Error en el ciclo de monitorización', { error: error.message })
    } finally {
        if (isMonitoringActive) {
            setTimeout(monitorTokens, 5 * 60 * 1000)
        } else {
            logEvent('WARN', 'No se programó el siguiente ciclo porque la monitorización está desactivada')
        }
    }
}

async function testKucoinAPI() {
    try {
        const startTime = Date.now()
        const res = await axios.get('https://api.kucoin.com/api/v3/currencies', { timeout: 10000 })
        const endTime = Date.now()
        const responseTime = endTime - startTime

        logEvent('INFO', `Conexión exitosa con KuCoin: ${res.data.data.length} monedas disponibles (${responseTime}ms)`)
        return true
    } catch (error) {
        logEvent('ERROR', 'Error al conectar con KuCoin', { error: error.message })
        return false
    }
}

app.use(express.json())

app.get('/', (req, res) => {
    const status = isMonitoringActive ? 'activo' : 'inactivo'
    res.send(`Bot de análisis de criptomonedas: ${status} (${new Date().toISOString()})`)
})

app.get('/status', (req, res) => {
    const status = {
        isMonitoring: isMonitoringActive,
        tokenCount: tokenStates.size,
        startTime: botStats.startTime,
        uptime: Math.floor((Date.now() - botStats.startTime) / (1000 * 60)),
        cyclesCompleted: botStats.cyclesCompleted,
        totalAlertsTriggered: botStats.totalAlertsTriggered,
        totalAlertsSent: botStats.totalAlertsSent,
        failedAlerts: botStats.failedAlerts,
        lastSuccessfulAlert: botStats.lastSuccessfulAlert,
        tokens: [...tokenStates].map(([symbol, state]) => ({
            symbol,
            rsi: state.rsi,
            sobrecompra: state.sobrecompra,
            sobrevendido: state.sobrevendido,
            lastAlertTime: state.lastAlert ? new Date(state.lastAlert).toISOString() : null
        })).slice(0, 20),
        recentErrors: botStats.errors.slice(-5)
    }
    res.json(status)
})

app.get('/logs', async (req, res) => {
    try {
        const data = await fs.readFile(LOG_FILE, 'utf8')
        const logs = JSON.parse(data)
        res.json(logs)
    } catch (err) {
        res.status(500).json({ error: 'Error leyendo logs', details: err.message })
    }
})

app.post('/test-alerts', async (req, res) => {
    try {
        const results = await sendTestMessages()
        res.json(results)
    } catch (err) {
        res.status(500).json({ error: 'Error enviando mensajes de prueba', details: err.message })
    }
})

app.post('/restart', (req, res) => {
    try {
        isMonitoringActive = true
        logEvent('INFO', 'Deteniendo monitorización para reinicio...')

        tokenStates.clear()

        botStats.cyclesCompleted = 0
        botStats.totalAlertsTriggered = 0
        botStats.totalAlertsSent = 0
        botStats.failedAlerts = 0
        botStats.lastSuccessfulAlert = null
        botStats.errors = []
        botStats.startTime = new Date()

        setTimeout(() => {
            logEvent('INFO', 'Reiniciando monitorización...')
            isMonitoringActive = true
            monitorTokens()
            sendTestMessages()
        }, 5000)

        res.json({ success: true, message: 'Bot reiniciando, la monitorización se reactivará en 5 segundos' })

    } catch (err) {
        res.status(500).json({ error: 'Error reiniciando el bot', details: err.message })
    }
})

app.listen(port, async () => {
    console.log(`Servidor corriendo en puerto ${port}`)
    const apiWorks = await testKucoinAPI()

    if (apiWorks && !isMonitoringActive) {
        isMonitoringActive = true
        logEvent('INFO', 'Iniciando monitorización de tokens...')

        try {
            await sendTestMessages()
        } catch (error) {
            logEvent('ERROR', 'Error enviando mensajes de prueba al inicio', { error: error.message })
        }

        monitorTokens()
    } else if (!apiWorks) {
        logEvent('ERROR', 'No se pudo iniciar la monitorización debido a problemas con la API de KuCoin')
    }
})

process.on('SIGTERM', () => {
    logEvent('INFO', 'Señal SIGTERM recibida, deteniendo monitorización')
    isMonitoringActive = false
    setTimeout(() => {
        process.exit(0)
    }, 5000)
})

process.on('SIGINT', () => {
    logEvent('INFO', 'Señal SIGINT recibida, deteniendo monitorización')
    isMonitoringActive = false
    setTimeout(() => {
        process.exit(0)
    }, 5000)
})
require('dotenv').config()
require('global-agent/bootstrap')

const express = require('express')
const axios = require('axios')
const ccxt = require('ccxt')
const ti = require('technicalindicators')

const app = express()
const port = process.env.PORT || 3000

const discordWebHook = process.env.DISCORD_WEBHOOK_URL
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
const telegramChatId = process.env.TELEGRAM_CHAT_ID

const kucoin = new ccxt.kucoin({
    enableRateLimit: true,
    rateLimit: 1000,
})

const tokenStates = new Map()

let isMonitoringActive = false

async function getLeverageTokens() {
    try {
        const markets = await kucoin.loadMarkets()
        const leverageTokens = Object.keys(markets).filter(symbol => {
            return /[0-9]+[LS]\/USDT$/.test(symbol)
        })

        console.log(`Tokens apalancados encontrados: ${leverageTokens.length}`)
        return leverageTokens
    } catch (error) {
        console.error('Error al cargar los mercados de KuCoin:', error.message)
        return []
    }
}

async function fetchOHLCVData(symbol, timeframe = '15m', limit = 100) {
    try {
        const ohlcv = await kucoin.fetchOHLCV(symbol, timeframe, undefined, limit)

        if (!ohlcv || ohlcv.length < 21) {
            console.log(`No hay suficientes datos para ${symbol}`)
            return null
        }

        return ohlcv
    } catch (error) {
        console.error(`Error al obtener datos OHLCV para ${symbol}:`, error.message)
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
            console.log(`Cálculo de indicadores falló para algún indicador`)
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
        console.error('Error al calcular indicadores:', error.message)
        return null
    }
}

async function sendDiscordAlert(message) {
    if (!discordWebHook) {
        console.log('URL de webhook de Discord no configurada')
        return
    }

    try {
        const response = await axios.post(discordWebHook, { content: message }, { timeout: 5000 })
        console.log('Alerta enviada a Discord con éxito')
        return response
    } catch (error) {
        console.error('Error al enviar mensaje a Discord:', error.message)
        throw error
    }
}

async function sendTelegramAlert(message) {
    if (!telegramBotToken || !telegramChatId) {
        console.log('Configuración de Telegram incompleta')
        return
    }

    const MAX_RETRIES = 3
    let retries = 0

    while (retries < MAX_RETRIES) {
        try {
            const response = await axios.post(
                `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
                {
                    chat_id: telegramChatId,
                    text: message,
                    parse_mode: 'Markdown'
                },
                { timeout: 5000 }
            )

            console.log('Alerta enviada a Telegram con éxito')
            await new Promise(resolve => setTimeout(resolve, 3000))
            return response.data

        } catch (error) {
            retries++

            if (error.response?.status === 429) {
                const retryAfter = error.response.headers['retry-after'] || 10
                console.log(`Rate limit alcanzado. Reintento ${retries}/${MAX_RETRIES} en ${retryAfter}s`)
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000))
            } else {
                console.error(`Error en Telegram (${error.message}). Intento ${retries}/${MAX_RETRIES}`)
                await new Promise(resolve => setTimeout(resolve, 5000))
            }
        }
    }

    throw new Error(`Falló el envío a Telegram después de ${MAX_RETRIES} intentos`)
}

async function analyzeAndAlert(symbol) {
    try {
        console.log(`Analizando ${symbol}...`)
        const ohlcv = await fetchOHLCVData(symbol)

        if (!ohlcv) return false

        const indicators = calculateIndicators(ohlcv)

        if (!indicators) return false

        const lastRsi = indicators.rsi
        const lastState = tokenStates.get(symbol) || { sobrecompra: false, sobrevendido: false, lastAlert: 0 }
        const currentState = {
            sobrecompra: lastRsi > 70,
            sobrevendido: lastRsi < 30,
            lastAlert: lastState.lastAlert
        }

        console.log(`[ANÁLISIS] ${symbol} - RSI: ${lastRsi.toFixed(2)} | Estado: ${currentState.sobrecompra ? 'SOBRECOMPRA' :
                currentState.sobrevendido ? 'SOBREVENTA' : 'NEUTRO'}`)

        const tiempoDesdeUltimaAlerta = Date.now() - lastState.lastAlert
        const debemosEnviarAlerta =
            (currentState.sobrecompra && !lastState.sobrecompra) ||
            (currentState.sobrevendido && !lastState.sobrevendido) ||
            ((currentState.sobrecompra === lastState.sobrecompra ||
                currentState.sobrevendido === lastState.sobrevendido) &&
                tiempoDesdeUltimaAlerta > 15 * 60 * 1000)

        if (debemosEnviarAlerta) {
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
                console.log(`Enviando alertas para ${symbol}...`)
                const results = await Promise.allSettled([
                    sendDiscordAlert(message),
                    sendTelegramAlert(message)
                ])

                results.forEach((result, index) => {
                    const platform = index === 0 ? 'Discord' : 'Telegram'
                    if (result.status === 'fulfilled') {
                        console.log(`✅ Alerta enviada a ${platform} para ${symbol}`)
                    } else {
                        console.error(`❌ Error al enviar alerta a ${platform} para ${symbol}: ${result.reason}`)
                    }
                })

                if (results.some(r => r.status === 'fulfilled')) {
                    currentState.lastAlert = Date.now()
                    tokenStates.set(symbol, currentState)
                    return true
                }
            } catch (error) {
                console.error(`Error general enviando alertas para ${symbol}:`, error.message)
            }
        } else {
            tokenStates.set(symbol, currentState)
        }
    } catch (err) {
        console.error(`Error analizando ${symbol}:`, err.message)
    }

    return false
}

async function monitorTokens() {
    if (!isMonitoringActive) return

    try {
        console.log(`[${new Date().toISOString()}] Iniciando ciclo de monitoreo...`)
        const symbols = await getLeverageTokens()

        if (!symbols || symbols.length === 0) {
            console.log('No se encontraron tokens para monitorizar')
            return
        }

        let alertasSent = 0

        for (const symbol of symbols) {
            const alertaSent = await analyzeAndAlert(symbol)
            if (alertaSent) alertasSent++

            await new Promise(resolve => setTimeout(resolve, 5000))
        }

        console.log(`[${new Date().toISOString()}] Ciclo completado. ${alertasSent} alertas enviadas. Próximo ciclo en 5 minutos...`)
    } catch (error) {
        console.error('Error en el ciclo de monitorización:', error)
    } finally {
        if (isMonitoringActive) {
            setTimeout(monitorTokens, 5 * 60 * 1000)
        }
    }
}

async function testKucoinAPI() {
    try {
        const res = await axios.get('https://api.kucoin.com/api/v3/currencies')
        console.log(`Conexión exitosa con KuCoin: ${res.data.data.length} monedas disponibles`)
        return true
    } catch (error) {
        console.error('Error al conectar con KuCoin:', error.message)
        return false
    }
}

app.get('/', (req, res) => {
    const status = isMonitoringActive ? 'activo' : 'inactivo'
    res.send(`Bot de análisis de criptomonedas: ${status} (${new Date().toISOString()})`)
})

app.get('/status', (req, res) => {
    const status = {
        isMonitoring: isMonitoringActive,
        tokenCount: tokenStates.size,
        startTime: new Date().toISOString()
    }
    res.json(status)
})

app.listen(port, async () => {
    console.log(`Servidor corriendo en puerto ${port}`)

    const apiWorks = await testKucoinAPI()

    if (apiWorks && !isMonitoringActive) {
        isMonitoringActive = true
        console.log('Iniciando monitorización de tokens...')
        monitorTokens()
    } else if (!apiWorks) {
        console.error('No se pudo iniciar la monitorización debido a problemas con la API de KuCoin')
    }
})

process.on('SIGTERM', () => {
    console.log('Señal SIGTERM recibida, deteniendo monitorización')
    isMonitoringActive = false
    setTimeout(() => {
        process.exit(0)
    }, 5000)
})

process.on('SIGINT', () => {
    console.log('Señal SIGINT recibida, deteniendo monitorización')
    isMonitoringActive = false
    setTimeout(() => {
        process.exit(0)
    }, 5000)
})
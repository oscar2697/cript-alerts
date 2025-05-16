require('dotenv').config()
require('global-agent/bootstrap')

const express = require('express')
const axios = require('axios')
const ccxt = require('ccxt')

const { EMA, RSI } = require('technicalindicators')

const app = express()
const port = process.env.PORT || 3000;

const discordWebHook = process.env.DISCORD_WEBHOOK_URL
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
const telegramChatId = process.env.TELEGRAM_CHAT_ID

const kucoin = new ccxt.kucoin({
    enableRateLimit: true,
})

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

async function fetchData(symbol, timeframe = '15m', limit = 100) {
    try {
        const ohlcv = await kucoin.fetchOHLCV(symbol, timeframe, limit)

        return ohlcv.map(([timestamp, open, high, lowest, close, volume]) => ({
            timestamp: new Date(timestamp),
            open,
            high,
            lowest,
            close,
            volume
        }))
    } catch (error) {
        console.log('Error al obtener los datos', error.message)
        return []
    }
}

const ti = require('technicalindicators')

function calculateIndicators(ohlcv) {
    const close = ohlcv.map(row => row[4])
    const volume = ohlcv.map(row => row[5])

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
}

async function sendDiscordAlert(message) {
    try {
        await axios.post(discordWebHook, { content: message })
    } catch (error) {
        console.error('Error al enviar mensaje a Discord:', error.message)
    }
}

async function sendTelegramAlert(message) {
    try {
        await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            chat_id: telegramChatId,
            text: message,
            parse_mode: 'Markdown'
        })
        await new Promise(resolve => setTimeout(resolve, 1000))
    } catch (error) {
        console.error('Error al enviar mensaje a Telegram:', error.message)

        if (error.response?.status === 429) {
            const retryAfter = error.response.headers['rety-after'] || 10
            console.log(`Rate limit alcanzado. Reintentando en ${retryAfter} segundos...`)

            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000))
            return sendTelegramAlert(message)
        }
    }
}

async function analyzeAndAlert(exchange, symbol) {
    try {
        const formattedSymbol = symbol.replace('/', '-')
        const ohlcv = await exchange.fetchOHLCV(formattedSymbol, '15m', undefined, 100)
        
        if (!ohlcv || ohlcv.length < 21) return

        const indicators = calculateIndicators(ohlcv)
        const lastRsi = indicators.rsi

        if (lastRsi > 70 || lastRsi < 30) {
            let condition, recommendation, emoji
            
            if (lastRsi > 70) {
                condition = "SOBRECOMPRADO 🔴"
                recommendation = "Considerar **VENDER**"
                emoji = "📉"
            } else {
                condition = "SOBREVENDIDO 🟢"
                recommendation = "Considerar **COMPRAR**"
                emoji = "📈"
            }

            const message = `${emoji} *${symbol}* | ${condition}\n`
                + `💰 Precio: ${indicators.lastClose.toFixed(4)} USDT\n`
                + `📊 RSI: ${lastRsi.toFixed(2)}\n`
                + `📶 EMA9/21: ${indicators.ema9.toFixed(4)} | ${indicators.ema21.toFixed(4)}\n`
                + `🔄 Cambio 15m: ${indicators.changePercent.toFixed(2)}%\n`
                + `\n${recommendation}`

            await Promise.allSettled([
                sendDiscordAlert(message),
                sendTelegramAlert(message)
            ])
        }
    } catch (err) {
        console.error(`Error analizando ${symbol}:`, err.message)
    }
}

async function monitorTokens() {
    const symbols = await getLeverageTokens()
    if (!symbols.length) return

    console.log(`Monitoreando ${symbols.length} tokens apalancados...`)

    while (true) {
        const analysisPromises = symbols.map(async (symbol) => {
            await analyzeAndAlert(kucoin, symbol);
            await new Promise(resolve => setTimeout(resolve, 1500))
        })

        await Promise.allSettled(analysisPromises)
        await new Promise(resolve => setTimeout(resolve, 300000))
    }
}

async function testKucoinAPI() {
    try {
        const res = await axios.get('https://api.kucoin.com/api/v3/currencies')
        console.log('Respuesta exitosa de KuCoin:', res.data.data.length)
    } catch (error) {
        console.error('Error directo al llamar a KuCoin:', error.message)
    }
}

testKucoinAPI()

app.get('/', (req, res) => {
    res.send('Bot de análisis de criptomonedas en ejecución...')
})

let isMonitoring = false

app.listen(port, () => {
    console.log(`Servidor corriendo en ${port}`)
    if (!isMonitoring) {
        isMonitoring = true
        monitorTokens().catch(err => {
            console.error('Error en el monitoreo:', err)
            isMonitoring = false
        })
    }
})
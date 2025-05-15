require('dotenv').config()
require('global-agent/bootstrap')

const express = require('express')
const axios = require('axios')
const ccxt = require('ccxt')

const { EMA, RSI } = require('technicalindicators')

const app = express()
const port = 3000

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
    const close = ohlcv.map(row => row[4]) // índice 4 es 'close'
    const volume = ohlcv.map(row => row[5]) // índice 5 es 'volume'

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
    } catch (error) {
        console.error('Error al enviar mensaje a Telegram:', error.message)
    }
}

async function analyzeAndAlert(exchange, symbol) {
    try {
        const formattedSymbol = symbol.replace('/', '-')
        const ohlcv = await exchange.fetchOHLCV(formattedSymbol, '15m', undefined, 100)

        if (!ohlcv || ohlcv.length < 21) {
            console.log(`Datos insuficientes para ${symbol}`)
            return
        }

        const indicators = calculateIndicators(ohlcv)

        if (indicators.rsi > 70 || calculateIndicators(ohlcv)) {
            let message = `📊 *Análisis del token ${symbol}*\n`
            message += `Precio actual: ${indicators.lastClose.toFixed(4)} USDT\n`
            message += `Cambio reciente: ${indicators.changePercent.toFixed(2)}%\n`
            message += `RSI: ${indicators.rsi.toFixed(2)}\n`
            message += `EMA9: ${indicators.ema9.toFixed(4)}, EMA21: ${indicators.ema21.toFixed(4)}\n`

            if (indicators.rsi > 70) {
                message += `⚠️ *Sobrecomprado (RSI > 70)*. Considera vender.`
            } else if (indicators.rsi < 30) {
                message += `📈 *Sobrevendido (RSI < 30)*. Considera comprar.`
            }

            await sendDiscordAlert(message)
            await sendTelegramAlert(message)
        } else {
            console.log(`No se envía alerta para ${symbol}, RSI neutro (${indicators.rsi.toFixed(2)})`)
        }
    } catch (err) {
        console.error(`Error analizando ${symbol}:`, err.message)
    }
}

async function monitorTokens() {
    const symbols = await getLeverageTokens()

    if (!symbols.length) {
        console.log('No se encontraron tokens apalancados.')
        return
    }

    console.log(`Monitoreando ${symbols.length} tokens apalancados...`)

    while (true) {
        for (const symbol of symbols) {
            await analyzeAndAlert(kucoin, symbol)
            await new Promise(resolve => setTimeout(resolve, 1000)) // Esperar 1 segundo entre tokens
        }

        await new Promise(resolve => setTimeout(resolve, 300000)) // Esperar 5 min
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

app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`)
    monitorTokens()
})
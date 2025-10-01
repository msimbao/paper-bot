const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// In-memory storage for logs and bot instance
let botInstance = null;
let logs = [];
let isRunning = false;

// Log storage with size limit
const MAX_LOGS = 1000;
function addLog(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message };
    logs.push(logEntry);
    if (logs.length > MAX_LOGS) {
        logs.shift();
    }
    console.log(`[${timestamp}] [${level}] ${message}`);
}

// CryptoScalpingTester class (modified for web service)
class CryptoScalpingTester {
    constructor(config = {}) {
        this.config = {
            symbol: config.symbol || 'AVAXUSDT',
            timeframe: config.timeframe || '5m',
            initialBalance: config.initialBalance || 1000,
            emaPeriod: config.emaPeriod || 100,
            rsiPeriod: config.rsiPeriod || 14,
            rsiEntry: config.rsiEntry || 45,
            tp1Pct: config.tp1Pct || 1.2,
            tp2Pct: config.tp2Pct || 2.0,
            slPct: config.slPct || -1.2,
            feePct: config.feePct || 0.00075,
            slippagePct: config.slippagePct || 0.0005,
            rsiExit1: config.rsiExit1 || 100,
            rsiExit2: config.rsiExit2 || 85,
            enableTrailingStop: config.enableTrailingStop || false,
            trailingStopTriggerPct: config.trailingStopTriggerPct || 0.8,
            trailingStopDistancePct: config.trailingStopDistancePct || 0.4,
            trailingStopMode: config.trailingStopMode || 'both',
            realTrading: config.realTrading || false,
            apiKey: config.apiKey || '',
            apiSecret: config.apiSecret || '',
            maxReconnectAttempts: config.maxReconnectAttempts || -1,
            reconnectDelay: config.reconnectDelay || 5000,
            heartbeatInterval: config.heartbeatInterval || 30000,
            dataTimeoutMs: config.dataTimeoutMs || 185000
        };
        
        this.balance = this.config.initialBalance;
        this.holdings = 0;
        this.entryPrice = 0;
        this.entryTime = null;
        this.wins = 0;
        this.losses = 0;
        this.priceData = [];
        this.ws = null;
        
        this.highestPriceSinceEntry = 0;
        this.trailingStopPrice = 0;
        this.trailingStopActive = false;
        
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.isConnected = false;
        this.lastDataTime = null;
        this.heartbeatTimer = null;
        this.shouldReconnect = true;
        this.forceExit = false;
    }

    log(message, level = 'INFO') {
        addLog(message, level);
    }

    calculateEMA(data, period) {
        if (data.length < period) return data.map(() => null);
        const ema = [];
        const multiplier = 2 / (period + 1);
        ema[0] = data[0];
        for (let i = 1; i < data.length; i++) {
            ema[i] = (data[i] * multiplier) + (ema[i - 1] * (1 - multiplier));
        }
        return ema;
    }

    calculateRSI(data, period = 14) {
        if (data.length < period + 1) return data.map(() => null);
        const rsi = [];
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const change = data[i] - data[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        for (let i = 0; i < period; i++) rsi[i] = null;
        rsi[period] = 100 - (100 / (1 + (avgGain / avgLoss)));
        for (let i = period + 1; i < data.length; i++) {
            const change = data[i] - data[i - 1];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;
            avgGain = ((avgGain * (period - 1)) + gain) / period;
            avgLoss = ((avgLoss * (period - 1)) + loss) / period;
            rsi[i] = 100 - (100 / (1 + (avgGain / avgLoss)));
        }
        return rsi;
    }

    updateTrailingStop(currentPrice) {
        if (!this.config.enableTrailingStop || this.holdings === 0) return;
        const currentProfitPct = ((currentPrice - this.entryPrice) / this.entryPrice) * 100;
        if (!this.trailingStopActive && currentProfitPct >= this.config.trailingStopTriggerPct) {
            this.trailingStopActive = true;
            this.highestPriceSinceEntry = currentPrice;
            this.trailingStopPrice = currentPrice * (1 - this.config.trailingStopDistancePct / 100);
            this.log(`🎯 Trailing stop ACTIVATED at ${currentPrice.toFixed(4)}`, 'INFO');
        }
        if (this.trailingStopActive && currentPrice > this.highestPriceSinceEntry) {
            this.highestPriceSinceEntry = currentPrice;
            const newTrailingStopPrice = currentPrice * (1 - this.config.trailingStopDistancePct / 100);
            if (newTrailingStopPrice > this.trailingStopPrice) {
                this.trailingStopPrice = newTrailingStopPrice;
                this.log(`📈 Trailing stop UPDATED to ${this.trailingStopPrice.toFixed(4)}`, 'INFO');
            }
        }
    }

    isTrailingStopTriggered(currentPrice) {
        return this.trailingStopActive && currentPrice <= this.trailingStopPrice;
    }

    resetTrailingStop() {
        this.trailingStopActive = false;
        this.highestPriceSinceEntry = 0;
        this.trailingStopPrice = 0;
    }

    async fetchKlinesBatch(symbol, interval, startTime, endTime, limit = 1000) {
        let url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        if (startTime) url += `&startTime=${startTime}`;
        if (endTime) url += `&endTime=${endTime}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    }

    async getRecentHistoricalData() {
        this.log('📥 Fetching recent historical data...', 'INFO');
        const requiredCandles = Math.max(this.config.emaPeriod, this.config.rsiPeriod) + 50;
        try {
            const symbol = this.config.symbol.toUpperCase();
            const data = await this.fetchKlinesBatch(symbol, this.config.timeframe, null, null, requiredCandles);
            this.priceData = data.map(k => parseFloat(k[4]));
            this.log(`✅ Loaded ${this.priceData.length} candles`, 'INFO');
            return true;
        } catch (error) {
            this.log(`❌ Error: ${error.message}`, 'ERROR');
            return false;
        }
    }

    async processSignal(price, ema, rsi) {
        if (isNaN(price) || isNaN(ema) || isNaN(rsi)) return;

        // BUY signal
        if (this.holdings === 0 && price > ema && rsi <= this.config.rsiEntry) {
            const amount = this.balance / price;
            this.holdings = amount;
            this.entryPrice = price * (1 + this.config.slippagePct);
            this.entryTime = new Date();
            this.balance = 0;
            this.resetTrailingStop();
            this.log(`🟢 BUY: ${amount.toFixed(6)} at ${price.toFixed(4)} | RSI: ${rsi.toFixed(2)}`, 'TRADE');
            return;
        }

        // SELL logic
        if (this.holdings > 0) {
            this.updateTrailingStop(price);
            const changePct = ((price - this.entryPrice) / this.entryPrice) * 100;
            let shouldSell = this.forceExit;
            let reason = this.forceExit ? 'Manual Exit' : '';

            if (!shouldSell) {
                if (this.isTrailingStopTriggered(price)) {
                    shouldSell = true;
                    reason = 'Trailing Stop';
                } else if (changePct >= this.config.tp2Pct || rsi >= this.config.rsiExit2) {
                    shouldSell = true;
                    reason = changePct >= this.config.tp2Pct ? 'TP2' : 'RSI Exit 2';
                } else if (changePct >= this.config.tp1Pct || rsi >= this.config.rsiExit1) {
                    shouldSell = true;
                    reason = changePct >= this.config.tp1Pct ? 'TP1' : 'RSI Exit 1';
                } else if (changePct <= this.config.slPct) {
                    shouldSell = true;
                    reason = 'Stop Loss';
                }
            }

            if (shouldSell) {
                const sellPrice = price * (1 - this.config.feePct);
                this.balance = this.holdings * sellPrice;
                this.holdings = 0;
                if (changePct > 0) this.wins++;
                else this.losses++;
                this.log(`🔴 SELL: ${reason} at ${price.toFixed(4)} | P&L: ${changePct.toFixed(2)}% | Balance: ${this.balance.toFixed(2)}`, 'TRADE');
                this.entryTime = null;
                this.resetTrailingStop();
                this.forceExit = false;
            }
        }
    }

    setupHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            if (this.isConnected && this.lastDataTime) {
                const timeSinceLastData = Date.now() - this.lastDataTime;
                if (timeSinceLastData > this.config.dataTimeoutMs) {
                    this.log(`⚠️ No data for ${Math.round(timeSinceLastData / 1000)}s. Reconnecting...`, 'WARNING');
                    this.reconnectWebSocket();
                }
            }
        }, this.config.heartbeatInterval);
    }

    async connectWebSocket() {
        if (this.isConnecting) return;
        this.isConnecting = true;
        const symbol = this.config.symbol.toLowerCase();
        const wsUrl = `wss://stream.binance.us:9443/ws/${symbol}@kline_${this.config.timeframe}`;
        this.log(`🔌 Connecting to ${wsUrl}`, 'INFO');
        this.ws = new WebSocket(wsUrl);
        
        this.ws.on('open', () => {
            this.log('📡 WebSocket connected', 'SUCCESS');
            this.isConnected = true;
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            this.lastDataTime = Date.now();
            this.setupHeartbeat();
        });

        this.ws.on('message', (data) => {
            try {
                this.lastDataTime = Date.now();
                const message = JSON.parse(data);
                const kline = message.k;
                if (kline.x) this.processKlineData(kline);
            } catch (error) {
                this.log(`Error: ${error.message}`, 'ERROR');
            }
        });

        this.ws.on('error', (error) => {
            this.log(`WebSocket error: ${error.message}`, 'ERROR');
            this.isConnected = false;
            this.isConnecting = false;
        });

        this.ws.on('close', () => {
            this.log('WebSocket closed', 'WARNING');
            this.isConnected = false;
            this.isConnecting = false;
            if (this.shouldReconnect) this.scheduleReconnect();
        });
    }

    async processKlineData(kline) {
        const price = parseFloat(kline.c);
        this.priceData.push(price);
        const maxLength = Math.max(this.config.emaPeriod, this.config.rsiPeriod) + 50;
        if (this.priceData.length > maxLength) {
            this.priceData = this.priceData.slice(-maxLength);
        }
        const emas = this.calculateEMA(this.priceData, this.config.emaPeriod);
        const rsis = this.calculateRSI(this.priceData, this.config.rsiPeriod);
        const currentEMA = emas[emas.length - 1];
        const currentRSI = rsis[rsis.length - 1];
        if (currentEMA && currentRSI) {
            this.log(`📊 Price: ${price.toFixed(4)} | RSI: ${currentRSI.toFixed(2)} | Holdings: ${this.holdings.toFixed(6)}`, 'DATA');
            await this.processSignal(price, currentEMA, currentRSI);
        }
    }

    scheduleReconnect() {
        if (!this.shouldReconnect) return;
        this.reconnectAttempts++;
        const delay = Math.min(this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 60000);
        this.log(`🔄 Reconnecting in ${delay}ms`, 'INFO');
        setTimeout(() => {
            if (this.shouldReconnect && !this.isConnected) {
                this.reconnectWebSocket();
            }
        }, delay);
    }

    async reconnectWebSocket() {
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.terminate();
        }
        this.isConnected = false;
        this.isConnecting = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        await this.connectWebSocket();
    }

    async start() {
        const dataLoaded = await this.getRecentHistoricalData();
        if (!dataLoaded) {
            this.log('❌ Failed to load data', 'ERROR');
            return false;
        }
        await this.connectWebSocket();
        return true;
    }

    stop() {
        this.shouldReconnect = false;
        if (this.ws) this.ws.close();
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.log('🛑 Bot stopped', 'INFO');
    }

    getStatus() {
        return {
            isRunning: this.isConnected,
            balance: this.balance,
            holdings: this.holdings,
            entryPrice: this.entryPrice,
            wins: this.wins,
            losses: this.losses,
            currentPrice: this.priceData[this.priceData.length - 1] || 0,
            trailingStopActive: this.trailingStopActive,
            trailingStopPrice: this.trailingStopPrice
        };
    }
}

// API Routes
app.post('/api/start', async (req, res) => {
    if (isRunning) {
        return res.status(400).json({ error: 'Bot already running' });
    }
    try {
        const config = req.body;
        botInstance = new CryptoScalpingTester(config);
        const started = await botInstance.start();
        if (started) {
            isRunning = true;
            res.json({ success: true, message: 'Bot started' });
        } else {
            res.status(500).json({ error: 'Failed to start bot' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/stop', (req, res) => {
    if (!isRunning || !botInstance) {
        return res.status(400).json({ error: 'Bot not running' });
    }
    botInstance.stop();
    isRunning = false;
    res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/force-exit', (req, res) => {
    if (!isRunning || !botInstance) {
        return res.status(400).json({ error: 'Bot not running' });
    }
    if (botInstance.holdings === 0) {
        return res.status(400).json({ error: 'No active position' });
    }
    botInstance.forceExit = true;
    addLog('🚨 Manual exit triggered', 'WARNING');
    res.json({ success: true, message: 'Force exit triggered' });
});

app.get('/api/status', (req, res) => {
    if (!botInstance) {
        return res.json({ isRunning: false });
    }
    res.json(botInstance.getStatus());
});

app.get('/api/logs', (req, res) => {
    res.json(logs);
});

app.get('/api/config', (req, res) => {
    if (!botInstance) {
        return res.json({});
    }
    res.json(botInstance.config);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    addLog(`Server started on port ${PORT}`, 'INFO');
});
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

class CryptoScalpingTester {
    constructor(config = {}) {
        this.config = {
            symbol: config.symbol || 'AVAXUSDT',
            timeframe: config.timeframe || '5m',
            startDate: config.startDate || '2025-09-01',
            endDate: config.endDate || '2025-09-19',
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
            backtest: config.backtest || false
        };
        
        this.balance = this.config.initialBalance;
        this.holdings = 0;
        this.entryPrice = 0;
        this.wins = 0;
        this.losses = 0;
        this.priceData = [];
        this.ws = null;
    }

    // Calculate EMA
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

    // Calculate RSI
    calculateRSI(data, period = 14) {
        if (data.length < period + 1) return data.map(() => null);
        
        const rsi = [];
        let gains = 0;
        let losses = 0;

        // Initial average gain and loss
        for (let i = 1; i <= period; i++) {
            const change = data[i] - data[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;
        
        for (let i = 0; i < period; i++) {
            rsi[i] = null;
        }

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

    // Get historical data from Binance REST API
    async getHistoricalData() {
        const symbol = this.config.symbol.toLowerCase();
        const interval = this.config.timeframe;
        const startTime = new Date(this.config.startDate).getTime();
        const endTime = new Date(this.config.endDate).getTime();
        
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
        
        try {
            const response = await fetch(url);
            const data = await response.json();
            
            return data.map(kline => ({
                time: new Date(kline[0]),
                open: parseFloat(kline[1]),
                high: parseFloat(kline[2]),
                low: parseFloat(kline[3]),
                close: parseFloat(kline[4]),
                volume: parseFloat(kline[5])
            }));
        } catch (error) {
            console.error('Error fetching historical data:', error);
            return [];
        }
    }

    // Process trade signal
    processSignal(price, ema, rsi) {
        if (isNaN(price) || isNaN(ema) || isNaN(rsi)) return;

        // BUY signal
        if (this.holdings === 0 && price > ema && rsi <= this.config.rsiEntry) {
            const amount = this.balance / price;
            this.holdings = amount;
            this.entryPrice = price * (1 + this.config.slippagePct);
            this.balance = 0;
            
            console.log(`🟢 BUY: ${amount.toFixed(6)} ${this.config.symbol} at $${price.toFixed(4)} | RSI: ${rsi.toFixed(2)} | EMA: ${ema.toFixed(4)}`);
            return;
        }

        // SELL signals
        if (this.holdings > 0) {
            const changePct = ((price - this.entryPrice) / this.entryPrice) * 100;
            let shouldSell = false;
            let reason = '';

            if (changePct >= this.config.tp2Pct || rsi >= this.config.rsiExit2) {
                shouldSell = true;
                reason = changePct >= this.config.tp2Pct ? 'TP2' : 'RSI Exit 2';
            } else if (changePct >= this.config.tp1Pct || rsi >= this.config.rsiExit1) {
                shouldSell = true;
                reason = changePct >= this.config.tp1Pct ? 'TP1' : 'RSI Exit 1';
            } else if (changePct <= this.config.slPct) {
                shouldSell = true;
                reason = 'Stop Loss';
            }

            if (shouldSell) {
                this.balance = this.holdings * price * (1 - this.config.feePct);
                this.holdings = 0;
                
                if (changePct > 0) {
                    this.wins++;
                } else {
                    this.losses++;
                }

                console.log(`🔴 SELL: ${reason} at $${price.toFixed(4)} | P&L: ${changePct.toFixed(2)}% | Balance: $${this.balance.toFixed(2)}`);
            }
        }
    }

    // Run backtest
    async runBacktest() {
        console.log('📊 Starting backtest...');
        const data = await this.getHistoricalData();
        
        if (data.length === 0) {
            console.error('No historical data available');
            return;
        }

        console.log(`📈 Loaded ${data.length} candles for ${this.config.symbol}`);
        
        const prices = data.map(d => d.close);
        const emas = this.calculateEMA(prices, this.config.emaPeriod);
        const rsis = this.calculateRSI(prices, this.config.rsiPeriod);

        // Process each candle
        for (let i = 0; i < data.length; i++) {
            if (emas[i] && rsis[i]) {
                this.processSignal(prices[i], emas[i], rsis[i]);
            }
        }

        // Final balance calculation
        const finalPrice = prices[prices.length - 1];
        const finalBalance = this.balance + (this.holdings * finalPrice);
        const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;

        console.log('\n📋 BACKTEST RESULTS:');
        console.log(`Initial Balance: $${this.config.initialBalance}`);
        console.log(`Final Balance: $${finalBalance.toFixed(2)}`);
        console.log(`ROI: ${roi.toFixed(2)}%`);
        console.log(`Wins: ${this.wins}`);
        console.log(`Losses: ${this.losses}`);
        console.log(`Win Rate: ${this.wins + this.losses > 0 ? ((this.wins / (this.wins + this.losses)) * 100).toFixed(1) : 0}%`);
    }

    // Start forward testing with WebSocket
    startForwardTest() {
        console.log('🚀 Starting forward test with live data...');
        
        const symbol = this.config.symbol.toLowerCase();
        const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@kline_${this.config.timeframe}`;
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.on('open', () => {
            console.log(`📡 Connected to Binance WebSocket for ${this.config.symbol}`);
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data);
            const kline = message.k;
            
            if (kline.x) { // Only process completed candles
                const price = parseFloat(kline.c);
                
                // Add to price data
                this.priceData.push(price);
                
                // Keep only needed data points
                const maxLength = Math.max(this.config.emaPeriod, this.config.rsiPeriod) + 50;
                if (this.priceData.length > maxLength) {
                    this.priceData = this.priceData.slice(-maxLength);
                }

                // Calculate indicators
                if (this.priceData.length >= this.config.emaPeriod) {
                    const emas = this.calculateEMA(this.priceData, this.config.emaPeriod);
                    const rsis = this.calculateRSI(this.priceData, this.config.rsiPeriod);
                    
                    const currentEMA = emas[emas.length - 1];
                    const currentRSI = rsis[rsis.length - 1];
                    
                    if (currentEMA && currentRSI) {
                        console.log(`📊 ${new Date().toLocaleTimeString()} | Price: $${price.toFixed(4)} | RSI: ${currentRSI.toFixed(2)} | EMA: ${currentEMA.toFixed(4)}`);
                        this.processSignal(price, currentEMA, currentRSI);
                    }
                }
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        this.ws.on('close', () => {
            console.log('WebSocket connection closed');
        });

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n🛑 Shutting down...');
            if (this.ws) {
                this.ws.close();
            }
            
            // Print final stats
            const finalBalance = this.balance + (this.holdings * (this.priceData[this.priceData.length - 1] || 0));
            const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;
            
            console.log('\n📋 FORWARD TEST RESULTS:');
            console.log(`Final Balance: $${finalBalance.toFixed(2)}`);
            console.log(`ROI: ${roi.toFixed(2)}%`);
            console.log(`Wins: ${this.wins}`);
            console.log(`Losses: ${this.losses}`);
            
            process.exit(0);
        });
    }

    // Main run method
    async run() {
        if (this.config.backtest) {
            await this.runBacktest();
        } else {
            this.startForwardTest();
        }
    }
}

// Configuration - modify these parameters
const config = {
    symbol: 'AVAXUSDT',
    timeframe: '3m',
    startDate: '2025-09-05',
    endDate: '2025-09-06',
    initialBalance: 890,
    emaPeriod: 100,
    rsiPeriod: 14,
    rsiEntry: 45,
    tp1Pct: 1.2,
    tp2Pct: 2.0,
    slPct: -0.6,
    feePct: 0.001,
    slippagePct: 0.0005,
    rsiExit1: 80,
    rsiExit2: 85,
    backtest: true  // Set to false for forward testing
};

// Run the tester
const tester = new CryptoScalpingTester(config);
tester.run().catch(console.error);
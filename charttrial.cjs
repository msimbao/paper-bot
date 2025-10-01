async startForwardTest() {
        this.log('🚀 Starting forward test with live data...', 'INFO');
        
        // Start chart server if enabled
        if (this.config.enableChart) {
            this.startChartServer();
        }
        
        if (this.config.realTrading) {
            this.log('⚠️ REAL TRADING MODE ENABLED - This will use your actual Binance account!', 'WARNING');
            
            try {
                const accountBalance = await this.getAccountBalance();
                this.balance = accountBalance;
                this.log(`💰 Account Balance: ${accountBalance.toFixed(2)}`, 'INFO');
            } catch (error) {
                this.log(`❌ Failed to connect to Binance account: ${error.message}`, 'ERROR');
                return;
            }
        }
        
        const dataLoaded = await this.getRecentHistoricalData();
        if (!dataLoaded) {
            this.log('❌ Failed to load historical data. Exiting...', 'ERROR');
            return;
        }
        
        await this.connectWebSocket();
        
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            this.log('\n🛑 Shutdown signal received...', 'INFO');
            this.shouldReconnect = false;
            
            if (this.ws) {
                this.ws.close();
            }
            
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
            }
            
            if (this.chartServer) {
                this.chartServer.close();
            }
            
            const finalBalance = this.balance + (this.holdings * (this.priceData[this.priceData.length - 1] || 0));
            const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;
            
            this.log('\n📋 FORWARD TEST RESULTS:', 'RESULT');
            this.log(`Final Balance: ${finalBalance.toFixed(2)}`, 'RESULT');
            this.log(`ROI: ${roi.toFixed(2)}%`, 'RESULT');
            this.log(`Wins: ${this.wins}`, 'RESULT');
            this.log(`Losses: ${this.losses}`, 'RESULT');
            
            process.exit(0);
        });
    }

    async run() {
        if (this.config.backtest) {
            await this.runBacktest();
        } else {
            await this.startForwardTest();
        }
    }
}

// Configuration - modify these parameters
const config = {
    symbol: 'NEARUSDT',
    timeframe: '5m',
    startDate: '2025-09-06',
    endDate: '2025-09-19',
    initialBalance: 890,
    emaPeriod: 100,
    rsiPeriod: 14,
    rsiEntry: 45,
    tp1Pct: 1.2,
    tp2Pct: 2.0,
    slPct: -0.8,
    feePct: 0.004,
    slippagePct: 0.0005,
    rsiExit1: 80,
    rsiExit2: 85,
    backtest: true,  // Set to false for forward testing
    
    // Trailing Stop Loss Configuration
    enableTrailingStop: false,
    trailingStopTriggerPct: 0.8,
    trailingStopDistancePct: 0.2,
    trailingStopMode: 'replace_tp',
    
    // Real Trading Configuration (DANGEROUS - USE WITH CAUTION!)
    realTrading: false,
    apiKey: 'YOUR_API_KEY_HERE',
    apiSecret: 'YOUR_API_SECRET_HERE',
    
    // Connection Management
    maxReconnectAttempts: -1,
    reconnectDelay: 5000,
    heartbeatInterval: 30000,
    dataTimeoutMs: 120000,
    
    // Chart Configuration
    enableChart: true,  // Set to false to disable chart
    chartPort: 3000     // Port for chart web server
};

// Run the tester
const tester = new CryptoScalpingTester(config);
tester.run().catch(console.error);const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

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
            backtest: config.backtest || false,
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
            dataTimeoutMs: config.dataTimeoutMs || 120000,
            // Chart server configuration
            enableChart: config.enableChart !== false,
            chartPort: config.chartPort || 3000
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
        this.dataTimeoutTimer = null;
        this.shouldReconnect = true;
        
        // Chart data storage
        this.chartData = {
            candles: [],
            ema: [],
            rsi: [],
            trades: [],
            balance: []
        };
        
        this.chartServer = null;
        this.chartClients = [];
        
        this.logFile = `trading_log_${new Date().toISOString().split('T')[0]}.txt`;
        this.initializeLogging();
    }

    initializeLogging() {
        this.log('🚀 System initialized', 'INFO');
        this.log(`Configuration: ${JSON.stringify(this.config, null, 2)}`, 'CONFIG');
    }

    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}] ${message}`;
        
        console.log(logEntry);
        
        try {
            fs.appendFileSync(this.logFile, logEntry + '\n');
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
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
        let gains = 0;
        let losses = 0;

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

    updateTrailingStop(currentPrice) {
        if (!this.config.enableTrailingStop || this.holdings === 0) return;

        const currentProfitPct = ((currentPrice - this.entryPrice) / this.entryPrice) * 100;
        
        if (!this.trailingStopActive && currentProfitPct >= this.config.trailingStopTriggerPct) {
            this.trailingStopActive = true;
            this.highestPriceSinceEntry = currentPrice;
            this.trailingStopPrice = currentPrice * (1 - this.config.trailingStopDistancePct / 100);
            
            this.log(`🎯 Trailing stop ACTIVATED at ${currentPrice.toFixed(4)} | Profit: ${currentProfitPct.toFixed(2)}% | Trail Stop: ${this.trailingStopPrice.toFixed(4)}`, 'INFO');
        }
        
        if (this.trailingStopActive && currentPrice > this.highestPriceSinceEntry) {
            this.highestPriceSinceEntry = currentPrice;
            const newTrailingStopPrice = currentPrice * (1 - this.config.trailingStopDistancePct / 100);
            
            if (newTrailingStopPrice > this.trailingStopPrice) {
                this.trailingStopPrice = newTrailingStopPrice;
                this.log(`📈 Trailing stop UPDATED to ${this.trailingStopPrice.toFixed(4)} | High: ${currentPrice.toFixed(4)} | Profit: ${currentProfitPct.toFixed(2)}%`, 'INFO');
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

    createSignature(queryString) {
        return crypto.createHmac('sha256', this.config.apiSecret)
                    .update(queryString)
                    .digest('hex');
    }

    async makeAuthenticatedRequest(endpoint, params = {}) {
        if (!this.config.apiKey || !this.config.apiSecret) {
            throw new Error('API credentials not provided');
        }

        const timestamp = Date.now();
        const queryString = new URLSearchParams({
            ...params,
            timestamp
        }).toString();

        const signature = this.createSignature(queryString);
        const url = `https://api.binance.com${endpoint}?${queryString}&signature=${signature}`;

        const response = await fetch(url, {
            headers: {
                'X-MBX-APIKEY': this.config.apiKey
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`Binance API Error: ${error.msg || 'Unknown error'}`);
        }

        return await response.json();
    }

    async getAccountBalance() {
        try {
            const account = await this.makeAuthenticatedRequest('/api/v3/account');
            const usdtBalance = account.balances.find(b => b.asset === 'USDT');
            return parseFloat(usdtBalance?.free || 0);
        } catch (error) {
            this.log(`Failed to get account balance: ${error.message}`, 'ERROR');
            return 0;
        }
    }

    async placeMarketOrder(side, quantity) {
        try {
            const order = await this.makeAuthenticatedRequest('/api/v3/order', {
                symbol: this.config.symbol,
                side: side.toUpperCase(),
                type: 'MARKET',
                quantity: quantity.toFixed(6)
            });
            
            this.log(`Order placed: ${JSON.stringify(order)}`, 'TRADE');
            return order;
        } catch (error) {
            this.log(`Failed to place ${side} order: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    getTimeframeMs() {
        const timeframes = {
            '1m': 60 * 1000,
            '3m': 3 * 60 * 1000,
            '5m': 5 * 60 * 1000,
            '15m': 15 * 60 * 1000,
            '30m': 30 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '2h': 2 * 60 * 60 * 1000,
            '4h': 4 * 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
            '8h': 8 * 60 * 60 * 1000,
            '12h': 12 * 60 * 60 * 1000,
            '1d': 24 * 60 * 60 * 1000,
            '3d': 3 * 24 * 60 * 60 * 1000,
            '1w': 7 * 24 * 60 * 60 * 1000,
            '1M': 30 * 24 * 60 * 60 * 1000
        };
        return timeframes[this.config.timeframe] || 60 * 1000;
    }

    async fetchKlinesBatch(symbol, interval, startTime, endTime, limit = 1000) {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        
        if (startTime) url += `&startTime=${startTime}`;
        if (endTime) url += `&endTime=${endTime}`;
        
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            return data;
        } catch (error) {
            this.log(`Error fetching klines batch: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    async getHistoricalData(startDate = null, endDate = null, limit = 1000) {
        const symbol = this.config.symbol.toUpperCase();
        const interval = this.config.timeframe;
        const cacheDir = path.join(__dirname, 'data_cache');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

        let cacheFile = null;
        if (startDate && endDate) {
            const fileSafe = `${symbol}_${interval}_${startDate}_${endDate}.json`
                .replace(/[^a-zA-Z0-9_.-]/g, "_");
            cacheFile = path.join(cacheDir, fileSafe);

            if (fs.existsSync(cacheFile)) {
                this.log(`📂 Loaded candles from cache: ${cacheFile}`, 'INFO');
                const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                return cached.map(d => ({
                    time: new Date(d.time),
                    open: d.open,
                    high: d.high,
                    low: d.low,
                    close: d.close,
                    volume: d.volume
                }));
            }
        }

        if (!startDate && !endDate) {
            try {
                const data = await this.fetchKlinesBatch(symbol, interval, null, null, limit);
                return data.map(kline => ({
                    time: new Date(kline[0]),
                    open: parseFloat(kline[1]),
                    high: parseFloat(kline[2]),
                    low: parseFloat(kline[3]),
                    close: parseFloat(kline[4]),
                    volume: parseFloat(kline[5])
                }));
            } catch (error) {
                this.log(`Error fetching recent historical data: ${error.message}`, 'ERROR');
                return [];
            }
        }

        const startTime = new Date(startDate).getTime();
        const endTime = new Date(endDate).getTime();
        const timeframeMs = this.getTimeframeMs();

        this.log(`📅 Fetching historical data from ${startDate} to ${endDate}`, 'INFO');
        this.log(`⏱️ Timeframe: ${interval} (${timeframeMs}ms per candle)`, 'INFO');

        const allKlines = [];
        let currentStartTime = startTime;
        let batchCount = 0;
        const maxBatches = 50;

        while (currentStartTime < endTime && batchCount < maxBatches) {
            try {
                const batchEndTime = Math.min(currentStartTime + (1000 * timeframeMs), endTime);

                this.log(`📦 Fetching batch ${batchCount + 1}: ${new Date(currentStartTime).toISOString()} to ${new Date(batchEndTime).toISOString()}`, 'INFO');

                const batchData = await this.fetchKlinesBatch(symbol, interval, currentStartTime, batchEndTime, 1000);

                if (batchData.length === 0) {
                    this.log('📭 No more data available', 'INFO');
                    break;
                }

                allKlines.push(...batchData);

                const lastCandleTime = batchData[batchData.length - 1][0];
                currentStartTime = lastCandleTime + timeframeMs;

                batchCount++;

                this.log(`📊 Batch ${batchCount} complete: ${batchData.length} candles (Total: ${allKlines.length})`, 'INFO');

                if (batchCount < maxBatches) {
                    await new Promise(resolve => setTimeout(resolve, 100)); 
                }

                if (batchData.length < 1000) {
                    break;
                }

            } catch (error) {
                this.log(`❌ Error fetching batch ${batchCount + 1}: ${error.message}`, 'ERROR');
                await new Promise(resolve => setTimeout(resolve, 1000));
                currentStartTime += 1000 * timeframeMs;
                batchCount++;
            }
        }

        if (batchCount >= maxBatches) {
            this.log(`⚠️ Reached maximum batch limit (${maxBatches}). Data may be incomplete.`, 'WARNING');
        }

        this.log(`✅ Historical data collection complete: ${allKlines.length} total candles`, 'SUCCESS');

        const uniqueKlines = allKlines.filter((kline, index, array) => 
            index === 0 || kline[0] !== array[index - 1][0]
        ).sort((a, b) => a[0] - b[0]);

        this.log(`🔄 After deduplication: ${uniqueKlines.length} unique candles`, 'INFO');

        const finalData = uniqueKlines.map(kline => ({
            time: new Date(kline[0]),
            open: parseFloat(kline[1]),
            high: parseFloat(kline[2]),
            low: parseFloat(kline[3]),
            close: parseFloat(kline[4]),
            volume: parseFloat(kline[5])
        }));

        if (cacheFile) {
            fs.writeFileSync(cacheFile, JSON.stringify(finalData, null, 2));
            this.log(`💾 Saved candles to cache: ${cacheFile}`, 'SUCCESS');
        }

        return finalData;
    }

    async getRecentHistoricalData() {
        this.log('📥 Fetching recent historical data for indicator initialization...', 'INFO');
        
        const requiredCandles = Math.max(this.config.emaPeriod, this.config.rsiPeriod) + 50;
        
        try {
            const data = await this.getHistoricalData(null, null, requiredCandles);
            
            if (data.length === 0) {
                this.log('❌ Failed to fetch recent historical data', 'ERROR');
                return false;
            }
            
            this.priceData = data.map(d => d.close);
            
            this.log(`✅ Loaded ${this.priceData.length} recent candles for indicator calculation`, 'INFO');
            this.log(`📊 Price range: $${Math.min(...this.priceData).toFixed(4)} - $${Math.max(...this.priceData).toFixed(4)}`, 'INFO');
            
            const emas = this.calculateEMA(this.priceData, this.config.emaPeriod);
            const rsis = this.calculateRSI(this.priceData, this.config.rsiPeriod);
            
            const currentPrice = this.priceData[this.priceData.length - 1];
            const currentEMA = emas[emas.length - 1];
            const currentRSI = rsis[rsis.length - 1];
            
            this.log(`📈 Current indicators - Price: $${currentPrice.toFixed(4)} | EMA(${this.config.emaPeriod}): $${currentEMA.toFixed(4)} | RSI(${this.config.rsiPeriod}): ${currentRSI.toFixed(2)}`, 'INFO');
            
            return true;
        } catch (error) {
            this.log(`❌ Error fetching recent historical data: ${error.message}`, 'ERROR');
            return false;
        }
    }

    async processSignal(price, ema, rsi, timestamp = null) {
        if (isNaN(price) || isNaN(ema) || isNaN(rsi)) return;

        if (this.holdings === 0 && price > ema && rsi <= this.config.rsiEntry) {
            const amount = this.balance / price;
            
            if (this.config.realTrading) {
                try {
                    await this.placeMarketOrder('BUY', amount);
                    this.holdings = amount;
                    this.entryPrice = price * (1 + this.config.slippagePct);
                    this.entryTime = new Date();
                    this.balance = 0;
                    this.resetTrailingStop();
                } catch (error) {
                    this.log(`❌ Failed to execute BUY order: ${error.message}`, 'ERROR');
                    return;
                }
            } else {
                this.holdings = amount;
                this.entryPrice = price * (1 + this.config.slippagePct);
                this.entryTime = new Date();
                this.balance = 0;
                this.resetTrailingStop();
            }
            
            // Add buy trade to chart data
            this.chartData.trades.push({
                time: timestamp || Date.now(),
                type: 'buy',
                price: price,
                rsi: rsi,
                ema: ema
            });
            
            this.broadcastChartUpdate();
            
            this.log(`🟢 BUY: ${amount.toFixed(6)} ${this.config.symbol} at ${price.toFixed(4)} | RSI: ${rsi.toFixed(2)} | EMA: ${ema.toFixed(4)} | Mode: ${this.config.realTrading ? 'REAL' : 'PAPER'}`, 'TRADE');
            return;
        }

        if (this.holdings > 0) {
            this.updateTrailingStop(price);
            
            const changePct = ((price - this.entryPrice) / this.entryPrice) * 100;
            let shouldSell = false;
            let reason = '';

            if (this.isTrailingStopTriggered(price)) {
                shouldSell = true;
                reason = 'Trailing Stop';
            }
            else if (this.config.trailingStopMode === 'replace_tp') {
                if (rsi >= this.config.rsiExit2) {
                    shouldSell = true;
                    reason = 'RSI Exit 2';
                } else if (rsi >= this.config.rsiExit1 && !this.trailingStopActive) {
                    shouldSell = true;
                    reason = 'RSI Exit 1';
                } else if (changePct <= this.config.slPct) {
                    shouldSell = true;
                    reason = 'Stop Loss';
                }
            }
            else if (this.config.trailingStopMode === 'additional') {
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
            }
            else {
                if (changePct >= this.config.tp2Pct || rsi >= this.config.rsiExit2) {
                    shouldSell = true;
                    reason = changePct >= this.config.tp2Pct ? 'TP2' : 'RSI Exit 2';
                } else if (!this.trailingStopActive && (changePct >= this.config.tp1Pct || rsi >= this.config.rsiExit1)) {
                    shouldSell = true;
                    reason = changePct >= this.config.tp1Pct ? 'TP1' : 'RSI Exit 1';
                } else if (changePct <= this.config.slPct) {
                    shouldSell = true;
                    reason = 'Stop Loss';
                }
            }

            if (shouldSell) {
                const sellPrice = price * (1 - this.config.feePct);
                
                if (this.config.realTrading) {
                    try {
                        await this.placeMarketOrder('SELL', this.holdings);
                        this.balance = this.holdings * sellPrice;
                        this.holdings = 0;
                    } catch (error) {
                        this.log(`❌ Failed to execute SELL order: ${error.message}`, 'ERROR');
                        return;
                    }
                } else {
                    this.balance = this.holdings * sellPrice;
                    this.holdings = 0;
                }
                
                if (changePct > 0) {
                    this.wins++;
                } else {
                    this.losses++;
                }

                // Add sell trade to chart data
                this.chartData.trades.push({
                    time: timestamp || Date.now(),
                    type: 'sell',
                    price: price,
                    reason: reason,
                    profit: changePct,
                    rsi: rsi,
                    ema: ema
                });
                
                this.broadcastChartUpdate();

                const holdTime = this.entryTime ? Math.round((new Date() - this.entryTime) / 60000) : 0;
                const maxProfitPct = this.trailingStopActive ? ((this.highestPriceSinceEntry - this.entryPrice) / this.entryPrice) * 100 : changePct;
                
                this.log(`🔴 SELL: ${reason} at ${price.toFixed(4)} | P&L: ${changePct.toFixed(2)}% | Max Profit: ${maxProfitPct.toFixed(2)}% | Balance: ${this.balance.toFixed(2)} | Hold: ${holdTime}min | Mode: ${this.config.realTrading ? 'REAL' : 'PAPER'}`, 'TRADE');
                
                this.entryTime = null;
                this.resetTrailingStop();
            }
        }
        
        // Update balance history
        const currentBalance = this.balance + (this.holdings * price);
        this.chartData.balance.push({
            time: timestamp || Date.now(),
            balance: currentBalance
        });
    }

    // Chart server methods
    startChartServer() {
        if (!this.config.enableChart) return;
        
        this.chartServer = http.createServer((req, res) => {
            if (req.url === '/') {
                res.writeHead(200, {'Content-Type': 'text/html'});
                res.end(this.getChartHTML());
            } else if (req.url === '/data') {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify(this.chartData));
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });
        
        const WebSocketServer = require('ws').Server;
        const wss = new WebSocketServer({ server: this.chartServer });
        
        wss.on('connection', (ws) => {
            this.log('📊 Chart client connected', 'INFO');
            this.chartClients.push(ws);
            
            // Send initial data
            ws.send(JSON.stringify({
                type: 'init',
                data: this.chartData,
                config: this.config
            }));
            
            ws.on('close', () => {
                this.log('📊 Chart client disconnected', 'INFO');
                this.chartClients = this.chartClients.filter(client => client !== ws);
            });
        });
        
        this.chartServer.listen(this.config.chartPort, () => {
            this.log(`📊 Chart server started at http://localhost:${this.config.chartPort}`, 'SUCCESS');
            this.log(`📊 Open your browser to view the trading chart`, 'INFO');
        });
    }
    
    broadcastChartUpdate() {
        if (!this.config.enableChart) return;
        
        const message = JSON.stringify({
            type: 'update',
            data: this.chartData
        });
        
        this.chartClients.forEach(client => {
            if (client.readyState === 1) { // OPEN
                client.send(message);
            }
        });
    }
    
    getChartHTML() {
        return `<!DOCTYPE html>
<html>
<head>
    <title>Trading Bot Chart - ${this.config.symbol}</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: #1a1a1a;
            color: #fff;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        h1 {
            text-align: center;
            color: #4CAF50;
        }
        .chart-container {
            position: relative;
            height: 500px;
            background: #2a2a2a;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-card {
            background: #2a2a2a;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
        }
        .stat-label {
            color: #888;
            font-size: 12px;
            margin-bottom: 5px;
        }
        .stat-value {
            font-size: 24px;
            font-weight: bold;
        }
        .positive { color: #4CAF50; }
        .negative { color: #f44336; }
        .status {
            background: #2a2a2a;
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Trading Bot - ${this.config.symbol} (${this.config.timeframe})</h1>
        
        <div class="status">
            <span id="status">Connecting...</span>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-label">Current Balance</div>
                <div class="stat-value" id="balance">$0.00</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total Trades</div>
                <div class="stat-value" id="trades">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Win Rate</div>
                <div class="stat-value" id="winrate">0%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">ROI</div>
                <div class="stat-value" id="roi">0%</div>
            </div>
        </div>
        
        <div class="chart-container">
            <canvas id="priceChart"></canvas>
        </div>
        
        <div class="chart-container">
            <canvas id="rsiChart"></canvas>
        </div>
        
        <div class="chart-container" style="height: 300px;">
            <canvas id="balanceChart"></canvas>
        </div>
    </div>
    
    <script>
        const ws = new WebSocket('ws://localhost:${this.config.chartPort}');
        let priceChart, rsiChart, balanceChart;
        let config = {};
        
        ws.onopen = () => {
            document.getElementById('status').textContent = 'Connected ✓';
            document.getElementById('status').style.color = '#4CAF50';
        };
        
        ws.onclose = () => {
            document.getElementById('status').textContent = 'Disconnected ✗';
            document.getElementById('status').style.color = '#f44336';
        };
        
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            
            if (message.type === 'init') {
                config = message.config;
                initCharts();
                updateCharts(message.data);
            } else if (message.type === 'update') {
                updateCharts(message.data);
            }
        };
        
        function initCharts() {
            // Price Chart with EMA
            const priceCtx = document.getElementById('priceChart').getContext('2d');
            priceChart = new Chart(priceCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Price',
                            data: [],
                            borderColor: '#2196F3',
                            backgroundColor: 'rgba(33, 150, 243, 0.1)',
                            borderWidth: 2,
                            pointRadius: 0,
                            tension: 0.1
                        },
                        {
                            label: 'EMA(' + config.emaPeriod + ')',
                            data: [],
                            borderColor: '#FF9800',
                            backgroundColor: 'transparent',
                            borderWidth: 2,
                            pointRadius: 0,
                            tension: 0.1
                        },
                        {
                            label: 'Buy',
                            data: [],
                            borderColor: '#4CAF50',
                            backgroundColor: '#4CAF50',
                            pointRadius: 8,
                            pointStyle: 'triangle',
                            showLine: false
                        },
                        {
                            label: 'Sell',
                            data: [],
                            borderColor: '#f44336',
                            backgroundColor: '#f44336',
                            pointRadius: 8,
                            pointStyle: 'triangle',
                            rotation: 180,
                            showLine: false
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    plugins: {
                        legend: {
                            labels: { color: '#fff' }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    let label = context.dataset.label || '';
                                    if (label) label += ': ';
                                    if (context.parsed.y !== null) {
                                        label += ' + context.parsed.y.toFixed(4);
                                    }
                                    return label;
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#888' },
                            grid: { color: '#333' }
                        },
                        y: {
                            ticks: { color: '#888' },
                            grid: { color: '#333' }
                        }
                    }
                }
            });
            
            // RSI Chart
            const rsiCtx = document.getElementById('rsiChart').getContext('2d');
            rsiChart = new Chart(rsiCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'RSI(' + config.rsiPeriod + ')',
                        data: [],
                        borderColor: '#9C27B0',
                        backgroundColor: 'rgba(156, 39, 176, 0.1)',
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: { color: '#fff' }
                        },
                        annotation: {
                            annotations: {
                                line1: {
                                    type: 'line',
                                    yMin: 70,
                                    yMax: 70,
                                    borderColor: '#f44336',
                                    borderWidth: 1,
                                    borderDash: [5, 5]
                                },
                                line2: {
                                    type: 'line',
                                    yMin: 30,
                                    yMax: 30,
                                    borderColor: '#4CAF50',
                                    borderWidth: 1,
                                    borderDash: [5, 5]
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#888' },
                            grid: { color: '#333' }
                        },
                        y: {
                            min: 0,
                            max: 100,
                            ticks: { color: '#888' },
                            grid: { color: '#333' }
                        }
                    }
                }
            });
            
            // Balance Chart
            const balanceCtx = document.getElementById('balanceChart').getContext('2d');
            balanceChart = new Chart(balanceCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Portfolio Value',
                        data: [],
                        borderColor: '#4CAF50',
                        backgroundColor: 'rgba(76, 175, 80, 0.1)',
                        borderWidth: 2,
                        pointRadius: 0,
                        fill: true,
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: { color: '#fff' }
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#888' },
                            grid: { color: '#333' }
                        },
                        y: {
                            ticks: { 
                                color: '#888',
                                callback: function(value) {
                                    return ' + value.toFixed(2);
                                }
                            },
                            grid: { color: '#333' }
                        }
                    }
                }
            });
        }
        
        function updateCharts(data) {
            if (!priceChart) return;
            
            // Update price and EMA data
            const labels = data.candles.map(c => new Date(c.time).toLocaleTimeString());
            const prices = data.candles.map(c => c.close);
            const emas = data.ema;
            
            priceChart.data.labels = labels;
            priceChart.data.datasets[0].data = prices;
            priceChart.data.datasets[1].data = emas;
            
            // Update buy/sell markers
            const buyTrades = data.trades.filter(t => t.type === 'buy');
            const sellTrades = data.trades.filter(t => t.type === 'sell');
            
            priceChart.data.datasets[2].data = buyTrades.map(t => ({
                x: new Date(t.time).toLocaleTimeString(),
                y: t.price
            }));
            
            priceChart.data.datasets[3].data = sellTrades.map(t => ({
                x: new Date(t.time).toLocaleTimeString(),
                y: t.price
            }));
            
            priceChart.update('none');
            
            // Update RSI
            rsiChart.data.labels = labels;
            rsiChart.data.datasets[0].data = data.rsi;
            rsiChart.update('none');
            
            // Update balance
            if (data.balance.length > 0) {
                balanceChart.data.labels = data.balance.map(b => new Date(b.time).toLocaleTimeString());
                balanceChart.data.datasets[0].data = data.balance.map(b => b.balance);
                balanceChart.update('none');
                
                // Update stats
                const currentBalance = data.balance[data.balance.length - 1].balance;
                const roi = ((currentBalance - config.initialBalance) / config.initialBalance) * 100;
                const totalTrades = data.trades.length / 2; // Buy + Sell = 1 trade
                const wins = sellTrades.filter(t => t.profit > 0).length;
                const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
                
                document.getElementById('balance').textContent = ' + currentBalance.toFixed(2);
                document.getElementById('balance').className = 'stat-value ' + (roi >= 0 ? 'positive' : 'negative');
                
                document.getElementById('trades').textContent = Math.floor(totalTrades);
                
                document.getElementById('winrate').textContent = winRate.toFixed(1) + '%';
                document.getElementById('winrate').className = 'stat-value ' + (winRate >= 50 ? 'positive' : 'negative');
                
                document.getElementById('roi').textContent = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';
                document.getElementById('roi').className = 'stat-value ' + (roi >= 0 ? 'positive' : 'negative');
            }
        }
    </script>
</body>
</html>`
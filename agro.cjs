const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
            // Real trading options
            realTrading: config.realTrading || false,
            apiKey: config.apiKey || '',
            apiSecret: config.apiSecret || '',
            // Connection settings
            maxReconnectAttempts: config.maxReconnectAttempts || -1, // -1 for infinite
            reconnectDelay: config.reconnectDelay || 5000,
            heartbeatInterval: config.heartbeatInterval || 30000,
            dataTimeoutMs: config.dataTimeoutMs || 120000 // 2 minutes without data = disconnect
        };
        
        this.balance = this.config.initialBalance;
        this.holdings = 0;
        this.entryPrice = 0;
        this.entryTime = null;
        this.wins = 0;
        this.losses = 0;
        this.priceData = [];
        this.ws = null;
        
        // Connection management
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.isConnected = false;
        this.lastDataTime = null;
        this.heartbeatTimer = null;
        this.dataTimeoutTimer = null;
        this.shouldReconnect = true;
        
        // Logging
        this.logFile = `trading_log_${new Date().toISOString().split('T')[0]}.txt`;
        this.initializeLogging();
    }

    // Initialize logging system
    initializeLogging() {
        this.log('🚀 System initialized', 'INFO');
        this.log(`Configuration: ${JSON.stringify(this.config, null, 2)}`, 'CONFIG');
    }

    // Enhanced logging with timestamps and levels
    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}] ${message}`;
        
        console.log(logEntry);
        
        // Write to log file
        try {
            fs.appendFileSync(this.logFile, logEntry + '\n');
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
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

    // Create Binance API signature
    createSignature(queryString) {
        return crypto.createHmac('sha256', this.config.apiSecret)
                    .update(queryString)
                    .digest('hex');
    }

    // Make authenticated Binance API request
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

    // Get account balance (real trading)
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

    // Place market order (real trading)
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

    // Get historical data from Binance REST API
    async getHistoricalData(startDate = null, endDate = null, limit = 1000) {
        const symbol = this.config.symbol.toLowerCase();
        const interval = this.config.timeframe;
        
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
        
        if (startDate && endDate) {
            const startTime = new Date(startDate).getTime();
            const endTime = new Date(endDate).getTime();
            url += `&startTime=${startTime}&endTime=${endTime}`;
        }
        
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
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
            this.log(`Error fetching historical data: ${error.message}`, 'ERROR');
            return [];
        }
    }

    // Get recent historical data for initialization
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

    // Process trade signal
    async processSignal(price, ema, rsi) {
        if (isNaN(price) || isNaN(ema) || isNaN(rsi)) return;

        // BUY signal
        if (this.holdings === 0 && price > ema && rsi <= this.config.rsiEntry) {
            const amount = this.balance / price;
            
            if (this.config.realTrading) {
                try {
                    await this.placeMarketOrder('BUY', amount);
                    this.holdings = amount;
                    this.entryPrice = price * (1 + this.config.slippagePct);
                    this.entryTime = new Date();
                    this.balance = 0;
                } catch (error) {
                    this.log(`❌ Failed to execute BUY order: ${error.message}`, 'ERROR');
                    return;
                }
            } else {
                this.holdings = amount;
                this.entryPrice = price * (1 + this.config.slippagePct);
                this.entryTime = new Date();
                this.balance = 0;
            }
            
            this.log(`🟢 BUY: ${amount.toFixed(6)} ${this.config.symbol} at $${price.toFixed(4)} | RSI: ${rsi.toFixed(2)} | EMA: ${ema.toFixed(4)} | Mode: ${this.config.realTrading ? 'REAL' : 'PAPER'}`, 'TRADE');
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

                const holdTime = this.entryTime ? Math.round((new Date() - this.entryTime) / 60000) : 0;
                this.log(`🔴 SELL: ${reason} at $${price.toFixed(4)} | P&L: ${changePct.toFixed(2)}% | Balance: $${this.balance.toFixed(2)} | Hold: ${holdTime}min | Mode: ${this.config.realTrading ? 'REAL' : 'PAPER'}`, 'TRADE');
                
                this.entryTime = null;
            }
        }
    }

    // Setup heartbeat monitoring
    setupHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        
        this.heartbeatTimer = setInterval(() => {
            if (this.isConnected && this.lastDataTime) {
                const timeSinceLastData = Date.now() - this.lastDataTime;
                if (timeSinceLastData > this.config.dataTimeoutMs) {
                    this.log(`⚠️ No data received for ${Math.round(timeSinceLastData / 1000)}s. Reconnecting...`, 'WARNING');
                    this.reconnectWebSocket();
                }
            }
        }, this.config.heartbeatInterval);
    }

    // Connect to WebSocket
    async connectWebSocket() {
        if (this.isConnecting) return;
        
        this.isConnecting = true;
        
        try {
            const symbol = this.config.symbol.toLowerCase();
            const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@kline_${this.config.timeframe}`;
            
            this.log(`🔌 Attempting WebSocket connection to ${wsUrl}`, 'INFO');
            
            this.ws = new WebSocket(wsUrl);
            
            this.ws.on('open', () => {
                this.log(`📡 WebSocket connected successfully for ${this.config.symbol}`, 'SUCCESS');
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
                    
                    if (kline.x) { // Only process completed candles
                        this.processKlineData(kline);
                    }
                } catch (error) {
                    this.log(`Error processing WebSocket message: ${error.message}`, 'ERROR');
                }
            });

            this.ws.on('error', (error) => {
                this.log(`WebSocket error: ${error.message}`, 'ERROR');
                this.isConnected = false;
                this.isConnecting = false;
            });

            this.ws.on('close', (code, reason) => {
                this.log(`WebSocket connection closed. Code: ${code}, Reason: ${reason || 'Unknown'}`, 'WARNING');
                this.isConnected = false;
                this.isConnecting = false;
                
                if (this.shouldReconnect) {
                    this.scheduleReconnect();
                }
            });

        } catch (error) {
            this.log(`Failed to create WebSocket connection: ${error.message}`, 'ERROR');
            this.isConnecting = false;
            if (this.shouldReconnect) {
                this.scheduleReconnect();
            }
        }
    }

    // Process incoming kline data
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
            this.log(`📊 ${new Date().toLocaleTimeString()} | Price: $${price.toFixed(4)} | RSI: ${currentRSI.toFixed(2)} | EMA: ${currentEMA.toFixed(4)} | Holdings: ${this.holdings.toFixed(6)}`, 'DATA');
            await this.processSignal(price, currentEMA, currentRSI);
        }
    }

    // Schedule reconnection attempt
    scheduleReconnect() {
        if (!this.shouldReconnect) return;
        
        this.reconnectAttempts++;
        
        if (this.config.maxReconnectAttempts > 0 && this.reconnectAttempts > this.config.maxReconnectAttempts) {
            this.log(`❌ Maximum reconnection attempts (${this.config.maxReconnectAttempts}) exceeded. Stopping.`, 'ERROR');
            this.shouldReconnect = false;
            return;
        }
        
        const delay = Math.min(this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 60000); // Exponential backoff, max 1 minute
        
        this.log(`🔄 Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`, 'INFO');
        
        setTimeout(async () => {
            if (this.shouldReconnect && !this.isConnected) {
                this.log(`🔄 Reconnection attempt ${this.reconnectAttempts}`, 'INFO');
                
                // Refresh historical data on reconnect for accuracy
                await this.getRecentHistoricalData();
                await this.connectWebSocket();
            }
        }, delay);
    }

    // Force reconnection
    async reconnectWebSocket() {
        this.log('🔄 Forcing WebSocket reconnection...', 'INFO');
        
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.terminate();
            this.ws = null;
        }
        
        this.isConnected = false;
        this.isConnecting = false;
        
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        await this.connectWebSocket();
    }

    // Run backtest
    async runBacktest() {
        this.log('📊 Starting backtest...', 'INFO');
        const data = await this.getHistoricalData(this.config.startDate, this.config.endDate, 1000);
        
        if (data.length === 0) {
            this.log('No historical data available', 'ERROR');
            return;
        }

        this.log(`📈 Loaded ${data.length} candles for ${this.config.symbol}`, 'INFO');
        
        const prices = data.map(d => d.close);
        const emas = this.calculateEMA(prices, this.config.emaPeriod);
        const rsis = this.calculateRSI(prices, this.config.rsiPeriod);

        for (let i = 0; i < data.length; i++) {
            if (emas[i] && rsis[i]) {
                await this.processSignal(prices[i], emas[i], rsis[i]);
            }
        }

        const finalPrice = prices[prices.length - 1];
        const finalBalance = this.balance + (this.holdings * finalPrice);
        const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;

        this.log('\n📋 BACKTEST RESULTS:', 'RESULT');
        this.log(`Initial Balance: $${this.config.initialBalance}`, 'RESULT');
        this.log(`Final Balance: $${finalBalance.toFixed(2)}`, 'RESULT');
        this.log(`ROI: ${roi.toFixed(2)}%`, 'RESULT');
        this.log(`Wins: ${this.wins}`, 'RESULT');
        this.log(`Losses: ${this.losses}`, 'RESULT');
        this.log(`Win Rate: ${this.wins + this.losses > 0 ? ((this.wins / (this.wins + this.losses)) * 100).toFixed(1) : 0}%`, 'RESULT');
    }

    // Start forward testing
    async startForwardTest() {
        this.log('🚀 Starting forward test with live data...', 'INFO');
        
        if (this.config.realTrading) {
            this.log('⚠️ REAL TRADING MODE ENABLED - This will use your actual Binance account!', 'WARNING');
            
            try {
                const accountBalance = await this.getAccountBalance();
                this.balance = accountBalance;
                this.log(`💰 Account Balance: $${accountBalance.toFixed(2)}`, 'INFO');
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
            
            const finalBalance = this.balance + (this.holdings * (this.priceData[this.priceData.length - 1] || 0));
            const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;
            
            this.log('\n📋 FORWARD TEST RESULTS:', 'RESULT');
            this.log(`Final Balance: $${finalBalance.toFixed(2)}`, 'RESULT');
            this.log(`ROI: ${roi.toFixed(2)}%`, 'RESULT');
            this.log(`Wins: ${this.wins}`, 'RESULT');
            this.log(`Losses: ${this.losses}`, 'RESULT');
            
            process.exit(0);
        });
    }

    // Main run method
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
    backtest: false,  // Set to false for forward testing
    
    // Real Trading Configuration (DANGEROUS - USE WITH CAUTION!)
    realTrading: false,  // Set to true to enable real trading
    apiKey: '',  // Your Binance API Key
    apiSecret: '',  // Your Binance API Secret
    
    // Connection Management
    maxReconnectAttempts: -1,  // -1 for infinite attempts
    reconnectDelay: 5000,  // Initial reconnection delay in ms
    heartbeatInterval: 30000,  // Check connection every 30 seconds
    dataTimeoutMs: 120000  // 2 minutes without data triggers reconnection
};

// Run the tester
const tester = new CryptoScalpingTester(config);
tester.run().catch(console.error);
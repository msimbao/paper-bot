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
            
            // Trailing Stop Loss Configuration
            enableTrailingStop: config.enableTrailingStop || true,
            trailingStopTriggerPct: config.trailingStopTriggerPct || 0.8, // Start trailing after 0.8% profit
            trailingStopDistancePct: config.trailingStopDistancePct || 0.4, // Trail 0.4% below highest price
            trailingStopMode: config.trailingStopMode || 'both', // 'both', 'replace_tp', 'additional'
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
        
        // Trailing stop loss tracking
        this.highestPriceSinceEntry = 0;
        this.trailingStopPrice = 0;
        this.trailingStopActive = false;
        
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

    // Update trailing stop loss
    updateTrailingStop(currentPrice) {
        if (!this.config.enableTrailingStop || this.holdings === 0) return;

        const currentProfitPct = ((currentPrice - this.entryPrice) / this.entryPrice) * 100;
        
        // Check if we should activate trailing stop
        if (!this.trailingStopActive && currentProfitPct >= this.config.trailingStopTriggerPct) {
            this.trailingStopActive = true;
            this.highestPriceSinceEntry = currentPrice;
            this.trailingStopPrice = currentPrice * (1 - this.config.trailingStopDistancePct / 100);
            
            this.log(`🎯 Trailing stop ACTIVATED at ${currentPrice.toFixed(4)} | Profit: ${currentProfitPct.toFixed(2)}% | Trail Stop: ${this.trailingStopPrice.toFixed(4)}`, 'INFO');
        }
        
        // Update trailing stop if active and price is rising
        if (this.trailingStopActive && currentPrice > this.highestPriceSinceEntry) {
            this.highestPriceSinceEntry = currentPrice;
            const newTrailingStopPrice = currentPrice * (1 - this.config.trailingStopDistancePct / 100);
            
            if (newTrailingStopPrice > this.trailingStopPrice) {
                this.trailingStopPrice = newTrailingStopPrice;
                this.log(`📈 Trailing stop UPDATED to ${this.trailingStopPrice.toFixed(4)} | High: ${currentPrice.toFixed(4)} | Profit: ${currentProfitPct.toFixed(2)}%`, 'INFO');
            }
        }
    }

    // Check if trailing stop is triggered
    isTrailingStopTriggered(currentPrice) {
        return this.trailingStopActive && currentPrice <= this.trailingStopPrice;
    }

    // Reset trailing stop for new trade
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

    // Calculate timeframe in milliseconds
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

    // Get single batch of historical data
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

    // Get complete historical data with pagination
    // async getHistoricalData(startDate = null, endDate = null, limit = 1000) {
    //     const symbol = this.config.symbol.toUpperCase();
    //     const interval = this.config.timeframe;
        
    //     // For recent data (no date range specified)
    //     if (!startDate && !endDate) {
    //         try {
    //             const data = await this.fetchKlinesBatch(symbol, interval, null, null, limit);
    //             return data.map(kline => ({
    //                 time: new Date(kline[0]),
    //                 open: parseFloat(kline[1]),
    //                 high: parseFloat(kline[2]),
    //                 low: parseFloat(kline[3]),
    //                 close: parseFloat(kline[4]),
    //                 volume: parseFloat(kline[5])
    //             }));
    //         } catch (error) {
    //             this.log(`Error fetching recent historical data: ${error.message}`, 'ERROR');
    //             return [];
    //         }
    //     }

    //     // For date range queries - implement pagination
    //     const startTime = new Date(startDate).getTime();
    //     const endTime = new Date(endDate).getTime();
    //     const timeframeMs = this.getTimeframeMs();
        
    //     this.log(`📅 Fetching historical data from ${startDate} to ${endDate}`, 'INFO');
    //     this.log(`⏱️ Timeframe: ${interval} (${timeframeMs}ms per candle)`, 'INFO');
        
    //     const allKlines = [];
    //     let currentStartTime = startTime;
    //     let batchCount = 0;
    //     const maxBatches = 50; // Safety limit to prevent infinite loops
        
    //     while (currentStartTime < endTime && batchCount < maxBatches) {
    //         try {
    //             // Calculate end time for this batch (1000 candles worth or actual end time, whichever is smaller)
    //             const batchEndTime = Math.min(currentStartTime + (1000 * timeframeMs), endTime);
                
    //             this.log(`📦 Fetching batch ${batchCount + 1}: ${new Date(currentStartTime).toISOString()} to ${new Date(batchEndTime).toISOString()}`, 'INFO');
                
    //             const batchData = await this.fetchKlinesBatch(symbol, interval, currentStartTime, batchEndTime, 1000);
                
    //             if (batchData.length === 0) {
    //                 this.log('📭 No more data available', 'INFO');
    //                 break;
    //             }
                
    //             allKlines.push(...batchData);
                
    //             // Move start time to after the last candle we received
    //             const lastCandleTime = batchData[batchData.length - 1][0];
    //             currentStartTime = lastCandleTime + timeframeMs;
                
    //             batchCount++;
                
    //             this.log(`📊 Batch ${batchCount} complete: ${batchData.length} candles (Total: ${allKlines.length})`, 'INFO');
                
    //             // Rate limiting - be nice to Binance API
    //             if (batchCount < maxBatches) {
    //                 await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay between requests
    //             }
                
    //             // If we got less than 1000 candles, we've reached the end
    //             if (batchData.length < 1000) {
    //                 break;
    //             }
                
    //         } catch (error) {
    //             this.log(`❌ Error fetching batch ${batchCount + 1}: ${error.message}`, 'ERROR');
                
    //             // Wait longer before retrying
    //             await new Promise(resolve => setTimeout(resolve, 1000));
                
    //             // Try to continue with next batch
    //             currentStartTime += 1000 * timeframeMs;
    //             batchCount++;
    //         }
    //     }
        
    //     if (batchCount >= maxBatches) {
    //         this.log(`⚠️ Reached maximum batch limit (${maxBatches}). Data may be incomplete.`, 'WARNING');
    //     }
        
    //     this.log(`✅ Historical data collection complete: ${allKlines.length} total candles`, 'SUCCESS');
        
    //     // Remove duplicates (can happen at batch boundaries) and sort by time
    //     const uniqueKlines = allKlines.filter((kline, index, array) => 
    //         index === 0 || kline[0] !== array[index - 1][0]
    //     ).sort((a, b) => a[0] - b[0]);
        
    //     this.log(`🔄 After deduplication: ${uniqueKlines.length} unique candles`, 'INFO');
        
    //     return uniqueKlines.map(kline => ({
    //         time: new Date(kline[0]),
    //         open: parseFloat(kline[1]),
    //         high: parseFloat(kline[2]),
    //         low: parseFloat(kline[3]),
    //         close: parseFloat(kline[4]),
    //         volume: parseFloat(kline[5])
    //     }));
    // }

    async getHistoricalData(startDate = null, endDate = null, limit = 1000) {
    const symbol = this.config.symbol.toUpperCase();
    const interval = this.config.timeframe;
    const cacheDir = path.join(__dirname, 'data_cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

    // If both dates are provided, try cache
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

    // === Your original batching logic starts here ===
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

    // Save to cache if requested
    if (cacheFile) {
        fs.writeFileSync(cacheFile, JSON.stringify(finalData, null, 2));
        this.log(`💾 Saved candles to cache: ${cacheFile}`, 'SUCCESS');
    }

    return finalData;
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
                    this.resetTrailingStop(); // Reset for new trade
                } catch (error) {
                    this.log(`❌ Failed to execute BUY order: ${error.message}`, 'ERROR');
                    return;
                }
            } else {
                this.holdings = amount;
                this.entryPrice = price * (1 + this.config.slippagePct);
                this.entryTime = new Date();
                this.balance = 0;
                this.resetTrailingStop(); // Reset for new trade
            }
            
            this.log(`🟢 BUY: ${amount.toFixed(6)} ${this.config.symbol} at ${price.toFixed(4)} | RSI: ${rsi.toFixed(2)} | EMA: ${ema.toFixed(4)} | Mode: ${this.config.realTrading ? 'REAL' : 'PAPER'}`, 'TRADE');
            return;
        }

        // Update trailing stop for open positions
        if (this.holdings > 0) {
            this.updateTrailingStop(price);
            
            const changePct = ((price - this.entryPrice) / this.entryPrice) * 100;
            let shouldSell = false;
            let reason = '';

            // Check trailing stop first (highest priority when active)
            if (this.isTrailingStopTriggered(price)) {
                shouldSell = true;
                reason = 'Trailing Stop';
            }
            // Traditional exit conditions based on mode
            else if (this.config.trailingStopMode === 'replace_tp') {
                // Trailing stop replaces TP levels - only use RSI exits and SL
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
                // Trailing stop works alongside all other exits
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
            else { // 'both' mode (default) - Balanced approach
                if (changePct >= this.config.tp2Pct || rsi >= this.config.rsiExit2) {
                    shouldSell = true;
                    reason = changePct >= this.config.tp2Pct ? 'TP2' : 'RSI Exit 2';
                } else if (!this.trailingStopActive && (changePct >= this.config.tp1Pct || rsi >= this.config.rsiExit1)) {
                    // Only use TP1/RSI1 if trailing stop hasn't activated yet
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

                const holdTime = this.entryTime ? Math.round((new Date() - this.entryTime) / 60000) : 0;
                const maxProfitPct = this.trailingStopActive ? ((this.highestPriceSinceEntry - this.entryPrice) / this.entryPrice) * 100 : changePct;
                
                this.log(`🔴 SELL: ${reason} at ${price.toFixed(4)} | P&L: ${changePct.toFixed(2)}% | Max Profit: ${maxProfitPct.toFixed(2)}% | Balance: ${this.balance.toFixed(2)} | Hold: ${holdTime}min | Mode: ${this.config.realTrading ? 'REAL' : 'PAPER'}`, 'TRADE');
                
                this.entryTime = null;
                this.resetTrailingStop();
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
            const trailingInfo = this.trailingStopActive ? 
                ` | Trail: ${this.trailingStopPrice.toFixed(4)} (High: ${this.highestPriceSinceEntry.toFixed(4)})` : '';
            
            this.log(`📊 ${new Date().toLocaleTimeString()} | Price: ${price.toFixed(4)} | RSI: ${currentRSI.toFixed(2)} | EMA: ${currentEMA.toFixed(4)} | Holdings: ${this.holdings.toFixed(6)}${trailingInfo}`, 'DATA');
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
        
        // Validate date range
        const startTime = new Date(this.config.startDate).getTime();
        const endTime = new Date(this.config.endDate).getTime();
        const daysDifference = (endTime - startTime) / (1000 * 60 * 60 * 24);
        
        this.log(`📅 Backtest period: ${this.config.startDate} to ${this.config.endDate} (${daysDifference.toFixed(1)} days)`, 'INFO');
        
        if (daysDifference > 365) {
            this.log('⚠️ Large date range detected. This may take several minutes to download all data...', 'WARNING');
        }
        
        const data = await this.getHistoricalData(this.config.startDate, this.config.endDate);
        
        if (data.length === 0) {
            this.log('❌ No historical data available for the specified date range', 'ERROR');
            return;
        }

        this.log(`📈 Processing ${data.length} candles for ${this.config.symbol}`, 'INFO');
        this.log(`📊 Data range: ${data[0].time.toISOString()} to ${data[data.length - 1].time.toISOString()}`, 'INFO');
        
        // Validate we have enough data for indicators
        const requiredCandles = Math.max(this.config.emaPeriod, this.config.rsiPeriod);
        if (data.length < requiredCandles) {
            this.log(`❌ Insufficient data: ${data.length} candles, need at least ${requiredCandles} for indicators`, 'ERROR');
            return;
        }
        
        const prices = data.map(d => d.close);
        const emas = this.calculateEMA(prices, this.config.emaPeriod);
        const rsis = this.calculateRSI(prices, this.config.rsiPeriod);

        this.log('🔄 Processing trading signals...', 'INFO');
        
        let processedCandles = 0;
        let lastProgressLog = 0;
        
        for (let i = 0; i < data.length; i++) {
            if (emas[i] && rsis[i]) {
                await this.processSignal(prices[i], emas[i], rsis[i]);
                processedCandles++;
                
                // Progress logging for large datasets
                if (data.length > 10000 && i - lastProgressLog > Math.floor(data.length / 20)) {
                    const progress = ((i / data.length) * 100).toFixed(1);
                    this.log(`📈 Backtest progress: ${progress}% (${i}/${data.length} candles)`, 'INFO');
                    lastProgressLog = i;
                }
            }
        }

        // Calculate final results
        const finalPrice = prices[prices.length - 1];
        const finalBalance = this.balance + (this.holdings * finalPrice);
        const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;
        const totalTrades = this.wins + this.losses;
        const winRate = totalTrades > 0 ? ((this.wins / totalTrades) * 100) : 0;
        const avgTradeReturn = totalTrades > 0 ? (roi / totalTrades) : 0;
        
        // Calculate some additional metrics
        const tradingDays = daysDifference;
        const tradesPerDay = totalTrades / tradingDays;
        const annualizedROI = daysDifference > 0 ? (roi * (365 / daysDifference)) : 0;

        this.log('\n📋 BACKTEST RESULTS:', 'RESULT');
        this.log('=' * 50, 'RESULT');
        this.log(`📊 Dataset: ${data.length} candles over ${daysDifference.toFixed(1)} days`, 'RESULT');
        this.log(`🕒 Period: ${data[0].time.toDateString()} to ${data[data.length - 1].time.toDateString()}`, 'RESULT');
        this.log(`💰 Initial Balance: ${this.config.initialBalance.toFixed(2)}`, 'RESULT');
        this.log(`💰 Final Balance: ${finalBalance.toFixed(2)}`, 'RESULT');
        this.log(`📈 Total ROI: ${roi.toFixed(2)}%`, 'RESULT');
        this.log(`📅 Annualized ROI: ${annualizedROI.toFixed(2)}%`, 'RESULT');
        this.log(`🎯 Total Trades: ${totalTrades}`, 'RESULT');
        this.log(`✅ Wins: ${this.wins} (${winRate.toFixed(1)}%)`, 'RESULT');
        this.log(`❌ Losses: ${this.losses} (${(100 - winRate).toFixed(1)}%)`, 'RESULT');
        this.log(`📊 Avg Return/Trade: ${avgTradeReturn.toFixed(3)}%`, 'RESULT');
        this.log(`🔄 Trades/Day: ${tradesPerDay.toFixed(2)}`, 'RESULT');
        
        if (this.holdings > 0) {
            this.log(`⚠️ Still holding ${this.holdings.toFixed(6)} ${this.config.symbol} at end of backtest`, 'RESULT');
        }
        
        this.log('=' * 50, 'RESULT');
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
    startDate: '2025-09-18',
    endDate: '2025-09-19',
    initialBalance: 890,
    emaPeriod: 100,
    rsiPeriod: 14,
    rsiEntry: 45,
    tp1Pct: 1.2,
    tp2Pct: 2.0,
    slPct: -1.2,
    feePct: 0.001,
    slippagePct: 0.0005,
    rsiExit1: 80,
    rsiExit2: 85,
    backtest: true,  // Set to false for forward testing
    
    // Trailing Stop Loss Configuration
    enableTrailingStop: true,           // Enable/disable trailing stop
    trailingStopTriggerPct: 1.2,       // Start trailing after 0.8% profit
    trailingStopDistancePct: 1.2,       // Trail 0.4% below highest price
    trailingStopMode: 'replace_tp',           // 'both', 'replace_tp', 'additional'
    
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
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

class FixedCryptoScalper {
    constructor(config = {}) {
        this.config = {
            symbol: config.symbol || 'BTCUSDT',
            timeframe: config.timeframe || '1m',
            startDate: config.startDate || '2025-09-01',
            endDate: config.endDate || '2025-09-19',
            initialBalance: config.initialBalance || 1000,
            
            // More realistic EMA periods
            emaFast: config.emaFast || 12,
            emaMedium: config.emaMedium || 26,
            emaSlow: config.emaSlow || 50,
            
            // RSI parameters
            rsiPeriod: config.rsiPeriod || 14,
            rsiOverbought: config.rsiOverbought || 75,
            rsiOversold: config.rsiOversold || 25,
            
            // IMPROVED: Better risk-reward ratio
            tp1Pct: config.tp1Pct || 1.0,   // 1% profit target
            tp2Pct: config.tp2Pct || 2.0,   // 2% profit target  
            slPct: config.slPct || -0.5,    // 0.5% stop loss (2:1 risk reward minimum)
            
            // FIXED: More realistic fees and slippage
            makerFeePct: config.makerFeePct || 0.0001,  // 0.01% maker fee
            takerFeePct: config.takerFeePct || 0.0001,  // 0.01% taker fee
            slippagePct: config.slippagePct || 0.0001,  // Minimal slippage for limit orders
            
            // Position sizing
            positionSizePct: config.positionSizePct || 0.95, // Use 95% of available balance
            
            // Risk management
            maxDailyLoss: config.maxDailyLoss || -3,
            cooldownPeriod: config.cooldownPeriod || 5, // 5 candles cooldown after loss
            
            backtest: config.backtest || false
        };
        
        this.balance = this.config.initialBalance;
        this.position = null;
        this.wins = 0;
        this.losses = 0;
        this.totalPnL = 0;
        this.trades = [];
        this.priceData = [];
        this.ws = null;
        this.lastTradeCandle = -1;
        this.cooldownCounter = 0;
        
        console.log('🔧 FIXED Bot Configuration:');
        console.log(`Risk-Reward: ${Math.abs(this.config.tp1Pct / this.config.slPct).toFixed(1)}:1`);
        console.log(`Fees: Maker ${this.config.makerFeePct * 100}%, Taker ${this.config.takerFeePct * 100}%`);
    }

    // Simple but effective EMA calculation
    calculateEMA(data, period) {
        if (data.length < period) return data.map(() => null);
        
        const ema = [];
        const multiplier = 2 / (period + 1);
        
        // Start with simple average
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += data[i];
            ema[i] = null;
        }
        ema[period - 1] = sum / period;
        
        // Calculate EMA
        for (let i = period; i < data.length; i++) {
            ema[i] = (data[i] * multiplier) + (ema[i - 1] * (1 - multiplier));
        }
        
        return ema;
    }

    // RSI calculation
    calculateRSI(data, period = 14) {
        if (data.length < period + 1) return data.map(() => null);
        
        const rsi = [];
        let gains = 0;
        let losses = 0;

        // Calculate initial average gain/loss
        for (let i = 1; i <= period; i++) {
            const change = data[i] - data[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;
        
        // Fill initial values with null
        for (let i = 0; i < period; i++) {
            rsi[i] = null;
        }

        rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

        // Calculate remaining RSI values
        for (let i = period + 1; i < data.length; i++) {
            const change = data[i] - data[i - 1];
            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;

            avgGain = ((avgGain * (period - 1)) + gain) / period;
            avgLoss = ((avgLoss * (period - 1)) + loss) / period;

            rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
        }

        return rsi;
    }

    // FIXED: Proper entry logic with confluence
    shouldBuy(price, indicators, candle) {
        const { emaFast, emaMedium, emaSlow, rsi } = indicators;
        
        // Prevent overtrading - cooldown period
        if (this.cooldownCounter > 0) {
            this.cooldownCounter--;
            return false;
        }
        
        // Strong trend confirmation required
        const strongUptrend = emaFast > emaMedium && emaMedium > emaSlow;
        const crossover = emaFast > emaMedium; // At minimum, fast above medium
        
        // RSI in favorable range (not overbought, ideally oversold recovery)
        const rsiGood = rsi > this.config.rsiOversold && rsi < 60;
        
        // Price above key EMA
        const priceAboveEMA = price > emaMedium;
        
        // ALL conditions must be met for entry
        return strongUptrend && rsiGood && priceAboveEMA && !this.position;
    }

    // FIXED: Proper exit logic
    shouldSell(price, indicators) {
        if (!this.position) return null;
        
        const entryPrice = this.position.entryPrice;
        const changePct = ((price - entryPrice) / entryPrice) * 100;
        const { rsi, emaFast, emaMedium } = indicators;
        
        // Stop loss - ALWAYS respect it
        if (changePct <= this.config.slPct) {
            return { reason: 'Stop Loss', changePct };
        }
        
        // Take profit levels
        if (changePct >= this.config.tp2Pct) {
            return { reason: 'TP2', changePct };
        }
        
        if (changePct >= this.config.tp1Pct) {
            return { reason: 'TP1', changePct };
        }
        
        // Trend reversal exit (protect profits)
        if (changePct > 0.2 && emaFast < emaMedium) {
            return { reason: 'Trend Reversal', changePct };
        }
        
        // RSI overbought exit (if in profit)
        if (changePct > 0.3 && rsi >= this.config.rsiOverbought) {
            return { reason: 'RSI Overbought', changePct };
        }
        
        return null;
    }

    // FIXED: Accurate fee calculation
    calculateTradingCost(price, quantity, isMaker = false) {
        const feeRate = isMaker ? this.config.makerFeePct : this.config.takerFeePct;
        const tradeCost = price * quantity;
        const fee = tradeCost * feeRate;
        const slippage = tradeCost * this.config.slippagePct;
        return fee + slippage;
    }

    // FIXED: Proper position management
    openPosition(price, candle) {
        if (this.position) return;
        
        // Calculate position size based on available balance
        const availableBalance = this.balance;
        const positionValue = availableBalance * this.config.positionSizePct;
        const quantity = positionValue / price;
        
        // Calculate entry cost (fees + slippage)
        const entryCost = this.calculateTradingCost(price, quantity, false);
        const totalCost = positionValue + entryCost;
        
        // Check if we have enough balance
        if (totalCost > this.balance) {
            console.log(`⚠️ Insufficient balance for trade: Need $${totalCost.toFixed(2)}, Have $${this.balance.toFixed(2)}`);
            return;
        }
        
        this.position = {
            entryPrice: price,
            quantity: quantity,
            entryTime: new Date().toISOString(),
            entryCost: entryCost,
            candle: candle
        };
        
        this.balance -= totalCost;
        this.lastTradeCandle = candle;
        
        console.log(`🟢 BUY: ${quantity.toFixed(6)} ${this.config.symbol} at $${price.toFixed(4)} | Cost: $${totalCost.toFixed(2)} | Balance: $${this.balance.toFixed(2)}`);
    }

    // FIXED: Proper position closing
    closePosition(price, reason, candle) {
        if (!this.position) return;
        
        const { entryPrice, quantity, entryCost } = this.position;
        
        // Calculate exit value
        const exitValue = quantity * price;
        const exitCost = this.calculateTradingCost(price, quantity, false);
        const netExitValue = exitValue - exitCost;
        
        // Calculate P&L
        const grossPnL = exitValue - (quantity * entryPrice);
        const netPnL = grossPnL - entryCost - exitCost;
        const pnlPct = (netPnL / (quantity * entryPrice)) * 100;
        
        // Update balance
        this.balance += netExitValue;
        this.totalPnL += netPnL;
        
        // Track trade
        const trade = {
            entryPrice: entryPrice,
            exitPrice: price,
            quantity: quantity,
            pnl: netPnL,
            pnlPct: pnlPct,
            reason: reason,
            duration: candle - this.position.candle,
            fees: entryCost + exitCost
        };
        
        this.trades.push(trade);
        
        // Update win/loss counters
        if (netPnL > 0) {
            this.wins++;
            this.cooldownCounter = 0; // No cooldown after win
        } else {
            this.losses++;
            this.cooldownCounter = this.config.cooldownPeriod; // Cooldown after loss
        }
        
        console.log(`🔴 SELL: ${reason} at $${price.toFixed(4)} | P&L: ${pnlPct.toFixed(2)}% ($${netPnL.toFixed(2)}) | Balance: $${this.balance.toFixed(2)}`);
        
        this.position = null;
    }

    // Process market data
    processCandle(price, candle) {
        // Add to price history
        this.priceData.push(price);
        
        // Keep reasonable history length
        const maxLength = Math.max(this.config.emaSlow, 100);
        if (this.priceData.length > maxLength) {
            this.priceData = this.priceData.slice(-maxLength);
        }
        
        // Need enough data for indicators
        if (this.priceData.length < this.config.emaSlow) {
            return;
        }
        
        // Calculate indicators
        const emaFastValues = this.calculateEMA(this.priceData, this.config.emaFast);
        const emaMediumValues = this.calculateEMA(this.priceData, this.config.emaMedium);
        const emaSlowValues = this.calculateEMA(this.priceData, this.config.emaSlow);
        const rsiValues = this.calculateRSI(this.priceData, this.config.rsiPeriod);
        
        const lastIndex = this.priceData.length - 1;
        const indicators = {
            emaFast: emaFastValues[lastIndex],
            emaMedium: emaMediumValues[lastIndex],
            emaSlow: emaSlowValues[lastIndex],
            rsi: rsiValues[lastIndex]
        };
        
        // Check if all indicators are ready
        if (!indicators.emaFast || !indicators.emaMedium || !indicators.emaSlow || !indicators.rsi) {
            return;
        }
        
        // Check daily loss limit
        const currentValue = this.balance + (this.position ? this.position.quantity * price : 0);
        const dailyPnL = ((currentValue - this.config.initialBalance) / this.config.initialBalance) * 100;
        
        if (dailyPnL <= this.config.maxDailyLoss) {
            console.log(`🛑 Daily loss limit reached: ${dailyPnL.toFixed(2)}%`);
            if (this.position) {
                this.closePosition(price, 'Daily Loss Limit', candle);
            }
            return;
        }
        
        // Trading logic
        if (this.shouldBuy(price, indicators, candle)) {
            this.openPosition(price, candle);
        } else {
            const sellSignal = this.shouldSell(price, indicators);
            if (sellSignal) {
                this.closePosition(price, sellSignal.reason, candle);
            }
        }
        
        // Periodic status update (every 100 candles)
        if (candle % 100 === 0) {
            const totalTrades = this.wins + this.losses;
            const winRate = totalTrades > 0 ? (this.wins / totalTrades) * 100 : 0;
            const currentROI = ((currentValue - this.config.initialBalance) / this.config.initialBalance) * 100;
            
            console.log(`📊 Candle ${candle} | Price: $${price.toFixed(2)} | Balance: $${this.balance.toFixed(2)} | ROI: ${currentROI.toFixed(2)}% | Trades: ${totalTrades} | Win Rate: ${winRate.toFixed(1)}%`);
        }
    }

    // Get historical data from Binance REST API
    async getHistoricalData() {
        const symbol = this.config.symbol.toUpperCase();
        const interval = this.config.timeframe;
        const startTime = new Date(this.config.startDate).getTime();
        const endTime = new Date(this.config.endDate).getTime();
        
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
        
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

    // Run backtest
    async runBacktest() {
        console.log('📊 Starting FIXED backtest...');
        const data = await this.getHistoricalData();
        
        if (data.length === 0) {
            console.error('No historical data available');
            return;
        }

        console.log(`📈 Loaded ${data.length} candles for ${this.config.symbol}`);
        
        // Process each candle
        for (let i = 0; i < data.length; i++) {
            this.processCandle(data[i].close, i);
        }

        // Close any remaining position
        if (this.position) {
            const finalPrice = data[data.length - 1].close;
            this.closePosition(finalPrice, 'Backtest End', data.length - 1);
        }

        // Calculate detailed results
        const finalBalance = this.balance;
        const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;
        const totalTrades = this.wins + this.losses;
        const winRate = totalTrades > 0 ? (this.wins / totalTrades) * 100 : 0;
        
        // Calculate additional metrics
        const avgWin = this.trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / (this.wins || 1);
        const avgLoss = Math.abs(this.trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0)) / (this.losses || 1);
        const profitFactor = avgWin / (avgLoss || 1) * (this.wins / (this.losses || 1));
        const totalFees = this.trades.reduce((sum, t) => sum + t.fees, 0);
        
        console.log('\n📋 FIXED BACKTEST RESULTS:');
        console.log('=====================================');
        console.log(`Initial Balance: $${this.config.initialBalance.toFixed(2)}`);
        console.log(`Final Balance: $${finalBalance.toFixed(2)}`);
        console.log(`Net P&L: $${(finalBalance - this.config.initialBalance).toFixed(2)}`);
        console.log(`ROI: ${roi.toFixed(2)}%`);
        console.log(`Total Trades: ${totalTrades}`);
        console.log(`Wins: ${this.wins} | Losses: ${this.losses}`);
        console.log(`Win Rate: ${winRate.toFixed(1)}%`);
        console.log(`Average Win: $${avgWin.toFixed(2)}`);
        console.log(`Average Loss: $${avgLoss.toFixed(2)}`);
        console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
        console.log(`Total Fees Paid: $${totalFees.toFixed(2)}`);
        console.log(`Risk-Reward Ratio: ${Math.abs(this.config.tp1Pct / this.config.slPct).toFixed(1)}:1`);
        
        if (totalTrades > 0) {
            const avgHoldTime = this.trades.reduce((sum, t) => sum + t.duration, 0) / totalTrades;
            console.log(`Average Hold Time: ${avgHoldTime.toFixed(1)} candles`);
            console.log(`Trades per Day: ${(totalTrades / ((new Date(this.config.endDate) - new Date(this.config.startDate)) / (1000 * 60 * 60 * 24))).toFixed(1)}`);
        }
        
        // Show recent trades
        if (this.trades.length > 0) {
            console.log('\n🔄 Last 5 Trades:');
            this.trades.slice(-5).forEach((trade, i) => {
                console.log(`${i + 1}. ${trade.reason}: ${trade.pnlPct.toFixed(2)}% ($${trade.pnl.toFixed(2)}) - Fees: $${trade.fees.toFixed(3)}`);
            });
        }
    }

    // Start forward testing with WebSocket
    startForwardTest() {
        console.log('🚀 Starting FIXED forward test...');
        
        const symbol = this.config.symbol.toLowerCase();
        const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@kline_${this.config.timeframe}`;
        
        this.ws = new WebSocket(wsUrl);
        let candleCount = 0;
        
        this.ws.on('open', () => {
            console.log(`📡 Connected to Binance WebSocket for ${this.config.symbol}`);
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data);
            const kline = message.k;
            
            if (kline.x) { // Only process completed candles
                const price = parseFloat(kline.c);
                this.processCandle(price, candleCount++);
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
            
            // Close any open position
            if (this.position && this.priceData.length > 0) {
                const lastPrice = this.priceData[this.priceData.length - 1];
                this.closePosition(lastPrice, 'Shutdown', candleCount);
            }
            
            const finalBalance = this.balance;
            const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;
            const totalTrades = this.wins + this.losses;
            const winRate = totalTrades > 0 ? (this.wins / totalTrades) * 100 : 0;
            
            console.log('\n📋 FORWARD TEST RESULTS:');
            console.log(`Final Balance: $${finalBalance.toFixed(2)}`);
            console.log(`ROI: ${roi.toFixed(2)}%`);
            console.log(`Total Trades: ${totalTrades}`);
            console.log(`Wins: ${this.wins} | Losses: ${this.losses}`);
            console.log(`Win Rate: ${winRate.toFixed(1)}%`);
            
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

// FIXED Configuration with proper risk management
const config = {
    symbol: 'AVAXUSDT',
    timeframe: '3m',  // 3-minute for better signal quality
    startDate: '2025-09-01',
    endDate: '2025-09-02',
    initialBalance: 1000,
    
    // Proper EMA periods for trend detection
    emaFast: 12,
    emaMedium: 26,
    emaSlow: 50,
    
    // Standard RSI settings
    rsiPeriod: 14,
    rsiOverbought: 75,
    rsiOversold: 35,
    
    // FIXED: Proper risk-reward ratio (2:1 minimum)
    tp1Pct: 1.2,     // 1% profit target
    tp2Pct: 2.0,     // 2% profit target
    slPct: -0.5,     // 0.5% stop loss = 2:1 risk-reward
    
    // REALISTIC fees (Binance spot trading)
    makerFeePct: 0.001,   // 0.01% maker fee (with BNB discount)
    takerFeePct: 0.001,   // 0.01% taker fee (with BNB discount)
    slippagePct: 0.0001,   // Minimal slippage with limit orders
    
    // Position sizing - use 95% of balance per trade
    positionSizePct: 0.95,
    
    // Risk management
    maxDailyLoss: -3,      // Stop at 3% daily loss
    cooldownPeriod: 5,     // Wait 5 candles after loss
    
    backtest: true
};

console.log('🔧 FIXED Crypto Trading Bot');
console.log('===========================');
console.log('Key Fixes Applied:');
console.log('✅ Proper risk-reward ratio (2:1)');
console.log('✅ Realistic fees and slippage');
console.log('✅ Accurate P&L calculation');
console.log('✅ Better entry/exit conditions');
console.log('✅ Position sizing optimization');
console.log('✅ Cooldown after losses');
console.log('===========================\n');

const bot = new FixedCryptoScalper(config);
bot.run().catch(console.error);
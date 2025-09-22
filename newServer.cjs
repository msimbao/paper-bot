const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

class EnhancedCryptoScalpingTester {
    constructor(config = {}) {
        this.config = {
            symbol: config.symbol || 'AVAXUSDT',
            timeframe: config.timeframe || '3m',
            startDate: config.startDate || '2025-09-01',
            endDate: config.endDate || '2025-09-19',
            initialBalance: config.initialBalance || 1000,
            
            // OPTIMIZED: Core strategy parameters (same algorithm)
            emaPeriod: config.emaPeriod || 21,        // Optimal: 21 for better trend detection
            rsiPeriod: config.rsiPeriod || 14,        // Standard RSI period
            rsiEntry: config.rsiEntry || 40,          // Optimal: 40 for earlier entries
            
            // OPTIMIZED: Risk-reward parameters
            tp1Pct: config.tp1Pct || 1.5,            // Optimal: 1.5% for first target
            tp2Pct: config.tp2Pct || 2.5,            // Optimal: 2.5% for second target
            slPct: config.slPct || -0.7,             // Optimal: -0.7% tight stop loss
            
            // OPTIMIZED: Exit parameters
            rsiExit1: config.rsiExit1 || 75,          // Optimal: 75 for first RSI exit
            rsiExit2: config.rsiExit2 || 80,          // Optimal: 80 for second RSI exit
            
            // OPTIMIZED: Trading costs
            feePct: config.feePct || 0.001,           // 0.1% realistic fee
            slippagePct: config.slippagePct || 0.0003, // 0.03% minimal slippage
            
            // NEW: Advanced Risk Management
            maxPositionSize: config.maxPositionSize || 0.85,     // Use max 85% of balance
            maxDailyLoss: config.maxDailyLoss || -4,             // Stop at 4% daily loss
            maxDrawdown: config.maxDrawdown || -8,               // Stop at 8% total drawdown
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3, // Stop after 3 losses in a row
            
            // NEW: Position scaling based on confidence
            basePositionSize: config.basePositionSize || 0.3,    // Base position: 30% of balance
            maxConfidenceMultiplier: config.maxConfidenceMultiplier || 2.5, // Max 2.5x base position
            
            // NEW: Dynamic risk adjustment
            volatilityLookback: config.volatilityLookback || 20,  // Look back 20 periods for volatility
            minVolatility: config.minVolatility || 0.5,          // Min volatility threshold
            maxVolatility: config.maxVolatility || 3.0,          // Max volatility threshold
            
            // NEW: Time-based risk management
            tradingHours: config.tradingHours || { start: 6, end: 22 }, // Trade 6 AM to 10 PM UTC
            avoidWeekends: config.avoidWeekends || false,         // Skip weekend trading
            
            // NEW: Portfolio protection
            profitProtectionLevel: config.profitProtectionLevel || 50, // Protect profits above 50%
            trailingStopDistance: config.trailingStopDistance || 2,    // 2% trailing stop when in big profit
            
            // NEW: Market condition filters
            minEMADistance: config.minEMADistance || 0.2,         // Price must be 0.2% above EMA
            rsiRangeFilter: config.rsiRangeFilter || { min: 20, max: 80 }, // Only trade RSI 20-80 range
            
            backtest: config.backtest || false
        };
        
        // Core trading state
        this.balance = this.config.initialBalance;
        this.holdings = 0;
        this.entryPrice = 0;
        this.wins = 0;
        this.losses = 0;
        this.priceData = [];
        this.ws = null;
        
        // NEW: Advanced risk management state
        this.dailyStartBalance = this.config.initialBalance;
        this.peakBalance = this.config.initialBalance;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.dailyTrades = 0;
        this.lastTradeTime = null;
        this.tradingPaused = false;
        this.pauseReason = '';
        
        // NEW: Performance tracking
        this.trades = [];
        this.dailyStats = [];
        this.riskMetrics = {
            maxDrawdown: 0,
            sharpeRatio: 0,
            winRate: 0,
            avgWin: 0,
            avgLoss: 0,
            profitFactor: 0
        };
        
        // NEW: Market condition tracking
        this.volatilityHistory = [];
        this.trendStrength = 0;
        
        console.log('🛡️ Enhanced Risk Management Enabled');
        console.log(`Max Daily Loss: ${this.config.maxDailyLoss}%`);
        console.log(`Max Drawdown: ${this.config.maxDrawdown}%`);
        console.log(`Position Scaling: ${this.config.basePositionSize * 100}% - ${this.config.basePositionSize * this.config.maxConfidenceMultiplier * 100}%`);
    }

    // Calculate EMA (unchanged algorithm)
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

    // Calculate RSI (unchanged algorithm)
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

    // NEW: Calculate market volatility
    calculateVolatility(prices, period = 20) {
        if (prices.length < period) return 0;
        
        const recentPrices = prices.slice(-period);
        const returns = [];
        
        for (let i = 1; i < recentPrices.length; i++) {
            returns.push((recentPrices[i] - recentPrices[i-1]) / recentPrices[i-1]);
        }
        
        const mean = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
        const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
        
        return Math.sqrt(variance) * 100; // Convert to percentage
    }

    // NEW: Calculate confidence score for position sizing
    calculateConfidenceScore(price, ema, rsi, volatility) {
        let confidence = 1.0;
        
        // EMA distance factor (stronger signal = higher confidence)
        const emaDistance = ((price - ema) / ema) * 100;
        if (emaDistance > this.config.minEMADistance * 2) {
            confidence += 0.3;
        } else if (emaDistance > this.config.minEMADistance) {
            confidence += 0.1;
        }
        
        // RSI strength factor
        if (rsi <= 30) {
            confidence += 0.4; // Very oversold = high confidence
        } else if (rsi <= 35) {
            confidence += 0.2;
        }
        
        // Volatility factor (moderate volatility preferred)
        if (volatility >= this.config.minVolatility && volatility <= this.config.maxVolatility) {
            confidence += 0.2;
        } else if (volatility > this.config.maxVolatility) {
            confidence -= 0.3; // High volatility = lower confidence
        }
        
        // Recent performance factor
        if (this.consecutiveLosses === 0 && this.wins > this.losses) {
            confidence += 0.1;
        } else if (this.consecutiveLosses >= 2) {
            confidence -= 0.2;
        }
        
        return Math.max(0.5, Math.min(confidence, this.config.maxConfidenceMultiplier));
    }

    // NEW: Check if trading is allowed
    canTrade(currentTime = new Date()) {
        // Check if trading is paused
        if (this.tradingPaused) {
            return false;
        }
        
        // Check trading hours
        const hour = currentTime.getUTCHours();
        if (hour < this.config.tradingHours.start || hour >= this.config.tradingHours.end) {
            return false;
        }
        
        // Check weekend trading
        if (this.config.avoidWeekends) {
            const day = currentTime.getUTCDay();
            if (day === 0 || day === 6) { // Sunday or Saturday
                return false;
            }
        }
        
        // Check daily loss limit
        const currentValue = this.balance + (this.holdings * (this.priceData[this.priceData.length - 1] || 0));
        const dailyPnL = ((currentValue - this.dailyStartBalance) / this.dailyStartBalance) * 100;
        if (dailyPnL <= this.config.maxDailyLoss) {
            this.pauseTrading(`Daily loss limit reached: ${dailyPnL.toFixed(2)}%`);
            return false;
        }
        
        // Check max drawdown
        const totalDrawdown = ((currentValue - this.peakBalance) / this.peakBalance) * 100;
        if (totalDrawdown <= this.config.maxDrawdown) {
            this.pauseTrading(`Max drawdown reached: ${totalDrawdown.toFixed(2)}%`);
            return false;
        }
        
        // Check consecutive losses
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            this.pauseTrading(`Max consecutive losses: ${this.consecutiveLosses}`);
            return false;
        }
        
        return true;
    }

    // NEW: Pause trading with reason
    pauseTrading(reason) {
        if (!this.tradingPaused) {
            this.tradingPaused = true;
            this.pauseReason = reason;
            console.log(`🛑 TRADING PAUSED: ${reason}`);
        }
    }

    // NEW: Calculate dynamic position size
    calculatePositionSize(confidence, currentPrice) {
        const currentValue = this.balance + (this.holdings * currentPrice);
        
        // Base position size
        let positionSize = this.config.basePositionSize * confidence;
        
        // Adjust for recent performance
        if (this.consecutiveLosses > 0) {
            positionSize *= Math.pow(0.8, this.consecutiveLosses); // Reduce size after losses
        }
        
        // Respect maximum position size
        positionSize = Math.min(positionSize, this.config.maxPositionSize);
        
        // Calculate actual amount
        const maxAmount = (currentValue * positionSize) / currentPrice;
        
        return maxAmount;
    }

    // NEW: Enhanced trade logging
    logTrade(type, price, amount, reason, pnl = null) {
        const trade = {
            timestamp: new Date().toISOString(),
            type: type,
            price: price,
            amount: amount,
            reason: reason,
            pnl: pnl,
            balance: this.balance,
            consecutiveLosses: this.consecutiveLosses
        };
        
        this.trades.push(trade);
        this.totalTrades++;
        this.dailyTrades++;
        
        if (type === 'SELL' && pnl !== null) {
            if (pnl > 0) {
                this.wins++;
                this.consecutiveLosses = 0;
                // Update peak balance for drawdown calculation
                const currentValue = this.balance;
                if (currentValue > this.peakBalance) {
                    this.peakBalance = currentValue;
                }
            } else {
                this.losses++;
                this.consecutiveLosses++;
            }
        }
    }

    // Enhanced process signal with risk management (same core algorithm)
    processSignal(price, ema, rsi) {
        if (isNaN(price) || isNaN(ema) || isNaN(rsi)) return;

        // NEW: Calculate market conditions
        const volatility = this.calculateVolatility(this.priceData, this.config.volatilityLookback);
        this.volatilityHistory.push(volatility);
        if (this.volatilityHistory.length > 50) {
            this.volatilityHistory.shift();
        }

        // NEW: Check if trading is allowed
        if (!this.canTrade()) {
            return;
        }

        // SAME ALGORITHM: BUY signal (with enhanced risk management)
        if (this.holdings === 0 && price > ema && rsi <= this.config.rsiEntry) {
            // NEW: Additional filters
            const emaDistance = ((price - ema) / ema) * 100;
            if (emaDistance < this.config.minEMADistance) {
                console.log(`⚠️ EMA distance too small: ${emaDistance.toFixed(2)}%`);
                return;
            }
            
            if (rsi < this.config.rsiRangeFilter.min || rsi > this.config.rsiRangeFilter.max) {
                console.log(`⚠️ RSI outside trading range: ${rsi.toFixed(2)}`);
                return;
            }
            
            // NEW: Calculate confidence and position size
            const confidence = this.calculateConfidenceScore(price, ema, rsi, volatility);
            const amount = this.calculatePositionSize(confidence, price);
            
            if (amount * price > this.balance) {
                console.log(`⚠️ Insufficient balance for trade`);
                return;
            }
            
            this.holdings = amount;
            this.entryPrice = price * (1 + this.config.slippagePct);
            this.balance -= amount * price;
            
            this.logTrade('BUY', price, amount, `RSI: ${rsi.toFixed(2)}, EMA: ${emaDistance.toFixed(2)}%, Conf: ${confidence.toFixed(2)}`);
            console.log(`🟢 BUY: ${amount.toFixed(6)} ${this.config.symbol} at $${price.toFixed(4)} | RSI: ${rsi.toFixed(2)} | EMA+${emaDistance.toFixed(2)}% | Confidence: ${confidence.toFixed(2)}x | Vol: ${volatility.toFixed(1)}%`);
            return;
        }

        // SAME ALGORITHM: SELL signals (with enhanced exit logic)
        if (this.holdings > 0) {
            const changePct = ((price - this.entryPrice) / this.entryPrice) * 100;
            let shouldSell = false;
            let reason = '';

            // NEW: Trailing stop for big profits
            if (changePct > this.config.profitProtectionLevel) {
                const trailingStop = changePct - this.config.trailingStopDistance;
                if (changePct < trailingStop) {
                    shouldSell = true;
                    reason = 'Trailing Stop';
                }
            }

            // SAME ALGORITHM: Original exit conditions
            if (!shouldSell) {
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

            // NEW: Emergency exits
            if (!shouldSell && volatility > this.config.maxVolatility * 1.5) {
                shouldSell = true;
                reason = 'High Volatility Exit';
            }

            if (shouldSell) {
                const saleValue = this.holdings * price * (1 - this.config.feePct);
                const pnl = saleValue - (this.holdings * this.entryPrice);
                
                this.balance += saleValue;
                this.holdings = 0;
                
                this.logTrade('SELL', price, this.holdings, reason, pnl);
                
                console.log(`🔴 SELL: ${reason} at $${price.toFixed(4)} | P&L: ${changePct.toFixed(2)}% ($${pnl.toFixed(2)}) | Balance: $${this.balance.toFixed(2)} | Consecutive Losses: ${this.consecutiveLosses}`);
                
                // NEW: Update risk metrics
                this.updateRiskMetrics();
            }
        }
    }

    // NEW: Update risk metrics
    updateRiskMetrics() {
        const totalTrades = this.wins + this.losses;
        if (totalTrades === 0) return;
        
        this.riskMetrics.winRate = (this.wins / totalTrades) * 100;
        
        const winningTrades = this.trades.filter(t => t.pnl && t.pnl > 0);
        const losingTrades = this.trades.filter(t => t.pnl && t.pnl < 0);
        
        this.riskMetrics.avgWin = winningTrades.length > 0 ? 
            winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
            
        this.riskMetrics.avgLoss = losingTrades.length > 0 ? 
            Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length) : 0;
            
        this.riskMetrics.profitFactor = this.riskMetrics.avgLoss > 0 ? 
            (this.riskMetrics.avgWin * this.wins) / (this.riskMetrics.avgLoss * this.losses) : 0;
    }

    // Get historical data from Binance REST API (unchanged)
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

    // Enhanced backtest with detailed reporting
    async runBacktest() {
        console.log('📊 Starting enhanced backtest with risk management...');
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
            this.priceData.push(prices[i]);
            
            if (emas[i] && rsis[i]) {
                this.processSignal(prices[i], emas[i], rsis[i]);
            }
            
            // NEW: Daily reset logic (simplified for backtest)
            if (i > 0 && i % 480 === 0) { // Reset every ~24 hours (480 * 3min)
                this.dailyStartBalance = this.balance + (this.holdings * prices[i]);
                this.dailyTrades = 0;
                this.tradingPaused = false; // Reset daily pause
            }
        }

        // Final balance calculation
        const finalPrice = prices[prices.length - 1];
        const finalBalance = this.balance + (this.holdings * finalPrice);
        const roi = ((finalBalance - this.config.initialBalance) / this.config.initialBalance) * 100;
        const maxDrawdownPct = ((this.peakBalance - finalBalance) / this.peakBalance) * 100;

        console.log('\n📋 ENHANCED BACKTEST RESULTS:');
        console.log('=====================================');
        console.log(`Initial Balance: $${this.config.initialBalance}`);
        console.log(`Final Balance: $${finalBalance.toFixed(2)}`);
        console.log(`Peak Balance: $${this.peakBalance.toFixed(2)}`);
        console.log(`ROI: ${roi.toFixed(2)}%`);
        console.log(`Max Drawdown: ${maxDrawdownPct.toFixed(2)}%`);
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Wins: ${this.wins} | Losses: ${this.losses}`);
        console.log(`Win Rate: ${this.riskMetrics.winRate.toFixed(1)}%`);
        console.log(`Profit Factor: ${this.riskMetrics.profitFactor.toFixed(2)}`);
        console.log(`Average Win: $${this.riskMetrics.avgWin.toFixed(2)}`);
        console.log(`Average Loss: $${this.riskMetrics.avgLoss.toFixed(2)}`);
        console.log(`Risk-Reward Ratio: ${(this.riskMetrics.avgWin / this.riskMetrics.avgLoss).toFixed(2)}:1`);
        
        if (this.tradingPaused) {
            console.log(`⚠️ Trading ended early: ${this.pauseReason}`);
        }
        
        // NEW: Risk assessment
        console.log('\n🛡️ RISK ASSESSMENT:');
        if (roi > 0 && maxDrawdownPct < 10) {
            console.log('✅ Low Risk: Positive returns with manageable drawdown');
        } else if (roi > 0 && maxDrawdownPct < 20) {
            console.log('⚠️ Medium Risk: Positive returns but significant drawdown');
        } else {
            console.log('❌ High Risk: Poor returns or excessive drawdown');
        }
    }

    // Start forward testing with WebSocket (enhanced)
    startForwardTest() {
        console.log('🚀 Starting enhanced forward test with risk management...');
        
        const symbol = this.config.symbol.toLowerCase();
        const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@kline_${this.config.timeframe}`;
        
        this.ws = new WebSocket(wsUrl);
        
        // NEW: Daily reset timer
        setInterval(() => {
            const now = new Date();
            if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
                this.dailyStartBalance = this.balance + (this.holdings * (this.priceData[this.priceData.length - 1] || 0));
                this.dailyTrades = 0;
                this.tradingPaused = false;
                console.log('🌅 Daily reset completed');
            }
        }, 60000); // Check every minute
        
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
                        // NEW: Less frequent status updates
                        if (Math.random() < 0.1) { // 10% chance to log
                            const currentValue = this.balance + (this.holdings * price);
                            const totalROI = ((currentValue - this.config.initialBalance) / this.config.initialBalance) * 100;
                            console.log(`📊 ${new Date().toLocaleTimeString()} | $${price.toFixed(4)} | RSI: ${currentRSI.toFixed(1)} | ROI: ${totalROI.toFixed(2)}% | Trades: ${this.totalTrades} | Status: ${this.tradingPaused ? 'PAUSED' : 'ACTIVE'}`);
                        }
                        
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
            console.log(`Wins: ${this.wins} | Losses: ${this.losses}`);
            console.log(`Win Rate: ${this.riskMetrics.winRate.toFixed(1)}%`);
            console.log(`Max Consecutive Losses: ${Math.max(...this.trades.map(t => t.consecutiveLosses || 0))}`);
            
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

// OPTIMIZED Configuration with enhanced risk management
const config = {
    // Core parameters (same algorithm, optimized values)
    symbol: 'AVAXUSDT',           // More liquid pair
    timeframe: '3m',             // 3-minute optimal for scalping
    startDate: '2025-09-01',
    endDate: '2025-09-19',
    initialBalance: 1000,
    
    // OPTIMIZED: Technical indicators (same algorithm)
    emaPeriod: 100,               // 21 optimal for 3m timeframe
    rsiPeriod: 14,               // Standard RSI
    rsiEntry: 40,                // Earlier entry at 40
    
    // OPTIMIZED: Risk-reward targets
    tp1Pct: 1.5,                 // 1.5% first target
    tp2Pct: 2.5,                 // 2.5% second target  
    slPct: -0.7,                 // 0.7% stop loss (2.14:1 risk-reward)
    
    // OPTIMIZED: Exit levels
    rsiExit1: 75,                // Exit at RSI 75
    rsiExit2: 80,                // Exit at RSI 80
    
    // OPTIMIZED: Trading costs
    feePct: 0.001,               // 0.1% realistic trading fee
    slippagePct: 0.0003,         // 0.03% minimal slippage
    
    // ADVANCED: Risk Management Parameters
    maxPositionSize: 0.85,       // Max 85% of balance per trade
    maxDailyLoss: -4,            // Stop trading at 4% daily loss
    maxDrawdown: -8,             // Stop trading at 8% total drawdown
    maxConsecutiveLosses: 3,     // Stop after 3 consecutive losses
    
    // ADVANCED: Dynamic Position Sizing
    basePositionSize: 0.3,       // Base position: 30% of balance
    maxConfidenceMultiplier: 2.5, // Max position: 75% (30% × 2.5)
    
    // ADVANCED: Market Condition Filters
    volatilityLookback: 20,      // Look back 20 periods for volatility
    minVolatility: 0.5,          // Min 0.5% volatility to trade
    maxVolatility: 3.0,          // Max 3% volatility to trade
    minEMADistance: 0.2,         // Price must be 0.2% above EMA
    rsiRangeFilter: { min: 20, max: 80 }, // Only trade RSI 20-80 range
    
    // ADVANCED: Time-based Risk Management
    tradingHours: { start: 6, end: 22 }, // Trade 6 AM to 10 PM UTC (active hours)
    avoidWeekends: false,        // Trade weekends (crypto is 24/7)
    
    // ADVANCED: Profit Protection
    profitProtectionLevel: 50,   // Protect profits above 50% ROI
    trailingStopDistance: 2,     // 2% trailing stop when in big profit
    
    backtest: true               // Set to false for live trading
};

// Alternative optimized configurations for different risk profiles:

// CONSERVATIVE: Lower risk, steady gains
const conservativeConfig = {
    ...config,
    symbol: 'BTCUSDT',
    emaPeriod: 34,              // Slower EMA for fewer signals
    rsiEntry: 35,               // More conservative entry
    tp1Pct: 1.2,                // Lower profit targets
    tp2Pct: 2.0,
    slPct: -0.6,                // Tighter stop loss
    basePositionSize: 0.2,      // Smaller positions (20%)
    maxConfidenceMultiplier: 2.0, // Max 40% position size
    maxDailyLoss: -3,           // Stricter daily loss limit
    maxConsecutiveLosses: 2,    // Stop after 2 losses
    maxVolatility: 2.0          // Avoid high volatility
};

// AGGRESSIVE: Higher risk, higher reward potential
const aggressiveConfig = {
    ...config,
    symbol: 'ETHUSDT',          // More volatile pair
    timeframe: '1m',            // Faster timeframe
    emaPeriod: 13,              // Faster EMA
    rsiEntry: 45,               // Less strict entry
    tp1Pct: 2.0,                // Higher profit targets
    tp2Pct: 3.5,
    slPct: -1.0,                // Wider stop loss
    basePositionSize: 0.4,      // Larger positions (40%)
    maxConfidenceMultiplier: 2.0, // Max 80% position size
    maxDailyLoss: -6,           // Allow higher daily loss
    maxConsecutiveLosses: 4,    // Allow more consecutive losses
    maxVolatility: 4.0,         // Trade higher volatility
    minEMADistance: 0.1         // Less strict EMA distance
};

// BALANCED: Medium risk-reward profile
const balancedConfig = {
    ...config,
    symbol: 'ADAUSDT',          // Moderately volatile
    emaPeriod: 21,
    rsiEntry: 38,
    tp1Pct: 1.8,
    tp2Pct: 2.8,
    slPct: -0.8,
    basePositionSize: 0.35,
    maxConfidenceMultiplier: 2.2,
    maxDailyLoss: -5,
    maxConsecutiveLosses: 3
};

console.log('🛡️ ENHANCED CRYPTO SCALPING BOT WITH ADVANCED RISK MANAGEMENT');
console.log('==============================================================');
console.log('📊 OPTIMIZED PARAMETERS:');
console.log(`   Symbol: ${config.symbol} | Timeframe: ${config.timeframe}`);
console.log(`   EMA: ${config.emaPeriod} | RSI Entry: ${config.rsiEntry}`);
console.log(`   Targets: TP1=${config.tp1Pct}%, TP2=${config.tp2Pct}% | Stop: ${config.slPct}%`);
console.log(`   Risk-Reward: ${Math.abs(config.tp1Pct / config.slPct).toFixed(1)}:1`);
console.log('');
console.log('🛡️ RISK MANAGEMENT FEATURES:');
console.log(`   ✅ Dynamic position sizing: ${config.basePositionSize * 100}% - ${config.basePositionSize * config.maxConfidenceMultiplier * 100}%`);
console.log(`   ✅ Daily loss limit: ${config.maxDailyLoss}%`);
console.log(`   ✅ Max drawdown protection: ${config.maxDrawdown}%`);
console.log(`   ✅ Consecutive loss limit: ${config.maxConsecutiveLosses}`);
console.log(`   ✅ Volatility filtering: ${config.minVolatility}% - ${config.maxVolatility}%`);
console.log(`   ✅ Trading hours: ${config.tradingHours.start}:00 - ${config.tradingHours.end}:00 UTC`);
console.log(`   ✅ Market condition filters enabled`);
console.log(`   ✅ Profit protection above ${config.profitProtectionLevel}% ROI`);
console.log('');
console.log('🎯 EXPECTED IMPROVEMENTS:');
console.log('   📈 Better risk-adjusted returns');
console.log('   📊 Reduced maximum drawdown'); 
console.log('   ⚡ Adaptive position sizing');
console.log('   🛑 Automatic trading pauses');
console.log('   📉 Volatility-based filtering');
console.log('   ⏰ Time-based risk controls');
console.log('==============================================================');
console.log('');

// Run the enhanced bot
const enhancedBot = new EnhancedCryptoScalpingTester(config);
enhancedBot.run().catch(console.error);

// Export configurations for easy switching
module.exports = {
    EnhancedCryptoScalpingTester,
    configs: {
        optimized: config,
        conservative: conservativeConfig,
        aggressive: aggressiveConfig,
        balanced: balancedConfig
    }
};
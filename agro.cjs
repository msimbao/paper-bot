console.log('='.repeat(60));
  console.log('BACKTEST RESULTS');
  console.log('='.repeat(60));
  console.log(`Total Trades: ${report.totalTrades}`);
  console.log(`Wins: ${report.wins} | Losses: ${report.losses}`);
  console.log(`Win Rate: ${report.winRate}%`);
  console.log(`Gross P&L: ${report.grossPconst axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ============================================
// TECHNICAL INDICATORS
// ============================================

class TechnicalIndicators {
  static standardErrorBands(data, period = 20, multiplier = 2.0) {
    const bands = [];
    
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        bands.push({ upper: null, middle: null, lower: null, angle: 0 });
        continue;
      }
      
      const slice = data.slice(i - period + 1, i + 1);
      const prices = slice.map(d => d.close);
      
      // Linear regression
      const { slope, intercept } = this.linearRegression(prices);
      const middleLine = slope * (period - 1) + intercept;
      
      // Calculate standard error
      const predictions = prices.map((_, idx) => slope * idx + intercept);
      const errors = prices.map((p, idx) => p - predictions[idx]);
      const squaredErrors = errors.map(e => e * e);
      const mse = squaredErrors.reduce((a, b) => a + b, 0) / prices.length;
      const standardError = Math.sqrt(mse);
      
      // Calculate band angle (in degrees)
      const angle = Math.atan(slope / prices[0]) * (180 / Math.PI);
      
      bands.push({
        upper: middleLine + (standardError * multiplier),
        middle: middleLine,
        lower: middleLine - (standardError * multiplier),
        angle: Math.abs(angle),
        width: (standardError * multiplier * 2) / middleLine * 100 // percentage
      });
    }
    
    return bands;
  }
  
  static linearRegression(y) {
    const n = y.length;
    const x = Array.from({ length: n }, (_, i) => i);
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return { slope, intercept };
  }
  
  static atr(data, period = 14) {
    const tr = [];
    
    for (let i = 1; i < data.length; i++) {
      const high = data[i].high;
      const low = data[i].low;
      const prevClose = data[i - 1].close;
      
      const tr1 = high - low;
      const tr2 = Math.abs(high - prevClose);
      const tr3 = Math.abs(low - prevClose);
      
      tr.push(Math.max(tr1, tr2, tr3));
    }
    
    const atrValues = [null];
    let atrSum = tr.slice(0, period).reduce((a, b) => a + b, 0);
    atrValues.push(atrSum / period);
    
    for (let i = period; i < tr.length; i++) {
      const newATR = (atrValues[atrValues.length - 1] * (period - 1) + tr[i]) / period;
      atrValues.push(newATR);
    }
    
    return atrValues;
  }
  
  static adx(data, period = 14) {
    const adxValues = [];
    
    // Calculate +DM and -DM
    const plusDM = [];
    const minusDM = [];
    
    for (let i = 1; i < data.length; i++) {
      const highDiff = data[i].high - data[i - 1].high;
      const lowDiff = data[i - 1].low - data[i].low;
      
      plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
      minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    }
    
    const atr = this.atr(data, period);
    
    // Smooth DM values
    const smoothPlusDM = this.ema([0, ...plusDM], period);
    const smoothMinusDM = this.ema([0, ...minusDM], period);
    
    // Calculate DI+ and DI-
    const plusDI = smoothPlusDM.map((dm, i) => atr[i] ? (dm / atr[i]) * 100 : 0);
    const minusDI = smoothMinusDM.map((dm, i) => atr[i] ? (dm / atr[i]) * 100 : 0);
    
    // Calculate DX
    const dx = plusDI.map((pdi, i) => {
      const sum = pdi + minusDI[i];
      return sum !== 0 ? (Math.abs(pdi - minusDI[i]) / sum) * 100 : 0;
    });
    
    // Calculate ADX (smoothed DX)
    return this.ema(dx, period);
  }
  
  static ema(data, period) {
    const k = 2 / (period + 1);
    const emaValues = [];
    
    for (let i = 0; i < data.length; i++) {
      if (i === 0) {
        emaValues.push(data[i]);
      } else {
        emaValues.push(data[i] * k + emaValues[i - 1] * (1 - k));
      }
    }
    
    return emaValues;
  }
  
  static sma(data, period) {
    const smaValues = [];
    
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1) {
        smaValues.push(null);
      } else {
        const slice = data.slice(i - period + 1, i + 1);
        const avg = slice.reduce((a, b) => a + b, 0) / period;
        smaValues.push(avg);
      }
    }
    
    return smaValues;
  }
  
  static rsi(data, period = 14) {
    const changes = [];
    
    for (let i = 1; i < data.length; i++) {
      changes.push(data[i] - data[i - 1]);
    }
    
    const rsiValues = [null];
    
    for (let i = 0; i < changes.length; i++) {
      if (i < period - 1) {
        rsiValues.push(null);
        continue;
      }
      
      const slice = changes.slice(i - period + 1, i + 1);
      const gains = slice.map(c => c > 0 ? c : 0);
      const losses = slice.map(c => c < 0 ? Math.abs(c) : 0);
      
      const avgGain = gains.reduce((a, b) => a + b, 0) / period;
      const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
      
      if (avgLoss === 0) {
        rsiValues.push(100);
      } else {
        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));
        rsiValues.push(rsi);
      }
    }
    
    return rsiValues;
  }
}

// ============================================
// CACHE MANAGER
// ============================================

class CacheManager {
  constructor(cacheDir = './cache') {
    this.cacheDir = cacheDir;
    this.ensureCacheDir();
  }
  
  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      console.log(`Created cache directory: ${this.cacheDir}`);
    }
  }
  
  generateCacheKey(symbol, interval, startDate, endDate) {
    const keyString = `${symbol}-${interval}-${startDate}-${endDate}`;
    return crypto.createHash('md5').update(keyString).digest('hex');
  }
  
  getCacheFilePath(cacheKey) {
    return path.join(this.cacheDir, `${cacheKey}.json`);
  }
  
  has(symbol, interval, startDate, endDate) {
    const cacheKey = this.generateCacheKey(symbol, interval, startDate, endDate);
    const filePath = this.getCacheFilePath(cacheKey);
    return fs.existsSync(filePath);
  }
  
  get(symbol, interval, startDate, endDate) {
    const cacheKey = this.generateCacheKey(symbol, interval, startDate, endDate);
    const filePath = this.getCacheFilePath(cacheKey);
    
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const cached = JSON.parse(data);
      console.log(`✓ Loaded ${cached.data.length} candles from cache`);
      return cached.data;
    } catch (error) {
      console.error('Error reading cache:', error.message);
      return null;
    }
  }
  
  set(symbol, interval, startDate, endDate, data) {
    const cacheKey = this.generateCacheKey(symbol, interval, startDate, endDate);
    const filePath = this.getCacheFilePath(cacheKey);
    
    const cacheData = {
      symbol,
      interval,
      startDate,
      endDate,
      cachedAt: new Date().toISOString(),
      dataPoints: data.length,
      data
    };
    
    try {
      fs.writeFileSync(filePath, JSON.stringify(cacheData, null, 2));
      console.log(`✓ Cached ${data.length} candles to ${filePath}`);
    } catch (error) {
      console.error('Error writing cache:', error.message);
    }
  }
  
  clear() {
    if (!fs.existsSync(this.cacheDir)) return;
    
    const files = fs.readdirSync(this.cacheDir);
    files.forEach(file => {
      fs.unlinkSync(path.join(this.cacheDir, file));
    });
    console.log(`Cleared ${files.length} cache files`);
  }
  
  list() {
    if (!fs.existsSync(this.cacheDir)) return [];
    
    const files = fs.readdirSync(this.cacheDir);
    return files.map(file => {
      const filePath = path.join(this.cacheDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return {
        file,
        symbol: data.symbol,
        interval: data.interval,
        startDate: data.startDate,
        endDate: data.endDate,
        dataPoints: data.dataPoints,
        cachedAt: data.cachedAt
      };
    });
  }
}

// ============================================
// BINANCE DATA FETCHER
// ============================================

class BinanceDataFetcher {
  constructor(symbol = 'BTCUSDT', interval = '2m') {
    this.baseURL = 'https://api.binance.com';
    this.symbol = symbol;
    this.interval = interval;
    this.cache = new CacheManager();
  }
  
  async fetchKlines(startTime, endTime, limit = 1000) {
    try {
      const response = await axios.get(`${this.baseURL}/api/v3/klines`, {
        params: {
          symbol: this.symbol,
          interval: this.interval,
          startTime,
          endTime,
          limit
        }
      });
      
      return response.data.map(k => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));
    } catch (error) {
      console.error('Error fetching data:', error.message);
      return [];
    }
  }
  
  async fetchHistoricalData(startDate, endDate, useCache = true) {
    // Check cache first
    if (useCache && this.cache.has(this.symbol, this.interval, startDate, endDate)) {
      console.log('Loading data from cache...');
      return this.cache.get(this.symbol, this.interval, startDate, endDate);
    }
    
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    const allData = [];
    
    const intervalMs = this.getIntervalMs();
    const chunkSize = 1000;
    
    let currentStart = start;
    
    console.log(`Fetching data from ${startDate} to ${endDate}...`);
    
    while (currentStart < end) {
      const currentEnd = Math.min(currentStart + (chunkSize * intervalMs), end);
      
      console.log(`Fetching chunk: ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}`);
      
      const chunk = await this.fetchKlines(currentStart, currentEnd, chunkSize);
      
      if (chunk.length === 0) break;
      
      allData.push(...chunk);
      
      // Move to next chunk
      currentStart = chunk[chunk.length - 1].timestamp + intervalMs;
      
      // Respect rate limits
      await this.sleep(250);
    }
    
    console.log(`Total candles fetched: ${allData.length}`);
    
    // Cache the data
    if (useCache && allData.length > 0) {
      this.cache.set(this.symbol, this.interval, startDate, endDate, allData);
    }
    
    return allData;
  }
  
  getIntervalMs() {
    const intervals = {
      '1m': 60000,
      '2m': 120000,
      '3m': 180000,
      '5m': 300000,
      '15m': 900000,
      '30m': 1800000,
      '1h': 3600000,
      '4h': 14400000,
      '1d': 86400000
    };
    return intervals[this.interval] || 60000;
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================
// TRADING STRATEGY
// ============================================

class SEBScalpingStrategy {
  constructor(config = {}) {
    this.config = {
      sebPeriod: config.sebPeriod || 20,
      sebMultiplier: config.sebMultiplier || 2.0,
      atrPeriod: config.atrPeriod || 14,
      adxPeriod: config.adxPeriod || 14,
      rsiPeriod: config.rsiPeriod || 14,
      
      // Market regime filters
      adxThreshold: config.adxThreshold || 25, // Below this = ranging
      maxBandAngle: config.maxBandAngle || 30, // Degrees
      
      // Dynamic adjustments
      useDynamicBands: config.useDynamicBands !== false,
      atrVolatilityThreshold: config.atrVolatilityThreshold || 1.5,
      
      // Entry filters
      requireRsiDivergence: config.requireRsiDivergence || false,
      minBandPenetration: config.minBandPenetration || 0.1, // Percentage
      
      // Risk management
      takeProfitTarget: config.takeProfitTarget || 'middle', // 'middle' or 'dynamic'
      stopLossMultiplier: config.stopLossMultiplier || 1.0, // ATR multiplier
      partialTakeProfit: config.partialTakeProfit || 0.5, // Take 50% at middle
      useTrailingStop: config.useTrailingStop !== false, // Enable trailing stop
      trailingStopATRMultiplier: config.trailingStopATRMultiplier || 0.5, // ATR multiplier for trailing
      
      // Trading fees
      makerFee: config.makerFee || 0.001, // 0.1% maker fee (Binance default)
      takerFee: config.takerFee || 0.001, // 0.1% taker fee (Binance default)
      
      // Position sizing
      initialCapital: config.initialCapital || 10000,
      riskPerTrade: config.riskPerTrade || 0.01, // 1% risk per trade
      
      // Trading hours (24h format, in UTC)
      tradingHours: config.tradingHours || { start: 0, end: 24 }
    };
    
    this.trades = [];
    this.equity = [this.config.initialCapital];
    this.currentCapital = this.config.initialCapital;
    this.totalFeesPaid = 0;
  }
  
  analyze(data) {
    console.log('Calculating indicators...');
    
    const closes = data.map(d => d.close);
    
    // Calculate all indicators
    const bands = TechnicalIndicators.standardErrorBands(data, this.config.sebPeriod, this.config.sebMultiplier);
    const atr = TechnicalIndicators.atr(data, this.config.atrPeriod);
    const adx = TechnicalIndicators.adx(data, this.config.adxPeriod);
    const rsi = TechnicalIndicators.rsi(closes, this.config.rsiPeriod);
    
    // Calculate average ATR for dynamic adjustments
    const avgATR = TechnicalIndicators.sma(atr.filter(a => a !== null), 50);
    
    return data.map((candle, i) => ({
      ...candle,
      bands: bands[i],
      atr: atr[i],
      adx: adx[i],
      rsi: rsi[i],
      avgATR: avgATR[i - 50 + this.config.atrPeriod] || avgATR[avgATR.length - 1]
    }));
  }
  
  checkMarketRegime(bar) {
    if (!bar.adx || !bar.bands) return 'unknown';
    
    const isRanging = bar.adx < this.config.adxThreshold;
    const bandAngleOk = bar.bands.angle < this.config.maxBandAngle;
    
    // Check volatility
    const volatilityOk = !this.config.useDynamicBands || 
                         (bar.atr && bar.avgATR && bar.atr < bar.avgATR * this.config.atrVolatilityThreshold);
    
    if (isRanging && bandAngleOk && volatilityOk) {
      return 'ranging';
    } else if (!isRanging) {
      return 'trending';
    }
    
    return 'uncertain';
  }
  
  checkTradingHours(timestamp) {
    const date = new Date(timestamp);
    const hour = date.getUTCHours();
    return hour >= this.config.tradingHours.start && hour < this.config.tradingHours.end;
  }
  
  generateSignal(bar, prevBar) {
    if (!bar.bands || !bar.bands.upper || !bar.atr) return null;
    if (!this.checkTradingHours(bar.timestamp)) return null;
    
    const regime = this.checkMarketRegime(bar);
    if (regime !== 'ranging') return null;
    
    const price = bar.close;
    const { upper, middle, lower } = bar.bands;
    
    // Calculate penetration percentage
    const upperPenetration = ((price - upper) / upper) * 100;
    const lowerPenetration = ((lower - price) / lower) * 100;
    
    // Check for short signal (price above upper band)
    if (upperPenetration > this.config.minBandPenetration) {
      // Optional RSI oversold confirmation
      if (this.config.requireRsiDivergence && bar.rsi && bar.rsi < 70) {
        return null;
      }
      
      return {
        type: 'short',
        entry: price,
        stopLoss: upper + (bar.atr * this.config.stopLossMultiplier),
        takeProfit: middle,
        timestamp: bar.timestamp,
        reason: `Upper band breach: ${upperPenetration.toFixed(2)}%`
      };
    }
    
    // Check for long signal (price below lower band)
    if (lowerPenetration > this.config.minBandPenetration) {
      // Optional RSI overbought confirmation
      if (this.config.requireRsiDivergence && bar.rsi && bar.rsi > 30) {
        return null;
      }
      
      return {
        type: 'long',
        entry: price,
        stopLoss: lower - (bar.atr * this.config.stopLossMultiplier),
        takeProfit: middle,
        timestamp: bar.timestamp,
        reason: `Lower band breach: ${lowerPenetration.toFixed(2)}%`
      };
    }
    
    return null;
  }
  
  calculatePositionSize(signal) {
    const riskAmount = this.currentCapital * this.config.riskPerTrade;
    const stopDistance = Math.abs(signal.entry - signal.stopLoss);
    
    if (stopDistance === 0) return 0;
    
    return riskAmount / stopDistance;
  }
  
  backtest(data) {
    console.log('Running backtest...');
    
    const analyzedData = this.analyze(data);
    let openTrade = null;
    
    for (let i = 1; i < analyzedData.length; i++) {
      const bar = analyzedData[i];
      const prevBar = analyzedData[i - 1];
      
      // Manage open trade
      if (openTrade) {
        // Update trailing stop if enabled
        if (this.config.useTrailingStop && bar.atr) {
          this.updateTrailingStop(openTrade, bar);
        }
        
        const exitResult = this.checkExit(openTrade, bar);
        
        if (exitResult) {
          openTrade = this.closeTrade(openTrade, exitResult, bar);
        }
      }
      
      // Look for new trade if no position
      if (!openTrade) {
        const signal = this.generateSignal(bar, prevBar);
        
        if (signal) {
          openTrade = this.openTrade(signal, bar);
        }
      }
      
      // Track equity
      if (openTrade) {
        const unrealizedPnL = this.calculateUnrealizedPnL(openTrade, bar);
        this.equity.push(this.currentCapital + unrealizedPnL);
      } else {
        this.equity.push(this.currentCapital);
      }
    }
    
    // Close any remaining open trade
    if (openTrade) {
      const lastBar = analyzedData[analyzedData.length - 1];
      this.closeTrade(openTrade, { price: lastBar.close, reason: 'End of backtest' }, lastBar);
    }
    
    return this.generateReport();
  }
  
  openTrade(signal, bar) {
    const positionSize = this.calculatePositionSize(signal);
    
    // Calculate entry fee
    const entryValue = signal.entry * positionSize;
    const entryFee = entryValue * this.config.takerFee; // Assume taker fee on entry
    
    const trade = {
      ...signal,
      size: positionSize,
      openTime: bar.timestamp,
      status: 'open',
      partialClosed: false,
      breakeven: false,
      entryFee: entryFee,
      exitFee: 0,
      trailingStopPrice: signal.stopLoss, // Initialize trailing stop
      highestPrice: signal.type === 'long' ? signal.entry : Infinity,
      lowestPrice: signal.type === 'short' ? signal.entry : Infinity
    };
    
    this.currentCapital -= entryFee;
    this.totalFeesPaid += entryFee;
    
    console.log(`OPEN ${trade.type.toUpperCase()} @ ${trade.entry.toFixed(2)} | Size: ${positionSize.toFixed(4)} | Fee: ${entryFee.toFixed(2)} | ${trade.reason}`);
    
    return trade;
  }
  
  updateTrailingStop(trade, bar) {
    const price = bar.close;
    const atr = bar.atr;
    
    if (!atr) return;
    
    if (trade.type === 'long') {
      // Update highest price
      if (price > trade.highestPrice) {
        trade.highestPrice = price;
        
        // Calculate new trailing stop
        const newStop = price - (atr * this.config.trailingStopATRMultiplier);
        
        // Only move stop up, never down
        if (newStop > trade.trailingStopPrice) {
          const oldStop = trade.trailingStopPrice;
          trade.trailingStopPrice = newStop;
          trade.stopLoss = newStop; // Update the actual stop loss
          
          console.log(`  Trailing stop moved: ${oldStop.toFixed(2)} → ${newStop.toFixed(2)}`);
        }
      }
    } else {
      // Short position
      // Update lowest price
      if (price < trade.lowestPrice) {
        trade.lowestPrice = price;
        
        // Calculate new trailing stop
        const newStop = price + (atr * this.config.trailingStopATRMultiplier);
        
        // Only move stop down, never up
        if (newStop < trade.trailingStopPrice) {
          const oldStop = trade.trailingStopPrice;
          trade.trailingStopPrice = newStop;
          trade.stopLoss = newStop; // Update the actual stop loss
          
          console.log(`  Trailing stop moved: ${oldStop.toFixed(2)} → ${newStop.toFixed(2)}`);
        }
      }
    }
  }
  
  checkExit(trade, bar) {
    const price = bar.close;
    
    // Check stop loss
    if (trade.type === 'long' && price <= trade.stopLoss) {
      return { price: trade.stopLoss, reason: 'Stop loss hit' };
    }
    if (trade.type === 'short' && price >= trade.stopLoss) {
      return { price: trade.stopLoss, reason: 'Stop loss hit' };
    }
    
    // Check take profit
    if (trade.type === 'long' && price >= trade.takeProfit) {
      if (!trade.partialClosed && this.config.partialTakeProfit < 1.0) {
        // Take partial profit and move to breakeven
        trade.partialClosed = true;
        trade.breakeven = true;
        trade.stopLoss = trade.entry;
        trade.size *= (1 - this.config.partialTakeProfit);
        
        console.log(`PARTIAL CLOSE ${trade.type.toUpperCase()} @ ${price.toFixed(2)} | Moved to BE`);
        return null; // Don't close the trade
      }
      return { price: trade.takeProfit, reason: 'Take profit hit' };
    }
    
    if (trade.type === 'short' && price <= trade.takeProfit) {
      if (!trade.partialClosed && this.config.partialTakeProfit < 1.0) {
        trade.partialClosed = true;
        trade.breakeven = true;
        trade.stopLoss = trade.entry;
        trade.size *= (1 - this.config.partialTakeProfit);
        
        console.log(`PARTIAL CLOSE ${trade.type.toUpperCase()} @ ${price.toFixed(2)} | Moved to BE`);
        return null;
      }
      return { price: trade.takeProfit, reason: 'Take profit hit' };
    }
    
    return null;
  }
  
  calculateUnrealizedPnL(trade, bar) {
    const price = bar.close;
    const priceDiff = trade.type === 'long' ? (price - trade.entry) : (trade.entry - price);
    return priceDiff * trade.size;
  }
  
  closeTrade(trade, exitResult, bar) {
    // Calculate exit fee
    const exitValue = exitResult.price * trade.size;
    const exitFee = exitValue * this.config.takerFee; // Assume taker fee on exit
    
    const pnl = trade.type === 'long' 
      ? (exitResult.price - trade.entry) * trade.size
      : (trade.entry - exitResult.price) * trade.size;
    
    // Subtract fees from P&L
    const netPnL = pnl - trade.entryFee - exitFee;
    
    this.currentCapital += pnl - exitFee; // Entry fee already deducted
    this.totalFeesPaid += exitFee;
    
    const completedTrade = {
      ...trade,
      exitPrice: exitResult.price,
      exitTime: bar.timestamp,
      exitReason: exitResult.reason,
      exitFee: exitFee,
      totalFees: trade.entryFee + exitFee,
      grossPnL: pnl,
      pnl: netPnL,
      return: (netPnL / (trade.entry * trade.size)) * 100,
      duration: bar.timestamp - trade.openTime,
      status: 'closed'
    };
    
    this.trades.push(completedTrade);
    
    console.log(`CLOSE ${trade.type.toUpperCase()} @ ${exitResult.price.toFixed(2)} | Gross P&L: ${pnl.toFixed(2)} | Fees: ${(trade.entryFee + exitFee).toFixed(2)} | Net P&L: ${netPnL.toFixed(2)} | ${exitResult.reason}`);
    
    return null;
  }
  
  generateReport() {
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl <= 0);
    
    const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const totalGrossPnL = this.trades.reduce((sum, t) => sum + t.grossPnL, 0);
    const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length : 0;
    
    const maxDrawdown = this.calculateMaxDrawdown();
    const sharpeRatio = this.calculateSharpeRatio();
    
    return {
      totalTrades: this.trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: this.trades.length > 0 ? (wins.length / this.trades.length * 100).toFixed(2) : 0,
      grossPnL: totalGrossPnL.toFixed(2),
      totalFees: this.totalFeesPaid.toFixed(2),
      netPnL: totalPnL.toFixed(2),
      avgWin: avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      profitFactor: avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : 'N/A',
      maxDrawdown: maxDrawdown.toFixed(2),
      sharpeRatio: sharpeRatio.toFixed(2),
      finalCapital: this.currentCapital.toFixed(2),
      totalReturn: ((this.currentCapital - this.config.initialCapital) / this.config.initialCapital * 100).toFixed(2),
      feeImpact: totalGrossPnL !== 0 ? ((this.totalFeesPaid / Math.abs(totalGrossPnL)) * 100).toFixed(2) : 0,
      trades: this.trades
    };
  }
  
  calculateMaxDrawdown() {
    let maxEquity = this.equity[0];
    let maxDD = 0;
    
    for (let i = 1; i < this.equity.length; i++) {
      if (this.equity[i] > maxEquity) {
        maxEquity = this.equity[i];
      }
      const drawdown = ((maxEquity - this.equity[i]) / maxEquity) * 100;
      if (drawdown > maxDD) {
        maxDD = drawdown;
      }
    }
    
    return maxDD;
  }
  
  calculateSharpeRatio() {
    if (this.trades.length < 2) return 0;
    
    const returns = this.trades.map(t => t.return);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev !== 0 ? avgReturn / stdDev : 0;
  }
}

// ============================================
// MAIN EXECUTION
// ============================================

async function main() {
  // Configuration
  const config = {
    symbol: 'BTCUSDT',
    interval: '2m',
    startDate: '2024-10-01',
    endDate: '2024-10-15',
    
    // Strategy parameters
    strategy: {
      sebPeriod: 20,
      sebMultiplier: 2.0,
      atrPeriod: 14,
      adxPeriod: 14,
      adxThreshold: 25,
      maxBandAngle: 30,
      useDynamicBands: true,
      atrVolatilityThreshold: 1.5,
      minBandPenetration: 0.1,
      takeProfitTarget: 'middle',
      stopLossMultiplier: 1.0,
      partialTakeProfit: 0.5,
      useTrailingStop: true,
      trailingStopATRMultiplier: 0.5,
      makerFee: 0.001, // 0.1%
      takerFee: 0.001, // 0.1%
      initialCapital: 10000,
      riskPerTrade: 0.01,
      tradingHours: { start: 0, end: 24 }
    }
  };
  
  console.log('='.repeat(60));
  console.log('STANDARD ERROR BAND SCALPING STRATEGY BACKTEST');
  console.log('='.repeat(60));
  console.log(`Symbol: ${config.symbol}`);
  console.log(`Interval: ${config.interval}`);
  console.log(`Period: ${config.startDate} to ${config.endDate}`);
  console.log('='.repeat(60));
  
  // Fetch data
  const fetcher = new BinanceDataFetcher(config.symbol, config.interval);
  const data = await fetcher.fetchHistoricalData(config.startDate, config.endDate);
  
  if (data.length === 0) {
    console.error('No data fetched. Exiting.');
    return;
  }
  
  // Run backtest
  const strategy = new SEBScalpingStrategy(config.strategy);
  const report = strategy.backtest(data);
  
  // Display results
  console.log('\n' + '='.repeat(60));
  console.log('BACKTEST RESULTS');
  console.log('='.repeat(60));
  console.log(`Total Trades: ${report.totalTrades}`);
  console.log(`Wins: ${report.wins} | Losses: ${report.losses}`);
  console.log(`Win Rate: ${report.winRate}%`);
  console.log(`Total P&L: $${report.totalPnL}`);
  console.log(`Average Win: $${report.avgWin}`);
  console.log(`Average Loss: $${report.avgLoss}`);
  console.log(`Profit Factor: ${report.profitFactor}`);
  console.log(`Max Drawdown: ${report.maxDrawdown}%`);
  console.log(`Sharpe Ratio: ${report.sharpeRatio}`);
  console.log(`Initial Capital: $${config.strategy.initialCapital}`);
  console.log(`Final Capital: $${report.finalCapital}`);
  console.log(`Total Return: ${report.totalReturn}%`);
  console.log('='.repeat(60));
  
  // Save detailed results
  const results = {
    config,
    report,
    equity: strategy.equity
  };
  
  fs.writeFileSync('backtest_results.json', JSON.stringify(results, null, 2));
  console.log('\nDetailed results saved to backtest_results.json');
  
  // Save trades to CSV
  if (report.trades.length > 0) {
    const csv = [
      'Type,Entry,Exit,StopLoss,TakeProfit,Size,EntryFee,ExitFee,TotalFees,GrossPnL,NetPnL,Return%,Duration,Reason',
      ...report.trades.map(t => 
        `${t.type},${t.entry},${t.exitPrice},${t.stopLoss},${t.takeProfit},${t.size.toFixed(4)},${t.entryFee.toFixed(2)},${t.exitFee.toFixed(2)},${t.totalFees.toFixed(2)},${t.grossPnL.toFixed(2)},${t.pnl.toFixed(2)},${t.return.toFixed(2)},${t.duration},${t.exitReason}`
      )
    ].join('\n');
    
    fs.writeFileSync('trades.csv', csv);
    console.log('Trade history saved to trades.csv');
  }
  
  console.log('\n💡 Tip: To clear cache and force re-download, delete the ./cache directory');
  console.log('💡 Tip: Cache files are saved by symbol, interval, and date range');
}

// Run the backtest
if (require.main === module) {
  main().catch(console.error);
}

// Export for use as module
module.exports = {
  BinanceDataFetcher,
  SEBScalpingStrategy,
  TechnicalIndicators,
  CacheManager
};
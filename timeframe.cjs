const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Utility functions for data analysis
class DataAnalysis {
  static rolling(arr, window, fn) {
    const result = new Array(arr.length).fill(NaN);
    for (let i = window - 1; i < arr.length; i++) {
      const slice = arr.slice(i - window + 1, i + 1);
      result[i] = fn(slice);
    }
    return result;
  }

  static mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  static std(arr) {
    const mean = DataAnalysis.mean(arr);
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
  }

  static max(arr) {
    return Math.max(...arr);
  }

  static min(arr) {
    return Math.min(...arr);
  }

  static ema(data, period) {
    const k = 2 / (period + 1);
    const result = new Array(data.length);
    result[0] = data[0];
    
    for (let i = 1; i < data.length; i++) {
      result[i] = data[i] * k + result[i - 1] * (1 - k);
    }
    return result;
  }
}

class BinanceDataFetcher {
  constructor(cacheDir = 'binance_cache') {
    this.baseUrl = 'https://api.binance.com/api/v3/klines';
    this.cacheDir = cacheDir;
    this.ensureCacheDir();
  }

  async ensureCacheDir() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (err) {
      console.error('Error creating cache directory:', err);
    }
  }

  getCacheFilename(symbol, interval, startDate, endDate) {
    return path.join(this.cacheDir, `${symbol}_${interval}_${startDate}_${endDate}.json`);
  }

  async fetchKlines(symbol, interval, startTime, endTime, limit = 1000) {
    try {
      const response = await axios.get(this.baseUrl, {
        params: { symbol, interval, startTime, endTime, limit }
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching data:', error.message);
      return null;
    }
  }

  async getLatestCandles(symbol, interval, limit = 500) {
    try {
      const response = await axios.get(this.baseUrl, {
        params: { symbol, interval, limit }
      });
      const data = response.data;

      const df = data.map(candle => ({
        timestamp: new Date(candle[0]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: new Date(candle[6]),
        quoteVolume: parseFloat(candle[7]),
        trades: parseInt(candle[8]),
        takerBuyBase: parseFloat(candle[9]),
        takerBuyQuote: parseFloat(candle[10]),
        isClosed: candle[6] < Date.now()
      }));

      return df;
    } catch (error) {
      console.error('Error fetching latest candles:', error.message);
      return null;
    }
  }

  async downloadHistoricalData(symbol, interval, startDate, endDate) {
    const cacheFile = this.getCacheFilename(symbol, interval, startDate, endDate);

    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      console.log(`Loading cached data from ${cacheFile}`);
      return JSON.parse(cached);
    } catch (err) {
      console.log(`Downloading ${symbol} ${interval} data from ${startDate} to ${endDate}`);
    }

    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();

    const intervalMs = {
      '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
      '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000,
      '6h': 21600000, '12h': 43200000, '1d': 86400000
    };

    const chunkSize = intervalMs[interval] * 1000;
    const allData = [];
    let currentStart = startTs;

    while (currentStart < endTs) {
      const currentEnd = Math.min(currentStart + chunkSize, endTs);
      const data = await this.fetchKlines(symbol, interval, currentStart, currentEnd);

      if (data) {
        allData.push(...data);
        console.log(`Downloaded ${data.length} candles. Total: ${allData.length}`);

        if (data.length < 1000) break;
        currentStart = data[data.length - 1][0] + intervalMs[interval];
      } else {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const df = allData.map(candle => ({
      timestamp: new Date(candle[0]),
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5]),
      closeTime: new Date(candle[6]),
      quoteVolume: parseFloat(candle[7]),
      trades: parseInt(candle[8]),
      takerBuyBase: parseFloat(candle[9]),
      takerBuyQuote: parseFloat(candle[10]),
      isClosed: true
    }));

    await fs.writeFile(cacheFile, JSON.stringify(df, null, 2));
    console.log(`Cached data to ${cacheFile}`);

    return df;
  }
}

class ImprovedTradingBacktest {
  constructor(initialCapital = 10000, leverage = 1, makerFee = 0.0002, takerFee = 0.0004) {
   
   
    this.initialCapital = initialCapital;
    this.leverage = leverage;
    this.makerFee = makerFee;
    this.takerFee = takerFee;
    this.maintenanceMarginRate = 0.004;
    
    // Slippage parameters
    this.baseSlippage = 0.0003;
    this.volatilitySlippageMultiplier = 0.0002;
    this.stopSlippageATRMultiplier = 0.3;
    
    // ===== NEW: DYNAMIC PROFIT PROTECTION PARAMETERS =====
    this.profitThresholdATR = 0.5; // Switch to profit protection after 0.5 ATR gain
    
    // Two-tier trailing system
    this.initialStopATR = 2.0; // Wide stop before profit (avoid noise)
    this.profitTrailingATR = 1.0; // Tight trailing once profitable
    
    // Progressive tightening based on profit level
    this.profitTiers = [
      { profitATR: 0.5, trailATR: 1.0 },   // Small profit: moderate protection
      { profitATR: 1.5, trailATR: 0.75 },  // Good profit: tighter protection
      { profitATR: 3.0, trailATR: 0.5 }    // Great profit: very tight protection
    ];
    
    // Regime-specific adjustments (subtle, not dramatic)
    this.regimeMultipliers = {
      bull: { initial: 1.0, profit: 1.2 },   // Slightly wider in trends
      bear: { initial: 1.0, profit: 1.2 },   // Same as bull (inverted)
      range: { initial: 1.0, profit: 0.8 }   // Tighter in range (faster reversals)
    };

    this.timeframeParams = {
      '1m': {
        rsiPeriod: 8,
        atrPeriod: 10,
        emaFast: 8,
        emaMedium: 21,
        emaSlow: 50,
        regimeLookback: 20,
        minHoldBars: 2
      },
      '3m': {
        rsiPeriod: 10,
        atrPeriod: 12,
        emaFast: 12,
        emaMedium: 26,
        emaSlow: 50,
        regimeLookback: 30,
        minHoldBars: 2
      },
      '5m': {
        rsiPeriod: 12,
        atrPeriod: 14,
        emaFast: 12,
        emaMedium: 26,
        emaSlow: 50,
        regimeLookback: 40,
        minHoldBars: 3
      },
      '15m': {
        rsiPeriod: 12,
        atrPeriod: 14,
        emaFast: 12,
        emaMedium: 26,
        emaSlow: 50,
        regimeLookback: 50,
        minHoldBars: 3
      },
      '1h': {
        rsiPeriod: 14,
        atrPeriod: 14,
        emaFast: 20,
        emaMedium: 50,
        emaSlow: 200,
        regimeLookback: 50,
        minHoldBars: 4
      },
      '4h': {
        rsiPeriod: 14,
        atrPeriod: 14,
        emaFast: 20,
        emaMedium: 50,
        emaSlow: 200,
        regimeLookback: 50,
        minHoldBars: 5
      },
      '1d': {
        rsiPeriod: 14,
        atrPeriod: 14,
        emaFast: 20,
        emaMedium: 50,
        emaSlow: 200,
        regimeLookback: 50,
        minHoldBars: 6
      }
    };
    
    // Default parameters if timeframe not found
    this.defaultParams = {
      rsiPeriod: 14,
      atrPeriod: 14,
      emaFast: 20,
      emaMedium: 50,
      emaSlow: 200,
      regimeLookback: 50,
      minHoldBars: 3
    };
    
  }

  getTimeframeParams(interval) {
    return this.timeframeParams[interval] || this.defaultParams;
  }
  
  
  calculateSlippage(price, side, atr) {
    const volatility = atr / price;
    const slippagePercent = this.baseSlippage + (volatility * this.volatilitySlippageMultiplier);
    
    return side === 'buy' 
      ? price * (1 + slippagePercent)
      : price * (1 - slippagePercent);
  }

  calculateStopSlippage(stopPrice, side, atr) {
    const slippage = atr * this.stopSlippageATRMultiplier;
    
    return side === 'long' 
      ? Math.max(0, stopPrice - slippage)
      : stopPrice + slippage;
  }

  calculateLiquidationPrice(entryPrice, leverage, side) {
    if (side === 'long') {
      return entryPrice * (1 - (1 / leverage) + this.maintenanceMarginRate);
    } else {
      return entryPrice * (1 + (1 / leverage) - this.maintenanceMarginRate);
    }
  }

  calculateFundingCost(positionValue, hoursHeld, fundingRate = 0.0001) {
    const fundingPeriods = Math.floor(hoursHeld / 8);
    return positionValue * fundingRate * fundingPeriods;
  }

  // ===== NEW: DYNAMIC TRAILING STOP CALCULATOR =====
  calculateDynamicTrailingStop(currentPrice, entryPrice, currentAtr, position, regime) {
    const profitAmount = position === 1 
      ? currentPrice - entryPrice 
      : entryPrice - currentPrice;
    
    const profitInATR = profitAmount / currentAtr;
    
    // Get regime multiplier
    const regimeType = regime.bull ? 'bull' : regime.bear ? 'bear' : 'range';
    const multipliers = this.regimeMultipliers[regimeType];
    
    // If not yet profitable, use initial wide stop
    if (profitInATR < this.profitThresholdATR) {
      const stopDistance = this.initialStopATR * currentAtr * multipliers.initial;
      return position === 1 
        ? currentPrice - stopDistance 
        : currentPrice + stopDistance;
    }
    
    // Find appropriate profit tier
    let trailATR = this.profitTrailingATR;
    for (const tier of this.profitTiers) {
      if (profitInATR >= tier.profitATR) {
        trailATR = tier.trailATR;
      }
    }
    
    // Apply regime adjustment
    trailATR *= multipliers.profit;
    
    const stopDistance = trailATR * currentAtr;
    return position === 1 
      ? currentPrice - stopDistance 
      : currentPrice + stopDistance;
  }

  calculateATR(data, interval, period = null) {
    const params = this.getTimeframeParams(interval);
    const atrPeriod = period || params.atrPeriod;
    
    const atr = new Array(data.length).fill(NaN);
    
    for (let i = 1; i < data.length; i++) {
      const tr1 = data[i].high - data[i].low;
      const tr2 = Math.abs(data[i].high - data[i - 1].close);
      const tr3 = Math.abs(data[i].low - data[i - 1].close);
      const tr = Math.max(tr1, tr2, tr3);
      
      if (i >= atrPeriod) {
        const trSlice = [];
        for (let j = i - atrPeriod + 1; j <= i; j++) {
          const t1 = data[j].high - data[j].low;
          const t2 = j > 0 ? Math.abs(data[j].high - data[j - 1].close) : 0;
          const t3 = j > 0 ? Math.abs(data[j].low - data[j - 1].close) : 0;
          trSlice.push(Math.max(t1, t2, t3));
        }
        atr[i] = DataAnalysis.mean(trSlice);
      }
    }
    
    return atr;
  }

  calculateRSI(data, interval, period = null) {
    const params = this.getTimeframeParams(interval);
    const rsiPeriod = period || params.rsiPeriod;
    
    const rsi = new Array(data.length).fill(NaN);
    
    for (let i = rsiPeriod; i < data.length; i++) {
      let gains = 0, losses = 0;
      
      for (let j = i - rsiPeriod + 1; j <= i; j++) {
        const change = data[j].close - data[j - 1].close;
        if (change > 0) gains += change;
        else losses += Math.abs(change);
      }
      
      const avgGain = gains / rsiPeriod;
      const avgLoss = losses / rsiPeriod;
      
      if (avgLoss === 0) {
        rsi[i] = 100;
      } else {
        const rs = avgGain / avgLoss;
        rsi[i] = 100 - (100 / (1 + rs));
      }
    }
    
    return rsi;
  }

  calculateEMA(data, period) {
    const closes = data.map(d => d.close);
    return DataAnalysis.ema(closes, period);
  }

  detectRegime(data, interval, lookback = null) {
    const params = this.getTimeframeParams(interval);
    const regimeLookback = lookback || params.regimeLookback;
    
    const regimes = data.map((d, i) => {
      if (i < regimeLookback) return { bull: false, bear: false, range: true };
      
      const priceChange = (data[i].close - data[i - regimeLookback].close) / data[i - regimeLookback].close;
      
      const smaSlice = data.slice(Math.max(0, i - regimeLookback), i + 1).map(d => d.close);
      const sma = DataAnalysis.mean(smaSlice);
      const smaSlope = i >= regimeLookback + 5 ? 
        (sma - DataAnalysis.mean(data.slice(i - regimeLookback - 5, i - 4).map(d => d.close))) / sma : 0;
      
      // Adjust thresholds for shorter timeframes
      const changeThreshold = interval.includes('m') ? 0.05 : 0.10; // Lower for minutes
      const slopeThreshold = interval.includes('m') ? 0.002 : 0.001; // Higher for minutes
      
      const bull = priceChange > changeThreshold && smaSlope > slopeThreshold;
      const bear = priceChange < -changeThreshold && smaSlope < -slopeThreshold;
      const range = !bull && !bear;
      
      return { bull, bear, range };
    });
    
    return regimes;
  }

  generateSignals(data, strategyMode = 'adaptive', interval = '1h') {
    const params = this.getTimeframeParams(interval);
    
    const atr = this.calculateATR(data, interval);
    const rsi = this.calculateRSI(data, interval);
    const emaFast = this.calculateEMA(data, params.emaFast);
    const emaMedium = this.calculateEMA(data, params.emaMedium);
    const emaSlow = this.calculateEMA(data, params.emaSlow);
    const regimes = this.detectRegime(data, interval);

    // Adjust breakout lookback for shorter timeframes
    const breakoutLookback = interval.includes('m') ? 10 : 20;

    const signals = data.map((d, i) => {
      if (i < Math.max(params.emaSlow, params.regimeLookback)) {
        return { long: false, short: false };
      }

      const recentHigh = i >= breakoutLookback 
        ? Math.max(...data.slice(i - breakoutLookback, i).map(d => d.high))
        : Math.max(...data.slice(0, i).map(d => d.high));

      const recentLow = i >= breakoutLookback
        ? Math.min(...data.slice(i - breakoutLookback, i).map(d => d.low))
        : Math.min(...data.slice(0, i).map(d => d.low));

      // Adjust RSI thresholds for shorter timeframes
      const rsiOversold = interval.includes('m') ? 25 : 30;
      const rsiOverbought = interval.includes('m') ? 75 : 70;
      const rsiNeutralMin = interval.includes('m') ? 35 : 40;
      const rsiNeutralMax = interval.includes('m') ? 65 : 60;

      let longSignal = false, shortSignal = false;

      if (strategyMode === 'mean_reversion') {
        longSignal = rsi[i] < rsiOversold && data[i].close > emaSlow[i];
        shortSignal = rsi[i] > rsiOverbought && data[i].close < emaSlow[i];
      } else if (strategyMode === 'momentum') {
        longSignal = data[i].close > recentHigh && rsi[i] > 50 && 
                     data[i].close > emaSlow[i] && emaFast[i] > emaMedium[i];
        shortSignal = data[i].close < recentLow && rsi[i] < 50 && 
                      data[i].close < emaSlow[i] && emaFast[i] < emaMedium[i];
      } else if (strategyMode === 'pullback') {
        longSignal = data[i].close > emaSlow[i] && data[i].close < emaFast[i] && 
                     rsi[i] > rsiNeutralMin && rsi[i] < rsiNeutralMax && rsi[i] > rsi[i - 1];
        shortSignal = data[i].close < emaSlow[i] && data[i].close > emaFast[i] && 
                      rsi[i] > rsiNeutralMin && rsi[i] < rsiNeutralMax && rsi[i] < rsi[i - 1];
      } else if (strategyMode === 'bear_market') {
        const shortOverbought = rsi[i] > (interval.includes('m') ? 65 : 60) && 
                               data[i].close < emaSlow[i] &&
                               emaFast[i] < emaMedium[i];
        
        const shortFailedBreakout = data[i].close < emaFast[i] && 
                                    data[i - 1].close > emaFast[i - 1] &&
                                    data[i].close < emaSlow[i];
        
        const shortBreakdown = data[i].close < recentLow &&
                              data[i].close < emaSlow[i];
        
        const longExtremeBounce = rsi[i] < (interval.includes('m') ? 20 : 25) && 
                                 data[i].close > data[i - 1].close &&
                                 data[i].volume > data[i - 1].volume * 1.2;
        
        longSignal = longExtremeBounce;
        shortSignal = shortOverbought || shortFailedBreakout || shortBreakdown;
      } else { // adaptive
        const bullLong = regimes[i].bull && 
                        data[i].close > emaSlow[i] && 
                        data[i].close < emaFast[i] && 
                        rsi[i] > rsiNeutralMin && rsi[i] < rsiNeutralMax && 
                        rsi[i] > rsi[i - 1];
        
        const bearShort = regimes[i].bear && 
                         rsi[i] > (interval.includes('m') ? 65 : 60) && 
                         data[i].close < emaSlow[i] &&
                         emaFast[i] < emaMedium[i];
        
        const bearLong = regimes[i].bear && 
                        rsi[i] < (interval.includes('m') ? 20 : 25) &&
                        data[i].close > data[i - 1].close;
        
        const rangeLong = regimes[i].range && rsi[i] < rsiOversold;
        const rangeShort = regimes[i].range && rsi[i] > rsiOverbought;

        longSignal = bullLong || bearLong || rangeLong;
        shortSignal = bearShort || rangeShort;
      }

      return {
        long: longSignal,
        short: shortSignal,
        atr: atr[i],
        rsi: rsi[i],
        emaFast: emaFast[i],
        emaMedium: emaMedium[i],
        emaSlow: emaSlow[i],
        regime: regimes[i],
        params: params // Include for debugging
      };
    });

    return signals;
  }

  getRegimeParameters(isBull, isBear, isRange) {
    // Simplified - position sizing only, stops are now dynamic
    if (isBull) {
      return {
        positionSizePct: 0.8,
        minHoldBars: 3 // Reduced for scalping
      };
    } else if (isBear) {
      return {
        positionSizePct: 0.8,
        minHoldBars: 3
      };
    } else {
      return {
        positionSizePct: 0.8,
        minHoldBars: 3
      };
    }
  }

  backtest(data, strategyMode = 'adaptive', useRegimeParams = true, interval = '1h') {
    const signals = this.generateSignals(data, strategyMode, interval);
    const params = this.getTimeframeParams(interval);

    let capital = this.initialCapital;
    let position = 0;
    let entryPrice = 0;
    let entryBar = 0;
    let trailingStop = 0;
    let positionQty = 0;
    let liquidationPrice = 0;
    let maxProfitATR = 0; // Track highest profit reached

    const trades = [];
    const equityCurve = [];
    const regimeLog = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const signal = signals[i];
      const currentPrice = row.close;
      const currentAtr = signal.atr;

      if (isNaN(currentAtr)) {
        equityCurve.push(capital);
        continue;
      }

      const params = useRegimeParams
        ? this.getRegimeParameters(signal.regime.bull, signal.regime.bear, signal.regime.range)
        : {
            positionSizePct: 0.5,
            minHoldBars: 3
          };

      const regime = signal.regime.bull ? 'BULL' : signal.regime.bear ? 'BEAR' : 'RANGE';
      regimeLog.push(regime);

      // Check for liquidation
      if (position !== 0) {
        if ((position === 1 && currentPrice <= liquidationPrice) ||
            (position === -1 && currentPrice >= liquidationPrice)) {
          
          const marginLost = (entryPrice * positionQty);
          capital -= marginLost;

          trades.push({
            entryTime: data[entryBar].timestamp,
            exitTime: row.timestamp,
            direction: position === 1 ? 'long' : 'short',
            entryPrice,
            exitPrice: liquidationPrice,
            barsHeld: i - entryBar,
            pnl: -marginLost,
            return: -1,
            exitReason: 'liquidation',
            regime,
            maxProfitATR: maxProfitATR.toFixed(2)
          });

          console.warn(`⚠️ LIQUIDATION at bar ${i}! Price: ${currentPrice.toFixed(2)}`);
          position = 0;
          continue;
        }
      }

      // ===== MANAGE OPEN POSITIONS WITH DYNAMIC STOPS =====
      if (position !== 0) {
        const barsHeld = i - entryBar;
        const hoursHeld = barsHeld * 0.25;

        // Calculate current profit in ATR
        const profitAmount = position === 1 
          ? currentPrice - entryPrice 
          : entryPrice - currentPrice;
        const profitInATR = profitAmount / currentAtr;
        
        // Track max profit reached
        maxProfitATR = Math.max(maxProfitATR, profitInATR);

        // Calculate new dynamic trailing stop
        const newTrailingStop = this.calculateDynamicTrailingStop(
          currentPrice, 
          entryPrice, 
          currentAtr, 
          position, 
          signal.regime
        );

        // Update trailing stop (only move in favorable direction)
        if (position === 1) {
          trailingStop = Math.max(trailingStop, newTrailingStop);
        } else {
          trailingStop = Math.min(trailingStop, newTrailingStop);
        }

        // Check if stop hit
        const stopHit = position === 1 
          ? currentPrice <= trailingStop 
          : currentPrice >= trailingStop;

        if (stopHit) {
          const exitPrice = this.calculateStopSlippage(trailingStop, position === 1 ? 'long' : 'short', currentAtr);
          const pnl = position === 1
            ? (exitPrice - entryPrice) * positionQty * this.leverage
            : (entryPrice - exitPrice) * positionQty * this.leverage;
          
          const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
          const fundingCost = this.calculateFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
          const netPnl = pnl - exitFee - fundingCost;
          
          capital += netPnl;

          const exitReason = profitInATR > this.profitThresholdATR 
            ? 'profit_protection' 
            : 'initial_stop';

          trades.push({
            entryTime: data[entryBar].timestamp,
            exitTime: row.timestamp,
            direction: position === 1 ? 'long' : 'short',
            entryPrice,
            exitPrice,
            barsHeld,
            pnl: netPnl,
            return: netPnl / (entryPrice * positionQty),
            exitReason,
            regime,
            fundingCost,
            slippage: Math.abs(trailingStop - exitPrice),
            maxProfitATR: maxProfitATR.toFixed(2)
          });

          position = 0;
          maxProfitATR = 0;
        }
      }

      // Enter new positions
      if (position === 0 && capital > 0) {
        if (signal.long) {
          const tradeCapital = capital * params.positionSizePct;
          const margin = tradeCapital;
          
          entryPrice = this.calculateSlippage(currentPrice, 'buy', currentAtr);
          const entryFee = margin * this.leverage * this.takerFee;
          
          positionQty = (margin - entryFee) / entryPrice;
          entryBar = i;
          position = 1;
          maxProfitATR = 0;

          // Set initial wide stop
          trailingStop = this.calculateDynamicTrailingStop(
            entryPrice, 
            entryPrice, 
            currentAtr, 
            position, 
            signal.regime
          );
          
          liquidationPrice = this.calculateLiquidationPrice(entryPrice, this.leverage, 'long');
          
        } else if (signal.short) {
          const tradeCapital = capital * params.positionSizePct;
          const margin = tradeCapital;
          
          entryPrice = this.calculateSlippage(currentPrice, 'sell', currentAtr);
          const entryFee = margin * this.leverage * this.takerFee;
          
          positionQty = (margin - entryFee) / entryPrice;
          entryBar = i;
          position = -1;
          maxProfitATR = 0;

          // Set initial wide stop
          trailingStop = this.calculateDynamicTrailingStop(
            entryPrice, 
            entryPrice, 
            currentAtr, 
            position, 
            signal.regime
          );
          
          liquidationPrice = this.calculateLiquidationPrice(entryPrice, this.leverage, 'short');
        }
      }

      equityCurve.push(capital);
    }

    // Close any remaining position
    if (position !== 0) {
      const exitPrice = data[data.length - 1].close;
      const hoursHeld = (data.length - entryBar) * 0.25;
      
      const pnl = position === 1
        ? (exitPrice - entryPrice) * positionQty * this.leverage
        : (entryPrice - exitPrice) * positionQty * this.leverage;

      const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
      const fundingCost = this.calculateFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
      const netPnl = pnl - exitFee - fundingCost;
      
      capital += netPnl;

      trades.push({
        entryTime: data[entryBar].timestamp,
        exitTime: data[data.length - 1].timestamp,
        direction: position === 1 ? 'long' : 'short',
        entryPrice,
        exitPrice,
        barsHeld: data.length - entryBar,
        pnl: netPnl,
        return: netPnl / (entryPrice * positionQty),
        exitReason: 'end_of_data',
        regime: regimeLog[regimeLog.length - 1],
        fundingCost,
        maxProfitATR: maxProfitATR.toFixed(2)
      });
    }

    return { trades, equityCurve, signals, regimeLog };
  }

 async forwardTest(symbol, interval, strategyMode = 'adaptive', 
                    useRegimeParams = true, updateIntervalSeconds = 60) {
    console.log('\n' + '='.repeat(70));
    console.log('STARTING FORWARD TEST (PAPER TRADING)');
    console.log('WITH DYNAMIC PROFIT PROTECTION 🛡️');
    console.log('='.repeat(70));
    console.log(`Symbol: ${symbol}`);
    console.log(`Interval: ${interval}`);
    console.log(`Strategy: ${strategyMode}`);
    console.log(`Leverage: ${this.leverage}x`);
    console.log(`Initial Capital: $${this.initialCapital.toLocaleString()}`);
    console.log(`\n📊 Profit Protection System:`);
    console.log(`   Initial Stop: ${this.initialStopATR} ATR (pre-profit)`);
    console.log(`   Profit Threshold: ${this.profitThresholdATR} ATR`);
    console.log(`   Profit Trailing: ${this.profitTrailingATR} ATR → ${this.profitTiers[this.profitTiers.length-1].trailATR} ATR (progressive)`);
    console.log('\n⚠️  Press Ctrl+C to stop and close positions gracefully');
    console.log('='.repeat(70));

    const fetcher = new BinanceDataFetcher();

    let capital = this.initialCapital;
    let position = 0;
    let entryPrice = 0;
    let entryTime = null;
    let trailingStop = 0;
    let positionQty = 0;
    let liquidationPrice = 0;
    let maxProfitATR = 0;

    const trades = [];
    const equityLog = [];
    const startTime = new Date();

    const shutdown = async () => {
      console.log('\n\n' + '='.repeat(70));
      console.log('⚠️  SHUTDOWN SIGNAL RECEIVED - CLOSING POSITIONS GRACEFULLY');
      console.log('='.repeat(70));

      if (position !== 0) {
        console.log(`\n📊 Closing ${position === 1 ? 'LONG' : 'SHORT'} position at market...`);

        const data = await fetcher.getLatestCandles(symbol, interval, 10);
        const closedCandles = data.slice(0, -1);
        const exitPrice = closedCandles[closedCandles.length - 1].close;
        const exitTime = closedCandles[closedCandles.length - 1].timestamp;

        const hoursHeld = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);
        
        const pnl = position === 1
          ? (exitPrice - entryPrice) * positionQty * this.leverage
          : (entryPrice - exitPrice) * positionQty * this.leverage;

        const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
        const fundingCost = this.calculateFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
        const netPnl = pnl - exitFee - fundingCost;
        const returnPct = (netPnl / (entryPrice * positionQty)) * 100;

        capital += netPnl;

        trades.push({
          entryTime,
          exitTime,
          direction: position === 1 ? 'long' : 'short',
          entryPrice,
          exitPrice,
          pnl: netPnl,
          return: netPnl / (entryPrice * positionQty),
          exitReason: 'manual_shutdown',
          regime: 'UNKNOWN',
          fundingCost,
          maxProfitATR: maxProfitATR.toFixed(2)
        });

        console.log(`\n✅ Position closed at ${exitPrice.toFixed(2)}`);
        console.log(`   Entry: ${entryPrice.toFixed(2)}`);
        console.log(`   P&L: ${netPnl.toFixed(2)} (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%)`);
        console.log(`   Max Profit Reached: ${maxProfitATR.toFixed(2)} ATR`);
        console.log(`   Funding Cost: ${fundingCost.toFixed(2)}`);
        console.log(`   Duration: ${Math.floor(hoursHeld * 60)} minutes`);

        position = 0;
      } else {
        console.log('\n✅ No open positions to close');
      }

      console.log('\n' + '='.repeat(70));
      console.log('FORWARD TEST SUMMARY');
      console.log('='.repeat(70));
      console.log(`Total Duration: ${Math.floor((new Date() - startTime) / 60000)} minutes`);
      console.log(`Final Capital: ${capital.toFixed(2)}`);
      console.log(`Total Return: ${((capital - this.initialCapital) / this.initialCapital * 100).toFixed(2)}%`);
      console.log(`Total Trades: ${trades.length}`);

      if (trades.length > 0) {
        const winning = trades.filter(t => t.pnl > 0).length;
        const profitProtected = trades.filter(t => t.exitReason === 'profit_protection').length;
        console.log(`Winning Trades: ${winning}`);
        console.log(`Win Rate: ${(winning / trades.length * 100).toFixed(1)}%`);
        console.log(`Profit Protected Exits: ${profitProtected} (${(profitProtected/trades.length*100).toFixed(1)}%)`);
        const avgPnl = trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length;
        console.log(`Average P&L: ${avgPnl.toFixed(2)}`);
        
        const totalFunding = trades.reduce((sum, t) => sum + (t.fundingCost || 0), 0);
        console.log(`Total Funding Costs: ${totalFunding.toFixed(2)}`);
      }

      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    let currentPrice = 0;
    let lastClosedCandleTime = null;

    while (true) {
      try {
        const rawData = await fetcher.getLatestCandles(symbol, interval, 501);

        if (!rawData || rawData.length < 201) {
          console.log('Failed to fetch data, retrying...');
          await new Promise(resolve => setTimeout(resolve, updateIntervalSeconds * 1000));
          continue;
        }

        const data = rawData.slice(0, -1);
        const latestClosed = data[data.length - 1];

        if (lastClosedCandleTime && latestClosed.closeTime <= lastClosedCandleTime) {
          await new Promise(resolve => setTimeout(resolve, updateIntervalSeconds * 1000));
          continue;
        }

        lastClosedCandleTime = latestClosed.closeTime;

    const signals = this.generateSignals(data, strategyMode, interval);
            const latestSignal = signals[signals.length - 1];
        
        currentPrice = latestClosed.close;
        const currentTime = latestClosed.timestamp;
        const currentAtr = latestSignal.atr;

        if (isNaN(currentAtr)) {
          await new Promise(resolve => setTimeout(resolve, updateIntervalSeconds * 1000));
          continue;
        }

        const regime = latestSignal.regime.bull ? 'BULL' : latestSignal.regime.bear ? 'BEAR' : 'RANGE';

        const params = useRegimeParams
          ? this.getRegimeParameters(latestSignal.regime.bull, latestSignal.regime.bear, latestSignal.regime.range)
          : {
              positionSizePct: 0.5,
              minHoldBars: 3
            };

        console.log(`\n[${currentTime.toISOString()}] Price: ${currentPrice.toFixed(2)} | Regime: ${regime} | Capital: ${capital.toFixed(2)}`);
        console.log(`RSI: ${latestSignal.rsi.toFixed(1)} | ATR: ${currentAtr.toFixed(2)}`);

        // Check for liquidation
        if (position !== 0) {
          if ((position === 1 && currentPrice <= liquidationPrice) ||
              (position === -1 && currentPrice >= liquidationPrice)) {
            
            console.log(`\n🚨 LIQUIDATION! Price hit liquidation level: ${liquidationPrice.toFixed(2)}`);
            
            const marginLost = entryPrice * positionQty;
            capital -= marginLost;

            trades.push({
              entryTime,
              exitTime: currentTime,
              direction: position === 1 ? 'long' : 'short',
              entryPrice,
              exitPrice: liquidationPrice,
              pnl: -marginLost,
              return: -1,
              exitReason: 'liquidation',
              regime,
              maxProfitATR: maxProfitATR.toFixed(2)
            });

            position = 0;
            continue;
          }
        }

        if (position !== 0) {
          const barsHeld = data.filter(d => d.timestamp > entryTime).length;
          const hoursHeld = (currentTime - entryTime) / (1000 * 60 * 60);

          const positionPnl = position === 1
            ? (currentPrice - entryPrice) * positionQty * this.leverage
            : (entryPrice - currentPrice) * positionQty * this.leverage;

          const pnlPct = (positionPnl / (entryPrice * positionQty)) * 100;
          
          // Calculate profit in ATR
          const profitAmount = position === 1 ? currentPrice - entryPrice : entryPrice - currentPrice;
          const profitInATR = profitAmount / currentAtr;
          maxProfitATR = Math.max(maxProfitATR, profitInATR);

          // Calculate new dynamic trailing stop
          const newTrailingStop = this.calculateDynamicTrailingStop(
            currentPrice, 
            entryPrice, 
            currentAtr, 
            position, 
            latestSignal.regime
          );

          // Update trailing stop
          if (position === 1) {
            if (newTrailingStop > trailingStop) {
              trailingStop = newTrailingStop;
              console.log(`📈 Trailing stop tightened: ${trailingStop.toFixed(2)} (Profit: ${profitInATR.toFixed(2)} ATR)`);
            }
          } else {
            if (newTrailingStop < trailingStop) {
              trailingStop = newTrailingStop;
              console.log(`📉 Trailing stop tightened: ${trailingStop.toFixed(2)} (Profit: ${profitInATR.toFixed(2)} ATR)`);
            }
          }

          const unrealizedFee = currentPrice * positionQty * this.leverage * this.takerFee;
          const fundingCost = this.calculateFundingCost(currentPrice * positionQty * this.leverage, hoursHeld);
          const netUnrealizedPnl = positionPnl - unrealizedFee - fundingCost;
          const netPnlPct = (netUnrealizedPnl / (entryPrice * positionQty)) * 100;

          const profitStatus = profitInATR >= this.profitThresholdATR ? '🛡️ PROTECTED' : '⏳ INITIAL';

          console.log(`Position: ${position === 1 ? 'LONG' : 'SHORT'} ${this.leverage}x | Entry: ${entryPrice.toFixed(2)} | ${profitStatus}`);
          console.log(`Unrealized P&L: ${positionPnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) | After Fees: ${netUnrealizedPnl.toFixed(2)} (${netPnlPct >= 0 ? '+' : ''}${netPnlPct.toFixed(2)}%)`);
          console.log(`Profit: ${profitInATR.toFixed(2)} ATR (Max: ${maxProfitATR.toFixed(2)} ATR) | Stop: ${trailingStop.toFixed(2)} | Liq: ${liquidationPrice.toFixed(2)}`);

          // Check if stop hit
          const stopHit = position === 1 
            ? currentPrice <= trailingStop 
            : currentPrice >= trailingStop;

          if (stopHit) {
            const exitPrice = this.calculateStopSlippage(trailingStop, position === 1 ? 'long' : 'short', currentAtr);
            const pnl = position === 1
              ? (exitPrice - entryPrice) * positionQty * this.leverage
              : (entryPrice - exitPrice) * positionQty * this.leverage;
            
            const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
            const totalFunding = this.calculateFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
            const netPnl = pnl - exitFee - totalFunding;
            
            capital += netPnl;

            const exitReason = profitInATR > this.profitThresholdATR 
              ? 'profit_protection' 
              : 'initial_stop';

            trades.push({
              entryTime,
              exitTime: currentTime,
              direction: position === 1 ? 'long' : 'short',
              entryPrice,
              exitPrice,
              pnl: netPnl,
              return: netPnl / (entryPrice * positionQty),
              exitReason,
              regime,
              fundingCost: totalFunding,
              slippage: Math.abs(trailingStop - exitPrice),
              maxProfitATR: maxProfitATR.toFixed(2)
            });

            const exitEmoji = netPnl > 0 ? '✅' : '❌';
            const reasonEmoji = exitReason === 'profit_protection' ? '🛡️' : '🔴';
            
            console.log(`${exitEmoji} EXIT ${position === 1 ? 'LONG' : 'SHORT'}: ${exitPrice.toFixed(2)} ${reasonEmoji}`);
            console.log(`   P&L: ${netPnl.toFixed(2)} (${((netPnl/(entryPrice*positionQty)*100) >= 0 ? '+' : '')}${(netPnl/(entryPrice*positionQty)*100).toFixed(2)}%)`);
            console.log(`   Max Profit: ${maxProfitATR.toFixed(2)} ATR | Exit Reason: ${exitReason}`);
            console.log(`   Stop Slippage: ${Math.abs(trailingStop - exitPrice).toFixed(2)} | Funding: ${totalFunding.toFixed(2)}`);
            
            position = 0;
            maxProfitATR = 0;
          }
        } else if (position === 0 && capital > 0) {
          if (latestSignal.long) {
            const tradeCapital = capital * params.positionSizePct;
            const margin = tradeCapital;
            
            entryPrice = this.calculateSlippage(currentPrice, 'buy', currentAtr);
            const entryFee = margin * this.leverage * this.takerFee;
            
            positionQty = (margin - entryFee) / entryPrice;
            entryTime = currentTime;
            position = 1;
            maxProfitATR = 0;

            trailingStop = this.calculateDynamicTrailingStop(
              entryPrice, 
              entryPrice, 
              currentAtr, 
              position, 
              latestSignal.regime
            );
            
            liquidationPrice = this.calculateLiquidationPrice(entryPrice, this.leverage, 'long');

            console.log(`✅ ENTER LONG ${this.leverage}x: ${entryPrice.toFixed(2)} | Qty: ${positionQty.toFixed(4)}`);
            console.log(`   Initial Stop: ${trailingStop.toFixed(2)} (${this.initialStopATR} ATR) | Liquidation: ${liquidationPrice.toFixed(2)}`);
            console.log(`   Profit Protection activates at: ${(entryPrice + this.profitThresholdATR * currentAtr).toFixed(2)} (+${this.profitThresholdATR} ATR)`);
            
          } else if (latestSignal.short) {
            const tradeCapital = capital * params.positionSizePct;
            const margin = tradeCapital;
            
            entryPrice = this.calculateSlippage(currentPrice, 'sell', currentAtr);
            const entryFee = margin * this.leverage * this.takerFee;
            
            positionQty = (margin - entryFee) / entryPrice;
            entryTime = currentTime;
            position = -1;
            maxProfitATR = 0;

            trailingStop = this.calculateDynamicTrailingStop(
              entryPrice, 
              entryPrice, 
              currentAtr, 
              position, 
              latestSignal.regime
            );
            
            liquidationPrice = this.calculateLiquidationPrice(entryPrice, this.leverage, 'short');

            console.log(`✅ ENTER SHORT ${this.leverage}x: ${entryPrice.toFixed(2)} | Qty: ${positionQty.toFixed(4)}`);
            console.log(`   Initial Stop: ${trailingStop.toFixed(2)} (${this.initialStopATR} ATR) | Liquidation: ${liquidationPrice.toFixed(2)}`);
            console.log(`   Profit Protection activates at: ${(entryPrice - this.profitThresholdATR * currentAtr).toFixed(2)} (-${this.profitThresholdATR} ATR)`);
          }
        }

        equityLog.push({
          time: currentTime,
          capital,
          regime,
          price: currentPrice
        });

        await new Promise(resolve => setTimeout(resolve, updateIntervalSeconds * 1000));

      } catch (error) {
        console.error('Error in forward test loop:', error.message);
        await new Promise(resolve => setTimeout(resolve, updateIntervalSeconds * 1000));
      }
    }
  }

  calculateMetrics(trades, equityCurve, data) {
    if (!trades || trades.length === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        totalReturn: 0,
        maxDrawdown: 0,
        sharpeRatio: 0,
        avgSlippage: 0,
        totalFundingCosts: 0,
        liquidations: 0,
        profitProtectedExits: 0
      };
    }

    const totalTrades = trades.length;
    const winningTrades = trades.filter(t => t.pnl > 0).length;
    const winRate = winningTrades / totalTrades;
    const liquidations = trades.filter(t => t.exitReason === 'liquidation').length;
    const profitProtectedExits = trades.filter(t => t.exitReason === 'profit_protection').length;

    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    const totalReturn = (equityCurve[equityCurve.length - 1] - this.initialCapital) / this.initialCapital;

    const wins = trades.filter(t => t.pnl > 0).map(t => t.pnl);
    const losses = trades.filter(t => t.pnl < 0).map(t => t.pnl);
    const avgWin = wins.length > 0 ? DataAnalysis.mean(wins) : 0;
    const avgLoss = losses.length > 0 ? DataAnalysis.mean(losses) : 0;

    const totalFundingCosts = trades.reduce((sum, t) => sum + (t.fundingCost || 0), 0);
    const avgSlippage = trades.filter(t => t.slippage).length > 0 
      ? DataAnalysis.mean(trades.filter(t => t.slippage).map(t => Math.abs(t.slippage)))
      : 0;

    let maxDrawdown = 0;
    let peak = equityCurve[0];
    for (const equity of equityCurve) {
      if (equity > peak) peak = equity;
      const drawdown = (equity - peak) / peak;
      if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }

    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
      returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
    }
    
    const meanReturn = DataAnalysis.mean(returns);
    const stdReturn = DataAnalysis.std(returns);
    const sharpeRatio = returns.length > 0 && stdReturn !== 0
      ? (meanReturn / stdReturn) * Math.sqrt(252)
      : 0;

    const buyHoldReturn = (data[data.length - 1].close - data[0].close) / data[0].close;

    const regimeStats = {};
    for (const trade of trades) {
      if (!regimeStats[trade.regime]) {
        regimeStats[trade.regime] = { sum: 0, mean: 0, count: 0, wins: 0 };
      }
      regimeStats[trade.regime].sum += trade.pnl;
      regimeStats[trade.regime].count += 1;
      if (trade.pnl > 0) regimeStats[trade.regime].wins += 1;
    }
    for (const regime in regimeStats) {
      regimeStats[regime].mean = regimeStats[regime].sum / regimeStats[regime].count;
      regimeStats[regime].winRate = (regimeStats[regime].wins / regimeStats[regime].count * 100).toFixed(1) + '%';
    }

    const profitFactor = wins.length > 0 && losses.length > 0
      ? Math.abs(wins.reduce((a, b) => a + b, 0) / losses.reduce((a, b) => a + b, 0))
      : 0;

    // Analyze profit protection effectiveness
    const protectedTrades = trades.filter(t => t.exitReason === 'profit_protection');
    const avgMaxProfitATR = trades.filter(t => t.maxProfitATR).length > 0
      ? DataAnalysis.mean(trades.filter(t => t.maxProfitATR).map(t => parseFloat(t.maxProfitATR)))
      : 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades: totalTrades - winningTrades,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      totalPnl,
      totalReturn,
      maxDrawdown,
      sharpeRatio,
      finalCapital: equityCurve[equityCurve.length - 1],
      buyHoldReturn,
      outperformance: totalReturn - buyHoldReturn,
      regimeStats,
      avgSlippage,
      totalFundingCosts,
      liquidations,
      profitProtectedExits,
      profitProtectionRate: (profitProtectedExits / totalTrades * 100).toFixed(1) + '%',
      avgMaxProfitATR: avgMaxProfitATR.toFixed(2)
    };
  }

  realityCheck(metrics) {
    const warnings = [];
    
    if (metrics.winRate > 0.70) {
      warnings.push('⚠️  Win rate > 70% is unusual for scalping strategies');
    }
    
    if (metrics.sharpeRatio > 3.0) {
      warnings.push('⚠️  Sharpe ratio > 3 is extremely rare in live trading');
    }
    
    if (Math.abs(metrics.maxDrawdown) < 0.05) {
      warnings.push('⚠️  Max drawdown < 5% is unrealistic for crypto trading');
    }
    
    if (metrics.profitFactor > 3.0) {
      warnings.push('⚠️  Profit factor > 3 is exceptional and rarely sustained');
    }

    if (metrics.liquidations > metrics.totalTrades * 0.1) {
      warnings.push('⚠️  Liquidation rate > 10% is very dangerous - reduce leverage');
    }

    if (metrics.totalFundingCosts / Math.abs(metrics.totalPnl) > 0.2) {
      warnings.push('⚠️  Funding costs > 20% of P&L - consider shorter holding periods');
    }
    
    if (warnings.length > 0) {
      console.log('\n' + '='.repeat(70));
      console.log('🚨 REALITY CHECK WARNINGS:');
      console.log('='.repeat(70));
      warnings.forEach(w => console.log(w));
      console.log('\nYour backtest may be overfitted or have issues.');
      console.log('STRONGLY RECOMMENDED: Paper trade for 2-4 weeks before going live.');
      console.log('='.repeat(70));
    } else {
      console.log('\n✅ Reality check passed - results appear reasonable');
    }
    
    // Show profit protection stats
    console.log('\n' + '='.repeat(70));
    console.log('🛡️  PROFIT PROTECTION ANALYSIS');
    console.log('='.repeat(70));
    console.log(`Profit Protected Exits: ${metrics.profitProtectedExits} (${metrics.profitProtectionRate})`);
    console.log(`Average Max Profit Reached: ${metrics.avgMaxProfitATR} ATR`);
    console.log(`This shows how well the system locks in gains vs giving them back.`);
    console.log('='.repeat(70));
    
    return warnings.length === 0;
  }
}

async function compareStrategiesBacktest(symbol, interval, startDate, endDate, initialCapital, leverage) {
  console.log('\n' + '='.repeat(70));
  console.log('STRATEGY COMPARISON ON HISTORICAL DATA');
  console.log('WITH DYNAMIC PROFIT PROTECTION 🛡️');
  console.log('='.repeat(70));
  console.log('This will help you choose the best strategy for forward testing');
  console.log('='.repeat(70));

  const fetcher = new BinanceDataFetcher();
  const data = await fetcher.downloadHistoricalData(symbol, interval, startDate, endDate);

  const backtest = new ImprovedTradingBacktest(initialCapital, leverage);
  const strategies = ['mean_reversion', 'momentum', 'pullback', 'bear_market', 'adaptive'];
  const results = [];

  for (const strat of strategies) {
    console.log(`\nBacktesting ${strat}...`);
    const { trades, equityCurve, signals } = backtest.backtest(data, strat, true);
    const metrics = backtest.calculateMetrics(trades, equityCurve, data);

    results.push({
      Strategy: strat,
      'Return %': (metrics.totalReturn * 100).toFixed(2),
      Trades: metrics.totalTrades,
      'Win Rate %': (metrics.winRate * 100).toFixed(1),
      'Protected': metrics.profitProtectionRate,
      Sharpe: metrics.sharpeRatio.toFixed(2),
      'Max DD %': (metrics.maxDrawdown * 100).toFixed(2),
      Liquidations: metrics.liquidations
    });
  }

  results.sort((a, b) => parseFloat(b['Return %']) - parseFloat(a['Return %']));

  console.log('\n' + '='.repeat(70));
  console.log('RESULTS (Sorted by Return)');
  console.log('='.repeat(70));
  console.table(results);

  console.log('\n' + '='.repeat(70));
  console.log('STRATEGY RECOMMENDATIONS');
  console.log('='.repeat(70));
  console.log('✓ ADAPTIVE: Automatically switches between strategies based on market regime');
  console.log('  Best for: Set-it-and-forget-it trading across all market conditions');
  console.log('\n✓ MEAN_REVERSION: Buys oversold, sells overbought');
  console.log('  Best for: Ranging and choppy markets');
  console.log('\n✓ MOMENTUM: Trades breakouts and trends');
  console.log('  Best for: Strong trending bull markets');
  console.log('\n✓ PULLBACK: Buys dips in uptrends');
  console.log('  Best for: Bull markets with healthy corrections');
  console.log('\n✓ BEAR_MARKET: Aggressive shorting strategy');
  console.log('  Best for: Confirmed bear markets and strong downtrends');
  console.log('='.repeat(70));

  return results;
}

async function main() {
  // ==================== CONFIGURATION ====================

  const FORWARD_TEST = false; // Set to true for paper trading, false for backtest

  const SYMBOL = 'NEARUSDT';
  const INTERVAL = '1h';
  const INITIAL_CAPITAL = 890;
  const LEVERAGE = 1;

  const STRATEGY_MODE = 'adaptive';
  const USE_REGIME_PARAMS = true;

  const START_DATE = '2025-09-01';
  const END_DATE = '2025-10-15';

  const UPDATE_INTERVAL_SECONDS = 60;

  // ==================== EXECUTION ====================

  if (FORWARD_TEST) {
    console.log('\n🚀 STARTING PAPER TRADING MODE');
    console.log('This will simulate live trading with real-time data');
    console.log('No real money is at risk - this is for testing only\n');

    const backtest = new ImprovedTradingBacktest(INITIAL_CAPITAL, LEVERAGE);

    await backtest.forwardTest(
      SYMBOL,
      INTERVAL,
      STRATEGY_MODE,
      USE_REGIME_PARAMS,
      UPDATE_INTERVAL_SECONDS
    );

  } else {
    console.log('='.repeat(70));
    console.log('IMPROVED CRYPTO SCALPING BACKTEST');
    console.log('WITH DYNAMIC PROFIT PROTECTION 🛡️');
    console.log('='.repeat(70));

    console.log('\nStep 1: Comparing strategies to find the best one...');
    const comparison = await compareStrategiesBacktest(
      SYMBOL, INTERVAL, START_DATE, END_DATE, INITIAL_CAPITAL, LEVERAGE
    );

    console.log('\n\nStep 2: Running detailed backtest on chosen strategy...');
    console.log(`Strategy: ${STRATEGY_MODE}`);
    console.log(`Leverage: ${LEVERAGE}x`);
    console.log(`Adaptive Parameters: ${USE_REGIME_PARAMS}`);

    const fetcher = new BinanceDataFetcher();
    const data = await fetcher.downloadHistoricalData(SYMBOL, INTERVAL, START_DATE, END_DATE);

    const backtest = new ImprovedTradingBacktest(INITIAL_CAPITAL, LEVERAGE);

    const { trades, equityCurve, signals, regimeLog } = backtest.backtest(
      data,
      STRATEGY_MODE,
      USE_REGIME_PARAMS,
      INTERVAL
    );

    const metrics = backtest.calculateMetrics(trades, equityCurve, data);

    console.log('\n' + '='.repeat(70));
    console.log('DETAILED BACKTEST RESULTS');
    console.log('='.repeat(70));
    console.log(`Initial Capital: ${INITIAL_CAPITAL.toLocaleString()}`);
    console.log(`Final Capital: ${metrics.finalCapital.toFixed(2)}`);
    console.log(`Total Return: ${(metrics.totalReturn * 100).toFixed(2)}%`);
    console.log(`Buy & Hold Return: ${(metrics.buyHoldReturn * 100).toFixed(2)}%`);
    console.log(`Outperformance: ${(metrics.outperformance * 100).toFixed(2)}%`);
    console.log(`\nTotal Trades: ${metrics.totalTrades}`);
    console.log(`Winning Trades: ${metrics.winningTrades}`);
    console.log(`Losing Trades: ${metrics.losingTrades}`);
    console.log(`Liquidations: ${metrics.liquidations}`);
    console.log(`Win Rate: ${(metrics.winRate * 100).toFixed(2)}%`);
    console.log(`Profit Factor: ${metrics.profitFactor.toFixed(2)}`);
    console.log(`\nProfit Protected Exits: ${metrics.profitProtectedExits} (${metrics.profitProtectionRate})`);
    console.log(`Average Max Profit: ${metrics.avgMaxProfitATR} ATR`);
    console.log(`\nAverage Win: ${metrics.avgWin.toFixed(2)}`);
    console.log(`Average Loss: ${metrics.avgLoss.toFixed(2)}`);
    console.log(`Max Drawdown: ${(metrics.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}`);
    console.log(`\nAverage Slippage: ${metrics.avgSlippage.toFixed(4)}`);
    console.log(`Total Funding Costs: ${metrics.totalFundingCosts.toFixed(2)}`);

    console.log('\n' + '='.repeat(70));
    console.log('PERFORMANCE BY MARKET REGIME');
    console.log('='.repeat(70));
    console.table(metrics.regimeStats);

    const regimeCounts = {};
    for (const regime of regimeLog) {
      regimeCounts[regime] = (regimeCounts[regime] || 0) + 1;
    }

    console.log('\nRegime Distribution:');
    for (const [regime, count] of Object.entries(regimeCounts)) {
      const pct = (count / regimeLog.length * 100).toFixed(1);
      console.log(`${regime}: ${count} bars (${pct}%)`);
    }

    backtest.realityCheck(metrics);

    console.log('\n' + '='.repeat(70));

    if (trades.length > 0) {
      console.log('\nRecent Trades (last 10):');
      const recentTrades = trades.slice(-10).map(t => ({
        Entry: t.entryTime.toISOString().slice(11, 19),
        Exit: t.exitTime.toISOString().slice(11, 19),
        Dir: t.direction.toUpperCase(),
        EntryP: t.entryPrice.toFixed(2),
        ExitP: t.exitPrice.toFixed(2),
        'P&L': t.pnl.toFixed(2),
        'Return%': (t.return * 100).toFixed(2),
        'MaxATR': t.maxProfitATR,
        Regime: t.regime,
        Exit: t.exitReason
      }));
      console.table(recentTrades);

      await fs.writeFile('backtest_trades.json', JSON.stringify(trades, null, 2));
      console.log('\n✅ Trades saved to backtest_trades.json');
    }

    const equityData = equityCurve.map((equity, i) => ({
      index: i,
      equity,
      regime: regimeLog[i] || 'UNKNOWN'
    }));
    await fs.writeFile('backtest_equity_curve.json', JSON.stringify(equityData, null, 2));
    console.log('✅ Equity curve saved to backtest_equity_curve.json');

    await fs.writeFile('strategy_comparison.json', JSON.stringify(comparison, null, 2));
    console.log('✅ Strategy comparison saved to strategy_comparison.json');

    console.log('\n' + '='.repeat(70));
    console.log('NEXT STEPS:');
    console.log('='.repeat(70));
    console.log('1. Review the profit protection stats above');
    console.log('2. Check that "Profit Protected Exits" rate is healthy (30-60%)');
    console.log('3. If results look good, set FORWARD_TEST = true');
    console.log('4. Run paper trading for AT LEAST 2-4 weeks');
    console.log('5. Compare paper trading results to backtest (expect 20-30% worse)');
    console.log('6. Only go live if paper trading validates the strategy');
    console.log('7. Start with 1-5% of intended capital and 1-2x leverage');
    console.log('='.repeat(70));
  }
}

main().catch(console.error);
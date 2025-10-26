const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// ============= UTILITY CLASSES =============

// Statistical analysis helpers (rolling windows, mean, std, ema, etc.)
class Stats {
  static rolling(arr, w, fn) {
    const res = new Array(arr.length).fill(NaN);
    for (let i = w - 1; i < arr.length; i++) res[i] = fn(arr.slice(i - w + 1, i + 1));
    return res;
  }
  static mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
  static std(a) {
    const m = Stats.mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  }
  static max(a) { return Math.max(...a); }
  static min(a) { return Math.min(...a); }
  static ema(data, period) {
    const k = 2 / (period + 1), res = [data[0]];
    for (let i = 1; i < data.length; i++) res[i] = data[i] * k + res[i - 1] * (1 - k);
    return res;
  }
}

// Binance API data fetcher with caching
class BinanceFetcher {
  constructor(cacheDir = 'binance_cache') {
    this.baseUrl = 'https://api.binance.com/api/v3/klines';
    this.cacheDir = cacheDir;
    this.ensureCacheDir();
  }

  async ensureCacheDir() {
    try { await fs.mkdir(this.cacheDir, { recursive: true }); } 
    catch (e) { console.error('Cache dir error:', e); }
  }

  getCacheFile(symbol, interval, start, end) {
    return path.join(this.cacheDir, `${symbol}_${interval}_${start}_${end}.json`);
  }

  async fetchKlines(symbol, interval, startTime, endTime, limit = 1000) {
    try {
      const { data } = await axios.get(this.baseUrl, {
        params: { symbol, interval, startTime, endTime, limit }
      });
      return data;
    } catch (e) { console.error('Fetch error:', e.message); return null; }
  }

  // Get latest candles for forward testing
  async getLatestCandles(symbol, interval, limit = 500) {
    try {
      const { data } = await axios.get(this.baseUrl, { params: { symbol, interval, limit } });
      return data.map(c => ({
        timestamp: new Date(c[0]), open: +c[1], high: +c[2], low: +c[3],
        close: +c[4], volume: +c[5], closeTime: new Date(c[6]),
        quoteVolume: +c[7], trades: +c[8], takerBuyBase: +c[9],
        takerBuyQuote: +c[10], isClosed: c[6] < Date.now()
      }));
    } catch (e) { console.error('Latest candles error:', e.message); return null; }
  }

  // Download historical data with caching
  async downloadHistoricalData(symbol, interval, startDate, endDate) {
    const cacheFile = this.getCacheFile(symbol, interval, startDate, endDate);
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      console.log(`Loaded cached: ${cacheFile}`);
      return JSON.parse(cached);
    } catch (e) {
      console.log(`Downloading ${symbol} ${interval} from ${startDate} to ${endDate}`);
    }

    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();
    const intervalMs = {
      '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
      '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000,
      '12h': 43200000, '1d': 86400000
    };
    const chunkSize = intervalMs[interval] * 1000;
    const allData = [];
    let currentStart = startTs;

    while (currentStart < endTs) {
      const currentEnd = Math.min(currentStart + chunkSize, endTs);
      const data = await this.fetchKlines(symbol, interval, currentStart, currentEnd);
      if (!data) break;
      allData.push(...data);
      console.log(`Downloaded ${data.length} candles. Total: ${allData.length}`);
      if (data.length < 1000) break;
      currentStart = data[data.length - 1][0] + intervalMs[interval];
      await new Promise(r => setTimeout(r, 200));
    }

    const df = allData.map(c => ({
      timestamp: new Date(c[0]), open: +c[1], high: +c[2], low: +c[3],
      close: +c[4], volume: +c[5], closeTime: new Date(c[6]),
      quoteVolume: +c[7], trades: +c[8], takerBuyBase: +c[9],
      takerBuyQuote: +c[10], isClosed: true
    }));

    await fs.writeFile(cacheFile, JSON.stringify(df, null, 2));
    console.log(`Cached to ${cacheFile}`);
    return df;
  }
}

// ============= MAIN BACKTEST ENGINE =============

class TradingBacktest {
  constructor(initialCap = 10000, lev = 1, makerFee = 0.0002, takerFee = 0.0004) {
    this.initialCapital = initialCap;
    this.leverage = lev;
    this.makerFee = makerFee;
    this.takerFee = takerFee;
    this.maintenanceMarginRate = 0.004;
    
    // Slippage model
    this.baseSlippage = 0.0003;
    this.volatilitySlippageMultiplier = 0.0002;
    this.stopSlippageATRMultiplier = 0.3;
    
    // DYNAMIC PROFIT PROTECTION SYSTEM
    // Two-tier trailing stops: wide pre-profit (2 ATR), tight post-profit (1→0.5 ATR)
    this.profitThresholdATR = 0.5; // Switch to profit protection after 0.5 ATR gain
    this.initialStopATR = 2.0; // Wide stop before profit (avoid noise)
    this.profitTrailingATR = 1.0; // Base trailing once profitable
    
    // Progressive tightening tiers based on profit level
    this.profitTiers = [
      { profitATR: 0.5, trailATR: 1.0 },   // Small profit: moderate protection
      { profitATR: 1.5, trailATR: 0.75 },  // Good profit: tighter protection
      { profitATR: 3.0, trailATR: 0.5 }    // Great profit: very tight protection
    ];
    
    // Regime-specific stop adjustments (subtle)
    this.regimeMultipliers = {
      bull: { initial: 1.0, profit: 1.2 },   // Slightly wider in trends
      bear: { initial: 1.0, profit: 1.2 },
      range: { initial: 1.0, profit: 0.8 }   // Tighter in range
    };
  }

  // Calculate entry slippage based on volatility
  calcSlippage(price, side, atr) {
    const vol = atr / price;
    const slip = this.baseSlippage + vol * this.volatilitySlippageMultiplier;
    return side === 'buy' ? price * (1 + slip) : price * (1 - slip);
  }

  // Calculate stop order slippage (stops execute worse than limit orders)
  calcStopSlip(stopPrice, side, atr) {
    const slip = atr * this.stopSlippageATRMultiplier;
    return side === 'long' ? Math.max(0, stopPrice - slip) : stopPrice + slip;
  }

  // Calculate liquidation price for leveraged position
  calcLiqPrice(entryPrice, lev, side) {
    return side === 'long'
      ? entryPrice * (1 - 1 / lev + this.maintenanceMarginRate)
      : entryPrice * (1 + 1 / lev - this.maintenanceMarginRate);
  }

  // Calculate perpetual futures funding costs (charged every 8 hours)
  calcFundingCost(posVal, hoursHeld, fundingRate = 0.0001) {
    return posVal * fundingRate * Math.floor(hoursHeld / 8);
  }

  // CORE: Dynamic trailing stop calculator
  // Adapts based on profit level and market regime
  calcDynamicTrail(curPrice, entryPrice, curAtr, pos, regime) {
    const profitAmt = pos === 1 ? curPrice - entryPrice : entryPrice - curPrice;
    const profitInATR = profitAmt / curAtr;
    
    const regType = regime.bull ? 'bull' : regime.bear ? 'bear' : 'range';
    const mults = this.regimeMultipliers[regType];
    
    // Pre-profit: use wide initial stop
    if (profitInATR < this.profitThresholdATR) {
      const stopDist = this.initialStopATR * curAtr * mults.initial;
      return pos === 1 ? curPrice - stopDist : curPrice + stopDist;
    }
    
    // Post-profit: progressive tightening based on profit tiers
    let trailATR = this.profitTrailingATR;
    for (const tier of this.profitTiers) {
      if (profitInATR >= tier.profitATR) trailATR = tier.trailATR;
    }
    trailATR *= mults.profit;
    
    const stopDist = trailATR * curAtr;
    return pos === 1 ? curPrice - stopDist : curPrice + stopDist;
  }

  // Technical indicators
  calcATR(data, period = 14) {
    const atr = new Array(data.length).fill(NaN);
    for (let i = 1; i < data.length; i++) {
      if (i >= period) {
        const trSlice = [];
        for (let j = i - period + 1; j <= i; j++) {
          const tr1 = data[j].high - data[j].low;
          const tr2 = j > 0 ? Math.abs(data[j].high - data[j - 1].close) : 0;
          const tr3 = j > 0 ? Math.abs(data[j].low - data[j - 1].close) : 0;
          trSlice.push(Math.max(tr1, tr2, tr3));
        }
        atr[i] = Stats.mean(trSlice);
      }
    }
    return atr;
  }

  calcRSI(data, period = 14) {
    const rsi = new Array(data.length).fill(NaN);
    for (let i = period; i < data.length; i++) {
      let gains = 0, losses = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const chg = data[j].close - data[j - 1].close;
        if (chg > 0) gains += chg; else losses += Math.abs(chg);
      }
      const avgG = gains / period, avgL = losses / period;
      rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return rsi;
  }

  calcEMA(data, period) {
    return Stats.ema(data.map(d => d.close), period);
  }

  // Detect market regime: bull/bear/range
  detectRegime(data, lookback = 50) {
    return data.map((d, i) => {
      if (i < lookback) return { bull: false, bear: false, range: true };
      const priceChg = (data[i].close - data[i - lookback].close) / data[i - lookback].close;
      const sma = Stats.mean(data.slice(Math.max(0, i - lookback), i + 1).map(d => d.close));
      const smaSlope = i >= lookback + 5
        ? (sma - Stats.mean(data.slice(i - lookback - 5, i - 4).map(d => d.close))) / sma
        : 0;
      const bull = priceChg > 0.10 && smaSlope > 0.001;
      const bear = priceChg < -0.10 && smaSlope < -0.001;
      return { bull, bear, range: !bull && !bear };
    });
  }

  // Generate trading signals based on strategy mode
  generateSignals(data, strategyMode = 'adaptive') {
    const atr = this.calcATR(data);
    const rsi = this.calcRSI(data);
    const ema20 = this.calcEMA(data, 20);
    const ema50 = this.calcEMA(data, 50);
    const ema200 = this.calcEMA(data, 200);
    const regimes = this.detectRegime(data);

    return data.map((d, i) => {
      if (i < 200) return { long: false, short: false };

      const recentHigh = Math.max(...data.slice(Math.max(0, i - 20), i).map(d => d.high));
      const recentLow = Math.min(...data.slice(Math.max(0, i - 20), i).map(d => d.low));
      let long = false, short = false;

      // Strategy logic
      if (strategyMode === 'mean_reversion') {
        long = rsi[i] < 30 && d.close > ema200[i];
        short = rsi[i] > 70 && d.close < ema200[i];
      } else if (strategyMode === 'momentum') {
        long = d.close > recentHigh && rsi[i] > 50 && d.close > ema200[i] && ema20[i] > ema50[i];
        short = d.close < recentLow && rsi[i] < 50 && d.close < ema200[i] && ema20[i] < ema50[i];
      } else if (strategyMode === 'pullback') {
        long = d.close > ema200[i] && d.close < ema20[i] && rsi[i] > 40 && rsi[i] < 60 && rsi[i] > rsi[i - 1];
        short = d.close < ema200[i] && d.close > ema20[i] && rsi[i] > 40 && rsi[i] < 60 && rsi[i] < rsi[i - 1];
      } else if (strategyMode === 'bear_market') {
        long = rsi[i] < 25 && d.close > data[i - 1].close && d.volume > data[i - 1].volume * 1.2;
        short = (rsi[i] > 60 && d.close < ema200[i] && ema20[i] < ema50[i]) ||
                (d.close < ema20[i] && data[i - 1].close > ema20[i - 1] && d.close < ema200[i]) ||
                (d.close < recentLow && d.close < ema200[i]);
      } else { // adaptive
        const bullLong = regimes[i].bull && d.close > ema200[i] && d.close < ema20[i] &&
                        rsi[i] > 40 && rsi[i] < 60 && rsi[i] > rsi[i - 1];
        const bearShort = regimes[i].bear && rsi[i] > 60 && d.close < ema200[i] && ema20[i] < ema50[i];
        const bearLong = regimes[i].bear && rsi[i] < 25 && d.close > data[i - 1].close;
        const rangeLong = regimes[i].range && rsi[i] < 30;
        const rangeShort = regimes[i].range && rsi[i] > 70;
        long = bullLong || bearLong || rangeLong;
        short = bearShort || rangeShort;
      }

      return { long, short, atr: atr[i], rsi: rsi[i], ema20: ema20[i], ema50: ema50[i], ema200: ema200[i], regime: regimes[i] };
    });
  }

  // Get regime-specific position sizing parameters
  getRegimeParams(isBull, isBear) {
    if (isBull) return { positionSizePct: 0.5, minHoldBars: 3 };
    if (isBear) return { positionSizePct: 0.3, minHoldBars: 3 };
    return { positionSizePct: 0.4, minHoldBars: 3 };
  }

  // Main backtest engine
  backtest(data, strategyMode = 'adaptive', useRegimeParams = true) {
    const signals = this.generateSignals(data, strategyMode);
    let capital = this.initialCapital, position = 0, entryPrice = 0, entryBar = 0;
    let trailingStop = 0, positionQty = 0, liquidationPrice = 0, maxProfitATR = 0;
    const trades = [], equityCurve = [], regimeLog = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i], signal = signals[i], curPrice = row.close, curAtr = signal.atr;
      if (isNaN(curAtr)) { equityCurve.push(capital); continue; }

      const params = useRegimeParams
        ? this.getRegimeParams(signal.regime.bull, signal.regime.bear)
        : { positionSizePct: 0.5, minHoldBars: 3 };
      const regime = signal.regime.bull ? 'BULL' : signal.regime.bear ? 'BEAR' : 'RANGE';
      regimeLog.push(regime);

      // Check liquidation
      if (position !== 0 && ((position === 1 && curPrice <= liquidationPrice) ||
                             (position === -1 && curPrice >= liquidationPrice))) {
        const marginLost = entryPrice * positionQty;
        capital -= marginLost;
        trades.push({
          entryTime: data[entryBar].timestamp, exitTime: row.timestamp,
          direction: position === 1 ? 'long' : 'short', entryPrice, exitPrice: liquidationPrice,
          barsHeld: i - entryBar, pnl: -marginLost, return: -1, exitReason: 'liquidation',
          regime, maxProfitATR: maxProfitATR.toFixed(2)
        });
        console.warn(`⚠️ LIQUIDATION at bar ${i}! Price: ${curPrice.toFixed(2)}`);
        position = 0;
        continue;
      }

      // Manage open positions with dynamic trailing stops
      if (position !== 0) {
        const barsHeld = i - entryBar;
        const hoursHeld = barsHeld * 0.25;
        const profitAmt = position === 1 ? curPrice - entryPrice : entryPrice - curPrice;
        const profitInATR = profitAmt / curAtr;
        maxProfitATR = Math.max(maxProfitATR, profitInATR);

        // Update trailing stop (only moves in favorable direction)
        const newTrail = this.calcDynamicTrail(curPrice, entryPrice, curAtr, position, signal.regime);
        if (position === 1) trailingStop = Math.max(trailingStop, newTrail);
        else trailingStop = Math.min(trailingStop, newTrail);

        const stopHit = position === 1 ? curPrice <= trailingStop : curPrice >= trailingStop;
        if (stopHit) {
          const exitPrice = this.calcStopSlip(trailingStop, position === 1 ? 'long' : 'short', curAtr);
          const pnl = position === 1
            ? (exitPrice - entryPrice) * positionQty * this.leverage
            : (entryPrice - exitPrice) * positionQty * this.leverage;
          const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
          const fundingCost = this.calcFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
          const netPnl = pnl - exitFee - fundingCost;
          capital += netPnl;

          const exitReason = profitInATR > this.profitThresholdATR ? 'profit_protection' : 'initial_stop';
          trades.push({
            entryTime: data[entryBar].timestamp, exitTime: row.timestamp,
            direction: position === 1 ? 'long' : 'short', entryPrice, exitPrice, barsHeld,
            pnl: netPnl, return: netPnl / (entryPrice * positionQty), exitReason, regime,
            fundingCost, slippage: Math.abs(trailingStop - exitPrice),
            maxProfitATR: maxProfitATR.toFixed(2)
          });
          position = 0;
          maxProfitATR = 0;
        }
      }

      // Enter new positions
      if (position === 0 && capital > 0) {
        if (signal.long || signal.short) {
          const tradeCapital = capital * params.positionSizePct;
          entryPrice = this.calcSlippage(curPrice, signal.long ? 'buy' : 'sell', curAtr);
          const entryFee = tradeCapital * this.leverage * this.takerFee;
          positionQty = (tradeCapital - entryFee) / entryPrice;
          entryBar = i;
          position = signal.long ? 1 : -1;
          maxProfitATR = 0;
          trailingStop = this.calcDynamicTrail(entryPrice, entryPrice, curAtr, position, signal.regime);
          liquidationPrice = this.calcLiqPrice(entryPrice, this.leverage, signal.long ? 'long' : 'short');
        }
      }
      equityCurve.push(capital);
    }

    // Close remaining position at end
    if (position !== 0) {
      const exitPrice = data[data.length - 1].close;
      const hoursHeld = (data.length - entryBar) * 0.25;
      const pnl = position === 1
        ? (exitPrice - entryPrice) * positionQty * this.leverage
        : (entryPrice - exitPrice) * positionQty * this.leverage;
      const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
      const fundingCost = this.calcFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
      const netPnl = pnl - exitFee - fundingCost;
      capital += netPnl;
      trades.push({
        entryTime: data[entryBar].timestamp, exitTime: data[data.length - 1].timestamp,
        direction: position === 1 ? 'long' : 'short', entryPrice, exitPrice,
        barsHeld: data.length - entryBar, pnl: netPnl,
        return: netPnl / (entryPrice * positionQty), exitReason: 'end_of_data',
        regime: regimeLog[regimeLog.length - 1], fundingCost,
        maxProfitATR: maxProfitATR.toFixed(2)
      });
    }

    return { trades, equityCurve, signals, regimeLog };
  }

  // Forward testing (paper trading with live data)
  async forwardTest(symbol, interval, strategyMode = 'adaptive', useRegimeParams = true, updateInterval = 60) {
    console.log('\n' + '='.repeat(70));
    console.log('FORWARD TEST (PAPER TRADING) WITH DYNAMIC PROFIT PROTECTION 🛡️');
    console.log('='.repeat(70));
    console.log(`Symbol: ${symbol} | Interval: ${interval} | Strategy: ${strategyMode}`);
    console.log(`Leverage: ${this.leverage}x | Capital: $${this.initialCapital.toLocaleString()}`);
    console.log(`\nProfit Protection: ${this.initialStopATR} ATR → ${this.profitThresholdATR} ATR threshold → ${this.profitTrailingATR}-${this.profitTiers[this.profitTiers.length-1].trailATR} ATR trailing`);
    console.log('Press Ctrl+C to stop\n' + '='.repeat(70));

    const fetcher = new BinanceFetcher();
    let capital = this.initialCapital, position = 0, entryPrice = 0, entryTime = null;
    let trailingStop = 0, positionQty = 0, liquidationPrice = 0, maxProfitATR = 0;
    const trades = [], startTime = new Date();

    const shutdown = async () => {
      console.log('\n' + '='.repeat(70) + '\n⚠️  SHUTDOWN - CLOSING POSITIONS\n' + '='.repeat(70));
      if (position !== 0) {
        const data = await fetcher.getLatestCandles(symbol, interval, 10);
        const exitPrice = data.slice(0, -1)[data.length - 2].close;
        const exitTime = data.slice(0, -1)[data.length - 2].timestamp;
        const hoursHeld = (Date.now() - entryTime.getTime()) / 3600000;
        const pnl = position === 1 ? (exitPrice - entryPrice) * positionQty * this.leverage
                                   : (entryPrice - exitPrice) * positionQty * this.leverage;
        const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
        const fundingCost = this.calcFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
        const netPnl = pnl - exitFee - fundingCost;
        capital += netPnl;
        trades.push({
          entryTime, exitTime, direction: position === 1 ? 'long' : 'short',
          entryPrice, exitPrice, pnl: netPnl, return: netPnl / (entryPrice * positionQty),
          exitReason: 'manual_shutdown', regime: 'UNKNOWN', fundingCost,
          maxProfitATR: maxProfitATR.toFixed(2)
        });
        console.log(`Position closed at ${exitPrice.toFixed(2)} | P&L: ${netPnl.toFixed(2)} | Max Profit: ${maxProfitATR.toFixed(2)} ATR`);
      }
      console.log(`\nFinal Capital: ${capital.toFixed(2)} | Return: ${((capital - this.initialCapital) / this.initialCapital * 100).toFixed(2)}%`);
      console.log(`Total Trades: ${trades.length}`);
      if (trades.length > 0) {
        const wins = trades.filter(t => t.pnl > 0).length;
        const protectedCapital = trades.filter(t => t.exitReason === 'profit_protection').length;
        console.log(`Win Rate: ${(wins / trades.length * 100).toFixed(1)}% | Profit protectedCapital: ${protectedCapital} (${(protectedCapital/trades.length*100).toFixed(1)}%)`);
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    let lastClosedTime = null;

    while (true) {
      try {
        const rawData = await fetcher.getLatestCandles(symbol, interval, 501);
        if (!rawData || rawData.length < 201) {
          console.log('Fetch failed, retrying...');
          await new Promise(r => setTimeout(r, updateInterval * 1000));
          continue;
        }

        const data = rawData.slice(0, -1);
        const latest = data[data.length - 1];
        if (lastClosedTime && latest.closeTime <= lastClosedTime) {
          await new Promise(r => setTimeout(r, updateInterval * 1000));
          continue;
        }
        lastClosedTime = latest.closeTime;

        const signals = this.generateSignals(data, strategyMode);
        const signal = signals[signals.length - 1];
        const curPrice = latest.close, curTime = latest.timestamp, curAtr = signal.atr;
        if (isNaN(curAtr)) { await new Promise(r => setTimeout(r, updateInterval * 1000)); continue; }

        const regime = signal.regime.bull ? 'BULL' : signal.regime.bear ? 'BEAR' : 'RANGE';
        const params = useRegimeParams ? this.getRegimeParams(signal.regime.bull, signal.regime.bear)
                                       : { positionSizePct: 0.5, minHoldBars: 3 };

        console.log(`\n[${curTime.toISOString()}] ${curPrice.toFixed(2)} | ${regime} | Capital: ${capital.toFixed(2)}`);
        console.log(`RSI: ${signal.rsi.toFixed(1)} | ATR: ${curAtr.toFixed(2)}`);

        // Check liquidation
        if (position !== 0 && ((position === 1 && curPrice <= liquidationPrice) ||
                               (position === -1 && curPrice >= liquidationPrice))) {
          const marginLost = entryPrice * positionQty;
          capital -= marginLost;
          trades.push({
            entryTime, exitTime: curTime, direction: position === 1 ? 'long' : 'short',
            entryPrice, exitPrice: liquidationPrice, pnl: -marginLost, return: -1,
            exitReason: 'liquidation', regime, maxProfitATR: maxProfitATR.toFixed(2)
          });
          console.log(`🚨 LIQUIDATION at ${liquidationPrice.toFixed(2)}`);
          position = 0;
          continue;
        }

        // Manage open position
        if (position !== 0) {
          const hoursHeld = (curTime - entryTime) / 3600000;
          const profitAmt = position === 1 ? curPrice - entryPrice : entryPrice - curPrice;
          const profitInATR = profitAmt / curAtr;
          maxProfitATR = Math.max(maxProfitATR, profitInATR);

          const newTrail = this.calcDynamicTrail(curPrice, entryPrice, curAtr, position, signal.regime);
          if (position === 1) {
            if (newTrail > trailingStop) {
              trailingStop = newTrail;
              console.log(`📈 Trailing tightened: ${trailingStop.toFixed(2)} (Profit: ${profitInATR.toFixed(2)} ATR)`);
            }
          } else {
            if (newTrail < trailingStop) {
              trailingStop = newTrail;
              console.log(`📉 Trailing tightened: ${trailingStop.toFixed(2)} (Profit: ${profitInATR.toFixed(2)} ATR)`);
            }
          }

          const positionPnl = position === 1
            ? (curPrice - entryPrice) * positionQty * this.leverage
            : (entryPrice - curPrice) * positionQty * this.leverage;
          const pnlPct = (positionPnl / (entryPrice * positionQty)) * 100;
          const unrealizedFee = curPrice * positionQty * this.leverage * this.takerFee;
          const fundingCost = this.calcFundingCost(curPrice * positionQty * this.leverage, hoursHeld);
          const netPnl = positionPnl - unrealizedFee - fundingCost;
          const netPct = (netPnl / (entryPrice * positionQty)) * 100;
          const status = profitInATR >= this.profitThresholdATR ? '🛡️ protectedCapital' : '⏳ INITIAL';

          console.log(`Position: ${position === 1 ? 'LONG' : 'SHORT'} ${this.leverage}x | Entry: ${entryPrice.toFixed(2)} | ${status}`);
          console.log(`P&L: ${positionPnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) | Net: ${netPnl.toFixed(2)} (${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}%)`);
          console.log(`Profit: ${profitInATR.toFixed(2)} ATR (Max: ${maxProfitATR.toFixed(2)}) | Stop: ${trailingStop.toFixed(2)} | Liq: ${liquidationPrice.toFixed(2)}`);

          const stopHit = position === 1 ? curPrice <= trailingStop : curPrice >= trailingStop;
          if (stopHit) {
            const exitPrice = this.calcStopSlip(trailingStop, position === 1 ? 'long' : 'short', curAtr);
            const pnl = position === 1
              ? (exitPrice - entryPrice) * positionQty * this.leverage
              : (entryPrice - exitPrice) * positionQty * this.leverage;
            const exitFee = exitPrice * positionQty * this.leverage * this.takerFee;
            const totalFunding = this.calcFundingCost(exitPrice * positionQty * this.leverage, hoursHeld);
            const finalPnl = pnl - exitFee - totalFunding;
            capital += finalPnl;

            const exitReason = profitInATR > this.profitThresholdATR ? 'profit_protection' : 'initial_stop';
            trades.push({
              entryTime, exitTime: curTime, direction: position === 1 ? 'long' : 'short',
              entryPrice, exitPrice, pnl: finalPnl, return: finalPnl / (entryPrice * positionQty),
              exitReason, regime, fundingCost: totalFunding,
              slippage: Math.abs(trailingStop - exitPrice), maxProfitATR: maxProfitATR.toFixed(2)
            });

            const emoji = finalPnl > 0 ? '✅' : '❌';
            const reasonEmoji = exitReason === 'profit_protection' ? '🛡️' : '🔴';
            console.log(`${emoji} EXIT ${position === 1 ? 'LONG' : 'SHORT'}: ${exitPrice.toFixed(2)} ${reasonEmoji}`);
            console.log(`   P&L: ${finalPnl.toFixed(2)} (${((finalPnl/(entryPrice*positionQty)*100)).toFixed(2)}%)`);
            console.log(`   Max Profit: ${maxProfitATR.toFixed(2)} ATR | Reason: ${exitReason}`);
            position = 0;
            maxProfitATR = 0;
          }
        } else if (position === 0 && capital > 0) {
          // Enter new position
          if (signal.long || signal.short) {
            const tradeCapital = capital * params.positionSizePct;
            entryPrice = this.calcSlippage(curPrice, signal.long ? 'buy' : 'sell', curAtr);
            const entryFee = tradeCapital * this.leverage * this.takerFee;
            positionQty = (tradeCapital - entryFee) / entryPrice;
            entryTime = curTime;
            position = signal.long ? 1 : -1;
            maxProfitATR = 0;
            trailingStop = this.calcDynamicTrail(entryPrice, entryPrice, curAtr, position, signal.regime);
            liquidationPrice = this.calcLiqPrice(entryPrice, this.leverage, signal.long ? 'long' : 'short');

            console.log(`✅ ENTER ${signal.long ? 'LONG' : 'SHORT'} ${this.leverage}x: ${entryPrice.toFixed(2)} | Qty: ${positionQty.toFixed(4)}`);
            console.log(`   Initial Stop: ${trailingStop.toFixed(2)} (${this.initialStopATR} ATR) | Liq: ${liquidationPrice.toFixed(2)}`);
            const protectionPrice = signal.long
              ? entryPrice + this.profitThresholdATR * curAtr
              : entryPrice - this.profitThresholdATR * curAtr;
            console.log(`   Protection activates at: ${protectionPrice.toFixed(2)} (${this.profitThresholdATR} ATR)`);
          }
        }

        await new Promise(r => setTimeout(r, updateInterval * 1000));
      } catch (e) {
        console.error('Loop error:', e.message);
        await new Promise(r => setTimeout(r, updateInterval * 1000));
      }
    }
  }

  // Calculate performance metrics
  calcMetrics(trades, equityCurve, data) {
    if (!trades || trades.length === 0) {
      return {
        totalTrades: 0, winRate: 0, totalReturn: 0, maxDrawdown: 0,
        sharpeRatio: 0, avgSlippage: 0, totalFundingCosts: 0,
        liquidations: 0, profitprotectedCapitalExits: 0
      };
    }

    const total = trades.length;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const winRate = wins.length / total;
    const liquidations = trades.filter(t => t.exitReason === 'liquidation').length;
    const protectedCapital = trades.filter(t => t.exitReason === 'profit_protection').length;

    const totalReturn = (equityCurve[equityCurve.length - 1] - this.initialCapital) / this.initialCapital;
    const avgWin = wins.length > 0 ? Stats.mean(wins.map(t => t.pnl)) : 0;
    const avgLoss = losses.length > 0 ? Stats.mean(losses.map(t => t.pnl)) : 0;
    const totalFunding = trades.reduce((s, t) => s + (t.fundingCost || 0), 0);
    const avgSlip = trades.filter(t => t.slippage).length > 0
      ? Stats.mean(trades.filter(t => t.slippage).map(t => Math.abs(t.slippage))) : 0;

    let maxDD = 0, peak = equityCurve[0];
    for (const eq of equityCurve) {
      if (eq > peak) peak = eq;
      const dd = (eq - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }

    const returns = equityCurve.slice(1).map((v, i) => (v - equityCurve[i]) / equityCurve[i]);
    const meanRet = Stats.mean(returns);
    const stdRet = Stats.std(returns);
    const sharpe = returns.length > 0 && stdRet !== 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;

    const buyHold = (data[data.length - 1].close - data[0].close) / data[0].close;

    const regimeStats = {};
    for (const t of trades) {
      if (!regimeStats[t.regime]) regimeStats[t.regime] = { sum: 0, count: 0, wins: 0 };
      regimeStats[t.regime].sum += t.pnl;
      regimeStats[t.regime].count++;
      if (t.pnl > 0) regimeStats[t.regime].wins++;
    }
    for (const r in regimeStats) {
      regimeStats[r].mean = regimeStats[r].sum / regimeStats[r].count;
      regimeStats[r].winRate = (regimeStats[r].wins / regimeStats[r].count * 100).toFixed(1) + '%';
    }

    const profitFactor = wins.length > 0 && losses.length > 0
      ? Math.abs(wins.reduce((a, b) => a + b.pnl, 0) / losses.reduce((a, b) => a + b.pnl, 0)) : 0;

    const avgMaxProfit = trades.filter(t => t.maxProfitATR).length > 0
      ? Stats.mean(trades.filter(t => t.maxProfitATR).map(t => parseFloat(t.maxProfitATR))) : 0;

    return {
      totalTrades: total, winningTrades: wins.length, losingTrades: losses.length,
      winRate, avgWin, avgLoss, profitFactor, totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
      totalReturn, maxDrawdown: maxDD, sharpeRatio: sharpe,
      finalCapital: equityCurve[equityCurve.length - 1], buyHoldReturn: buyHold,
      outperformance: totalReturn - buyHold, regimeStats, avgSlippage: avgSlip,
      totalFundingCosts: totalFunding, liquidations, profitprotectedCapitalExits: protectedCapital,
      profitProtectionRate: (protectedCapital / total * 100).toFixed(1) + '%',
      avgMaxProfitATR: avgMaxProfit.toFixed(2)
    };
  }

  // Reality check for unrealistic results
  realityCheck(metrics) {
    const warns = [];
    if (metrics.winRate > 0.70) warns.push('⚠️  Win rate > 70% unusual for scalping');
    if (metrics.sharpeRatio > 3.0) warns.push('⚠️  Sharpe > 3 extremely rare in live trading');
    if (Math.abs(metrics.maxDrawdown) < 0.05) warns.push('⚠️  Max DD < 5% unrealistic for crypto');
    if (metrics.profitFactor > 3.0) warns.push('⚠️  Profit factor > 3 rarely sustained');
    if (metrics.liquidations > metrics.totalTrades * 0.1) warns.push('⚠️  Liquidation rate > 10% very dangerous');
    if (metrics.totalFundingCosts / Math.abs(metrics.totalPnl) > 0.2) warns.push('⚠️  Funding costs > 20% of P&L');

    if (warns.length > 0) {
      console.log('\n' + '='.repeat(70));
      console.log('🚨 REALITY CHECK WARNINGS:');
      console.log('='.repeat(70));
      warns.forEach(w => console.log(w));
      console.log('\nBacktest may be overfitted. STRONGLY RECOMMENDED: Paper trade 2-4 weeks before live.');
      console.log('='.repeat(70));
    } else {
      console.log('\n✅ Reality check passed - results appear reasonable');
    }

    console.log('\n' + '='.repeat(70));
    console.log('🛡️  PROFIT PROTECTION ANALYSIS');
    console.log('='.repeat(70));
    console.log(`protectedCapital Exits: ${metrics.profitprotectedCapitalExits} (${metrics.profitProtectionRate})`);
    console.log(`Avg Max Profit: ${metrics.avgMaxProfitATR} ATR`);
    console.log('Shows how well system locks in gains vs giving them back.');
    console.log('='.repeat(70));

    return warns.length === 0;
  }
}

// ============= MAIN EXECUTION =============

// Compare all strategies on historical data
async function compareStrategies(symbol, interval, start, end, capital, lev) {
  console.log('\n' + '='.repeat(70));
  console.log('STRATEGY COMPARISON WITH DYNAMIC PROFIT PROTECTION 🛡️');
  console.log('='.repeat(70));

  const fetcher = new BinanceFetcher();
  const data = await fetcher.downloadHistoricalData(symbol, interval, start, end);
  const bt = new TradingBacktest(capital, lev);
  const strategies = ['mean_reversion', 'momentum', 'pullback', 'bear_market', 'adaptive'];
  const results = [];

  for (const strat of strategies) {
    console.log(`\nBacktesting ${strat}...`);
    const { trades, equityCurve, signals } = bt.backtest(data, strat, true);
    const m = bt.calcMetrics(trades, equityCurve, data);
    results.push({
      Strategy: strat,
      'Return %': (m.totalReturn * 100).toFixed(2),
      Trades: m.totalTrades,
      'Win Rate %': (m.winRate * 100).toFixed(1),
      protectedCapital: m.profitProtectionRate,
      Sharpe: m.sharpeRatio.toFixed(2),
      'Max DD %': (m.maxDrawdown * 100).toFixed(2),
      Liquidations: m.liquidations
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
  console.log('✓ ADAPTIVE: Auto-switches based on regime (best for set-and-forget)');
  console.log('✓ MEAN_REVERSION: Buys oversold/sells overbought (best for ranging markets)');
  console.log('✓ MOMENTUM: Trades breakouts (best for strong bull trends)');
  console.log('✓ PULLBACK: Buys dips in uptrends (best for bull with corrections)');
  console.log('✓ BEAR_MARKET: Aggressive shorts (best for confirmed bear markets)');
  console.log('='.repeat(70));

  return results;
}

async function main() {
  // ========== CONFIG ==========
  const FORWARD_TEST = true; // true = paper trading, false = backtest
  const SYMBOL = 'NEARUSDT';
  const INTERVAL = '1h';
  const INITIAL_CAPITAL = 890;
  const LEVERAGE = 1;
  const STRATEGY_MODE = 'adaptive'; // adaptive, momentum, mean_reversion, pullback, bear_market
  const USE_REGIME_PARAMS = true;
  const START_DATE = '2025-10-01';
  const END_DATE = '2025-10-15';
  const UPDATE_INTERVAL_SECONDS = 60;

  // ========== EXECUTION ==========
  if (FORWARD_TEST) {
    console.log('\n🚀 PAPER TRADING MODE - No real money at risk\n');
    const bt = new TradingBacktest(INITIAL_CAPITAL, LEVERAGE);
    await bt.forwardTest(SYMBOL, INTERVAL, STRATEGY_MODE, USE_REGIME_PARAMS, UPDATE_INTERVAL_SECONDS);
  } else {
    console.log('='.repeat(70));
    console.log('CRYPTO SCALPING BACKTEST WITH DYNAMIC PROFIT PROTECTION 🛡️');
    console.log('='.repeat(70));

    console.log('\nStep 1: Comparing strategies...');
    const comp = await compareStrategies(SYMBOL, INTERVAL, START_DATE, END_DATE, INITIAL_CAPITAL, LEVERAGE);

    console.log('\n\nStep 2: Detailed backtest on chosen strategy...');
    console.log(`Strategy: ${STRATEGY_MODE} | Leverage: ${LEVERAGE}x | Adaptive: ${USE_REGIME_PARAMS}`);

    const fetcher = new BinanceFetcher();
    const data = await fetcher.downloadHistoricalData(SYMBOL, INTERVAL, START_DATE, END_DATE);
    const bt = new TradingBacktest(INITIAL_CAPITAL, LEVERAGE);
    const { trades, equityCurve, signals, regimeLog } = bt.backtest(data, STRATEGY_MODE, USE_REGIME_PARAMS);
    const m = bt.calcMetrics(trades, equityCurve, data);

    console.log('\n' + '='.repeat(70));
    console.log('DETAILED RESULTS');
    console.log('='.repeat(70));
    console.log(`Initial: ${INITIAL_CAPITAL.toLocaleString()} | Final: ${m.finalCapital.toFixed(2)}`);
    console.log(`Return: ${(m.totalReturn * 100).toFixed(2)}% | Buy&Hold: ${(m.buyHoldReturn * 100).toFixed(2)}%`);
    console.log(`Outperformance: ${(m.outperformance * 100).toFixed(2)}%`);
    console.log(`\nTrades: ${m.totalTrades} | Wins: ${m.winningTrades} | Losses: ${m.losingTrades} | Liq: ${m.liquidations}`);
    console.log(`Win Rate: ${(m.winRate * 100).toFixed(2)}% | Profit Factor: ${m.profitFactor.toFixed(2)}`);
    console.log(`protectedCapital Exits: ${m.profitprotectedCapitalExits} (${m.profitProtectionRate}) | Avg Max Profit: ${m.avgMaxProfitATR} ATR`);
    console.log(`\nAvg Win: ${m.avgWin.toFixed(2)} | Avg Loss: ${m.avgLoss.toFixed(2)}`);
    console.log(`Max DD: ${(m.maxDrawdown * 100).toFixed(2)}% | Sharpe: ${m.sharpeRatio.toFixed(2)}`);
    console.log(`\nAvg Slippage: ${m.avgSlippage.toFixed(4)} | Total Funding: ${m.totalFundingCosts.toFixed(2)}`);

    console.log('\n' + '='.repeat(70));
    console.log('PERFORMANCE BY REGIME');
    console.log('='.repeat(70));
    console.table(m.regimeStats);

    const regimeCounts = {};
    for (const r of regimeLog) regimeCounts[r] = (regimeCounts[r] || 0) + 1;
    console.log('\nRegime Distribution:');
    for (const [r, cnt] of Object.entries(regimeCounts)) {
      console.log(`${r}: ${cnt} bars (${(cnt / regimeLog.length * 100).toFixed(1)}%)`);
    }

    bt.realityCheck(m);
    console.log('\n' + '='.repeat(70));

    if (trades.length > 0) {
      console.log('\nRecent Trades (last 10):');
      const recent = trades.slice(-10).map(t => ({
        Entry: t.entryTime.toISOString().slice(11, 19),
        Exit: t.exitTime.toISOString().slice(11, 19),
        Dir: t.direction.toUpperCase(),
        EntryP: t.entryPrice.toFixed(2),
        ExitP: t.exitPrice.toFixed(2),
        'P&L': t.pnl.toFixed(2),
        'Ret%': (t.return * 100).toFixed(2),
        MaxATR: t.maxProfitATR,
        Regime: t.regime,
        Exit: t.exitReason
      }));
      console.table(recent);
      await fs.writeFile('backtest_trades.json', JSON.stringify(trades, null, 2));
      console.log('\n✅ Trades saved to backtest_trades.json');
    }

    const eqData = equityCurve.map((eq, i) => ({ index: i, equity: eq, regime: regimeLog[i] || 'UNKNOWN' }));
    await fs.writeFile('backtest_equity_curve.json', JSON.stringify(eqData, null, 2));
    console.log('✅ Equity curve saved to backtest_equity_curve.json');
    await fs.writeFile('strategy_comparison.json', JSON.stringify(comp, null, 2));
    console.log('✅ Strategy comparison saved to strategy_comparison.json');

    console.log('\n' + '='.repeat(70));
    console.log('NEXT STEPS:');
    console.log('='.repeat(70));
    console.log('1. Review profit protection stats (aim for 30-60% protectedCapital exit rate)');
    console.log('2. Set FORWARD_TEST = true and paper trade for 2-4 weeks minimum');
    console.log('3. Compare paper results to backtest (expect 20-30% worse performance)');
    console.log('4. Only go live if paper trading validates strategy');
    console.log('5. Start with 1-5% of capital and 1-2x leverage');
    console.log('='.repeat(70));
  }
}

main().catch(console.error);
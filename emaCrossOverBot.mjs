// ema-crossover-bot.js
// Node.js script for backtesting/forward-testing EMA 50/200 crossover strategy

import axios from "axios";

// ---------------- CONFIG ----------------
const config = {
  symbol: "NEARUSDT",
  interval: "3m", // "5m" or "15m"
  emaShort: 5,
  emaLong: 8,
  lotSize: 0.01,
  takeProfit: 5, // in USD (for simplicity, not "pips")
  stopLoss: 5,   // in USD
  maxTradesPerSide: 10,
  backtestLimit: 1000, // number of candles to fetch
  live: false, // true = forward test
  pollInterval: 30 * 1000 // 30s for forward testing
};
// -----------------------------------------

// Simple EMA calculator
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let emaArray = [];
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA start
  emaArray[period - 1] = ema;

  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    emaArray[i] = ema;
  }
  return emaArray;
}

// Simulate strategy
function runStrategy(candles) {
  const closes = candles.map(c => parseFloat(c[4]));
  const ema50 = calculateEMA(closes, config.emaShort);
  const ema200 = calculateEMA(closes, config.emaLong);

  let trades = [];
  let buyCount = 0, sellCount = 0;

  for (let i = config.emaLong; i < closes.length; i++) {
    let prev50 = ema50[i - 1], prev200 = ema200[i - 1];
    let now50 = ema50[i], now200 = ema200[i];
    let price = closes[i];

    // BUY: 50 crosses ABOVE 200
    if (prev50 < prev200 && now50 > now200 && buyCount < config.maxTradesPerSide) {
      trades.push({ type: "BUY", entry: price, sl: price - config.stopLoss, tp: price + config.takeProfit });
      buyCount++;
    }

    // SELL: 50 crosses BELOW 200
    if (prev50 > prev200 && now50 < now200 && sellCount < config.maxTradesPerSide) {
      trades.push({ type: "SELL", entry: price, sl: price + config.stopLoss, tp: price - config.takeProfit });
      sellCount++;
    }

    // Update open trades for SL/TP
    trades.forEach(t => {
      if (!t.closed) {
        if (t.type === "BUY") {
          if (price <= t.sl) { t.closed = true; t.result = -config.stopLoss; }
          else if (price >= t.tp) { t.closed = true; t.result = +config.takeProfit; }
        } else {
          if (price >= t.sl) { t.closed = true; t.result = -config.stopLoss; }
          else if (price <= t.tp) { t.closed = true; t.result = +config.takeProfit; }
        }
      }
    });
  }

  let closedTrades = trades.filter(t => t.closed);
  let profit = closedTrades.reduce((a, b) => a + b.result, 0);

  console.log("Backtest complete:");
  console.log("Closed Trades:", closedTrades.length);
  console.log("Total Profit (USD):", profit.toFixed(2));
  console.log("Win rate:", (closedTrades.filter(t => t.result > 0).length / closedTrades.length * 100).toFixed(2) + "%");
}

// Fetch candles from Binance
async function fetchCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url);
  return res.data;
}

// Run backtest or forward test
async function main() {
  if (!config.live) {
    // Backtest mode
    const candles = await fetchCandles(config.symbol, config.interval, config.backtestLimit);
    runStrategy(candles);
  } else {
    // Forward test mode (polling)
    console.log("Running forward test...");
    setInterval(async () => {
      const candles = await fetchCandles(config.symbol, config.interval, config.emaLong + 5);
      runStrategy(candles);
    }, config.pollInterval);
  }
}

main();

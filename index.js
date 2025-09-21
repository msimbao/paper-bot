#!/usr/bin/env node
import express from "express";
import fetch from "node-fetch";

// ==== CONFIG ====
const SYMBOL = "AVAXUSDT";     // Kraken symbol
const TIMEFRAME = 1;          // minutes
const EMA_PERIOD = 100;
const RSI_PERIOD = 14;
const RSI_ENTRY_THRESHOLD = 45;
const RSI_EXIT_TP1 = 100;
const RSI_EXIT_TP2 = 85;
const TP1_PCT = 1.2;
const TP2_PCT = 2.0;
const SL_PCT = -1.2;
const FEE_PCT = 0.001;
const SLIPPAGE_PCT = 0.0005;
const INITIAL_BALANCE = 898.0;
const LOOP_DELAY = 60 * 1000; // 1 min

// ==== STATE ====
let balance = INITIAL_BALANCE;
let holdings = 0.0;
let entryPrice = 0.0;
let wins = 0, losses = 0;
let since = null;

// ==== HELPERS ====
async function fetchOHLC(symbol, interval, sinceTs) {
  let url = `https://api.kraken.com/0/public/OHLC?pair=${symbol}&interval=${interval}`;
  if (sinceTs) url += `&since=${sinceTs}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const key = Object.keys(json.result)[0];
    return json.result[key].map(row => ({
      time: new Date(row[0] * 1000),
      close: parseFloat(row[4]),
    }));
  } catch (e) {
    console.error("❌ API Error", e);
    return [];
  }
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let emaArray = [values[0]];
  for (let i = 1; i < values.length; i++) {
    emaArray.push(values[i] * k + emaArray[i - 1] * (1 - k));
  }
  return emaArray;
}

function rsi(values, period) {
  let gains = [], losses = [];
  for (let i = 1; i < values.length; i++) {
    let diff = values[i] - values[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let rsiArray = [50]; // start neutral
  for (let i = period; i < values.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
    let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArray.push(100 - 100 / (1 + rs));
  }
  return Array(values.length - rsiArray.length).fill(50).concat(rsiArray);
}

// ==== STRATEGY LOOP ====
async function runLoop() {
  const candles = await fetchOHLC(SYMBOL, TIMEFRAME, since);
  if (candles.length === 0) return;

  const closes = candles.map(c => c.close);
  const emaValues = ema(closes, EMA_PERIOD);
  const rsiValues = rsi(closes, RSI_PERIOD);

  const last = candles[candles.length - 1];
  const price = last.close;
  const emaLast = emaValues[emaValues.length - 1];
  const rsiLast = rsiValues[rsiValues.length - 1];

  // BUY
  if (holdings === 0 && price > emaLast && rsiLast <= RSI_ENTRY_THRESHOLD) {
    let amount = balance / price;
    holdings = amount;
    entryPrice = price * (1 + SLIPPAGE_PCT);
    balance = 0;
    console.log(`${last.time.toISOString()} 🟢 BUY at ${entryPrice.toFixed(2)}`);
  }

  // SELL
  else if (holdings > 0) {
    let changePct = ((price - entryPrice) / entryPrice) * 100;
    if (changePct >= TP2_PCT || rsiLast >= RSI_EXIT_TP2) {
      balance = holdings * price * (1 - FEE_PCT);
      holdings = 0;
      if (changePct > 0) wins++; else losses++;
      console.log(`${last.time.toISOString()} 🔴 SELL (TP2) at ${price.toFixed(2)}, PnL: ${changePct.toFixed(2)}%`);
    } else if (changePct >= TP1_PCT || rsiLast >= RSI_EXIT_TP1) {
      balance = holdings * price * (1 - FEE_PCT);
      holdings = 0;
      if (changePct > 0) wins++; else losses++;
      console.log(`${last.time.toISOString()} 🔴 SELL (TP1) at ${price.toFixed(2)}, PnL: ${changePct.toFixed(2)}%`);
    } else if (changePct <= SL_PCT) {
      balance = holdings * price * (1 - FEE_PCT);
      holdings = 0;
      losses++;
      console.log(`${last.time.toISOString()} ❌ STOP LOSS at ${price.toFixed(2)}, PnL: ${changePct.toFixed(2)}%`);
    }
  }

  let finalValue = balance + holdings * price;
  let roi = ((finalValue - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  console.log(`💰 ${finalValue.toFixed(2)} USDT | ROI ${roi.toFixed(2)}% | W:${wins} L:${losses}`);

  since = Math.floor(last.time.getTime() / 1000);
}

// ==== SERVER ====
const app = express();
app.get("/", (req, res) => {
  res.json({
    balance,
    holdings,
    entryPrice,
    wins,
    losses,
    roi: ((balance + holdings) / INITIAL_BALANCE - 1) * 100,
  });
});

app.listen(3000, () => {
  console.log("🚀 Node server running on http://localhost:3000");
  setInterval(runLoop, LOOP_DELAY);
});

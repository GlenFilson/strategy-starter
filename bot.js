import WebSocket from "ws";
import Decimal from "decimal.js";
import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createExecutor } from "./exec.js";
import fs from "fs";
import path from "path";

const ASSET = "SOL";
//https://docs.pyth.network/price-feeds/core/price-feeds/price-feed-ids for price feed ids
const PYTH_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const WS_URL = "wss://hermes.pyth.network/ws";
const ws = new WebSocket(WS_URL); //creates a new websocket connection to Pyth
//simple logger function
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
// Keep output concise; set LOG_LEVEL=debug for verbose
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
function debug(message) {
  if (LOG_LEVEL === "debug") log(message);
}
//NOTE: CANDLESTICK_DURATION and CANDLESTICK_INTERVAL should match each other
const CANDLESTICK_DURATION = 1000 * 1; //milliseconds (1000 * X = X seconds)
//https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints refer for intervals for binance api
const CANDLESTICK_INTERVAL = "1s"; //for the binance api
const SYMBOL = "SOLUSDT"; //for the binance api
const CANDLESTICK_WINDOW_SIZE = 20; //how many candlesticks to keep track of

const SLIPPAGE_BPS = 50; // try 0.50% to reduce slippage failures
// Trade size: percent of portfolio notional (e.g., 0.2 = 20%)
const TRADE_PCT = 0.2;
const PRIORITY_FEE_LAMPORTS = 50000; // raise for fewer CU/priority failures
const ONLY_DIRECT_ROUTES = false; // allow routed paths for better reliability

const MINTS = {
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// Static infra for execution
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const JUP_BASE = "https://lite-api.jup.ag";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

function keypairFromEnv(privateKey) {
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");
  try {
    const decoded = bs58.decode(privateKey);
    return Keypair.fromSecretKey(decoded);
  } catch (_) {
    const arr = JSON.parse(privateKey);
    const u8 = Uint8Array.from(arr);
    return Keypair.fromSecretKey(u8);
  }
}

const connection = new Connection(RPC_URL, "confirmed");
let wallet = null;
try {
  wallet = keypairFromEnv(PRIVATE_KEY);
} catch (_) {
  wallet = null; // dry mode if not configured
}
// create execution helper
const executor = wallet
  ? createExecutor({
      connection,
      wallet,
      jupBase: JUP_BASE,
      priorityFeeLamports: PRIORITY_FEE_LAMPORTS,
      onlyDirectRoutes: ONLY_DIRECT_ROUTES,
    })
  : null;

// -------- Portfolio-based sizing helpers --------
const USDC_DECIMALS = 6;
const WSOL_DECIMALS = 9;
const FEE_RESERVE_LAMPORTS = 2_000_000; // keep ~0.002 SOL for fees

async function getSolBalanceLamports(pubkey) {
  try {
    return await connection.getBalance(pubkey, "confirmed");
  } catch (_) {
    return 0;
  }
}

async function getUsdcBalanceAtomic(pubkey) {
  try {
    const resp = await connection.getParsedTokenAccountsByOwner(
      pubkey,
      { mint: new PublicKey(MINTS.USDC) },
      "confirmed"
    );
    let total = 0n;
    for (const acc of resp.value) {
      const amountStr = acc.account.data.parsed.info.tokenAmount.amount;
      total += BigInt(amountStr);
    }
    return Number(total);
  } catch (_) {
    return 0;
  }
}

async function getBalances(pubkey) {
  const [lamports, usdcAtomic] = await Promise.all([
    getSolBalanceLamports(pubkey),
    getUsdcBalanceAtomic(pubkey),
  ]);
  return { lamports, usdcAtomic };
}

function computeAmountAtomic({ isBuy, balances, solUsd, tradePct }) {
  const solAvail =
    Math.max(0, balances.lamports - FEE_RESERVE_LAMPORTS) / 10 ** WSOL_DECIMALS;
  const usdcAvail = balances.usdcAtomic / 10 ** USDC_DECIMALS;
  const totalUsd = usdcAvail + solAvail * solUsd;
  const tradeUsd = totalUsd * Number(tradePct);
  if (tradeUsd <= 0) return 0;
  if (isBuy)
    return Math.floor(Math.min(tradeUsd, usdcAvail) * 10 ** USDC_DECIMALS);
  const wantSol = tradeUsd / solUsd;
  return Math.floor(
    Math.max(0, Math.min(wantSol, solAvail)) * 10 ** WSOL_DECIMALS
  );
}

class Candle {
  constructor(timestamp, open, high, low, close) {
    this.timestamp = timestamp; //note timestamp is the open time of the candle
    this.open = open;
    this.high = high;
    this.low = low;
    this.close = close;
  }
  //for easier printing
  toString() {
    return `${this.timestamp} - ${this.open.toFixed(4)} - ${this.high.toFixed(
      4
    )} - ${this.low.toFixed(4)} - ${this.close.toFixed(4)}`;
  }
}
//array of historical candles
const candles = [];

const indicators = {
  sma20: null,
  rsi14: null,
  bollingerBands: null,
};

// No executor object; we call executeSwap directly

//async to wait for historical candles
ws.onopen = async () => {
  log("Connected to Pyth Websocket");
  //wait to fetch historical candles before continuing
  const startTime = Date.now() - CANDLESTICK_DURATION * CANDLESTICK_WINDOW_SIZE;
  const endTime = Date.now();
  log(
    `Fetching historical candles for ${SYMBOL} at ${CANDLESTICK_INTERVAL} interval from ${startTime} to ${endTime}`
  );
  await fetchHistoricalCandles(
    startTime,
    endTime,
    SYMBOL,
    CANDLESTICK_INTERVAL
  );
  log(`Fetched ${candles.length} candles`);
  //update indicators initially with historical candles so they are ready instantly
  updateIndicators();
  //when historical candles are fetched, subscribe to price updates for the asset
  log(`Subscribing to ${ASSET} price updates...`);
  ws.send(
    JSON.stringify({
      type: "subscribe",
      ids: [PYTH_ID],
    })
  );
  log(`Subscribed to ${ASSET} price updates`);
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type !== "price_update") return;

  const { price, confidence, timestamp } = parsePrice(data.price_feed);
  //   log(
  //     `${ASSET} price: ${price} confidence: ${confidence} timestamp: ${timestamp}`
  //   );
  onTick(price, timestamp);
};

async function onTick(price, timestamp) {
  const candleClosed = updateCandles(price, timestamp);
  //can choose when to update indicators, every tick or every candle close
  let signal = null;
  if (candleClosed) {
    //update indicators only when candle is closed for more stable signals
    updateIndicators();
    signal = generateSignal(price);
  } else {
    // signal = generateSignal(price);
  }
  //logic to handle signals here
  if (signal) {
    log(`Signal ${signal.signal} @ $${price}`);
    // Execute swap if configured with an explicit amount
    if (wallet) {
      const isBuy = signal.signal === "BUY";
      log(`Sizing: pct=${TRADE_PCT}`);
      const balances = await getBalances(wallet.publicKey);
      const amountAtomic = computeAmountAtomic({
        isBuy,
        balances,
        solUsd: price.toNumber(),
        tradePct: TRADE_PCT,
      });
      if (!amountAtomic || amountAtomic <= 0) {
        log("Trade skipped: computed size is 0 atoms");
        appendTradeLog({
          side: isBuy ? "BUY" : "SELL",
          priceUsd: price.toNumber(),
          inputMint: isBuy ? MINTS.USDC : MINTS.WSOL,
          outputMint: isBuy ? MINTS.WSOL : MINTS.USDC,
          amountAtomic: 0,
          slippageBps: SLIPPAGE_BPS,
          tradePct: TRADE_PCT,
          signature: "",
          status: "skipped",
          error: "size=0",
        });
        return;
      }
      executor
        ?.executeSwap({
          inputMint: isBuy ? MINTS.USDC : MINTS.WSOL,
          outputMint: isBuy ? MINTS.WSOL : MINTS.USDC,
          amountAtomic,
          slippageBps: SLIPPAGE_BPS,
        })
        .then((res) => {
          log(
            `Swap submitted: ${
              isBuy ? "USDC→WSOL" : "WSOL→USDC"
            } amt=${amountAtomic} atoms slippage=${SLIPPAGE_BPS}bps sig=${
              res.signature
            }`
          );
          appendTradeLog({
            side: isBuy ? "BUY" : "SELL",
            priceUsd: price.toNumber(),
            inputMint: isBuy ? MINTS.USDC : MINTS.WSOL,
            outputMint: isBuy ? MINTS.WSOL : MINTS.USDC,
            amountAtomic,
            slippageBps: SLIPPAGE_BPS,
            tradePct: TRADE_PCT,
            signature: res.signature,
            status: "submitted",
            error: "",
          });
        })
        .catch((err) => {
          const msg = shortErrMessage(err);
          log(`Swap failed: ${msg}`);
          if (LOG_LEVEL === "debug") {
            debug(String(err?.stack || err?.message || err));
          }
          appendTradeLog({
            side: isBuy ? "BUY" : "SELL",
            priceUsd: price.toNumber(),
            inputMint: isBuy ? MINTS.USDC : MINTS.WSOL,
            outputMint: isBuy ? MINTS.WSOL : MINTS.USDC,
            amountAtomic,
            slippageBps: SLIPPAGE_BPS,
            tradePct: TRADE_PCT,
            signature: "",
            status: "failed",
            error: msg,
          });
        });
    } else {
      // Either execution disabled or amount not configured; skip on-chain action
    }
  } else {
    // log("NO SIGNAL");
  }
}

function shortErrMessage(err) {
  const raw = err && err.message ? err.message : String(err);
  const idx = raw.indexOf("Logs:");
  if (idx > 0) return raw.slice(0, idx).trim();
  const firstLine = raw.split("\n")[0];
  return firstLine.trim();
}

// -------- CSV trade logging --------
const TRADE_LOG_PATH = path.resolve(process.cwd(), "trades.csv");
function ensureTradeLogHeader() {
  if (!fs.existsSync(TRADE_LOG_PATH)) {
    const header =
      [
        "timestamp",
        "side",
        "priceUsd",
        "inputMint",
        "outputMint",
        "amountAtomic",
        "amountInput",
        "amountUsd",
        "slippageBps",
        "tradePct",
        "signature",
        "status",
        "error",
      ].join(",") + "\n";
    fs.writeFileSync(TRADE_LOG_PATH, header, { encoding: "utf8" });
  }
}

function appendTradeLog({
  side,
  priceUsd,
  inputMint,
  outputMint,
  amountAtomic,
  slippageBps,
  tradePct,
  signature,
  status,
  error,
}) {
  ensureTradeLogHeader();
  const ts = new Date().toISOString();
  // derive human amounts and usd
  let amountInput = 0;
  if (inputMint === MINTS.USDC) {
    amountInput = amountAtomic / 10 ** 6;
  } else if (inputMint === MINTS.WSOL) {
    amountInput = amountAtomic / 10 ** 9;
  }
  const amountUsd =
    inputMint === MINTS.USDC ? amountInput : amountInput * Number(priceUsd);
  const row =
    [
      ts,
      side,
      Number(priceUsd).toFixed(6),
      inputMint,
      outputMint,
      amountAtomic,
      amountInput.toFixed(9),
      amountUsd.toFixed(6),
      slippageBps,
      tradePct,
      signature || "",
      status,
      (error || "").replace(/\s+/g, " "),
    ].join(",") + "\n";
  fs.appendFileSync(TRADE_LOG_PATH, row, { encoding: "utf8" });
}

function updateIndicators() {
  indicators.sma20 = calculateSMA(candles, 20);
  indicators.rsi14 = calculateRSI(candles, 14);
  indicators.bollingerBands = calculateBollingerBands(candles, 20, 2);
  //   log(
  //     `SMA20: ${indicators.sma20} RSI14: ${indicators.rsi14} Bollinger Bands: ${indicators.bollingerBands.lower} - ${indicators.bollingerBands.middle} - ${indicators.bollingerBands.upper}`
  //   );
}

function generateSignal(price) {
  if (indicators.rsi14 === null || indicators.bollingerBands === null) {
    return null;
  }

  if (indicators.rsi14 < 30 && price < indicators.bollingerBands.lower) {
    return { signal: "BUY", price };
  } else if (indicators.rsi14 > 70 && price > indicators.bollingerBands.upper) {
    return { signal: "SELL", price };
  } else {
    return null;
  }
}

function parsePrice(price_feed) {
  const price = new Decimal(price_feed.price.price);
  const confidence = new Decimal(price_feed.price.conf);
  const exponent = new Decimal(price_feed.price.expo);
  const timestamp = new Date(price_feed.price.publish_time * 1000);
  const actual_price = price.times(Math.pow(10, exponent.toNumber()));
  const actual_confidence = confidence.times(Math.pow(10, exponent.toNumber()));
  return { price: actual_price, confidence: actual_confidence, timestamp };
}

function updateCandles(price, timestamp) {
  if (candles.length === 0) return;
  const numericPrice = price.toNumber(); //change decimal to number
  //fetch the current candle, the last one in the list
  const currentCandle = candles[candles.length - 1];
  //calculate the time at which the current candle should close
  const currentCandleEndTimestamp =
    currentCandle.timestamp + CANDLESTICK_DURATION;
  if (timestamp >= currentCandleEndTimestamp) {
    //if the current time is outside the current candle, then close the current candle
    const newTimestamp = currentCandleEndTimestamp; //start the new candle at the end of the current candle
    //create a new candle with this timestamp and all OHLC set to the current price initially
    const newCandle = new Candle(
      newTimestamp,
      numericPrice,
      numericPrice,
      numericPrice,
      numericPrice
    );

    //add the new candle to the list
    candles.push(newCandle);
    // log(`Added new candle: ${newCandle.toString()}`);

    //need to check if adding the new candle has made the list too long
    if (candles.length > CANDLESTICK_WINDOW_SIZE) {
      //if the list is too long, remove the oldest candle
      candles.shift();
    }
    //return true because the candle is closed, will trigger events for onCandleClose
    return true;
  } else {
    //if the current price is within the current candles time, then update current candle
    //if current price is a new high/low, update high/low
    currentCandle.high = Math.max(currentCandle.high, numericPrice);
    currentCandle.low = Math.min(currentCandle.low, numericPrice);
    //overright the close price of the current candle
    currentCandle.close = numericPrice;
    //return false because the candle is not closed
    return false;
  }
}

//gets historical candles from binance
async function fetchHistoricalCandles(
  startTime,
  endTime,
  symbol,
  candleStickInterval
) {
  const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${candleStickInterval}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  const response = await fetch(binanceUrl);
  const klines = await response.json();
  for (const kline of klines) {
    const timestamp = parseInt(kline[0], 10); // openTime
    const open = parseFloat(kline[1]);
    const high = parseFloat(kline[2]);
    const low = parseFloat(kline[3]);
    const close = parseFloat(kline[4]);
    const candle = new Candle(timestamp, open, high, low, close);
    //can change logic here to do whatever we want with the candle data
    candles.push(candle);
  }
  debug("Timestamp - Open - High - Low - Close");
  if (LOG_LEVEL === "debug") {
    for (const candle of candles) {
      log(candle.toString());
    }
  } else if (candles.length > 0) {
    const first = candles[0];
    const last = candles[candles.length - 1];
    log(
      `Seeded ${candles.length} candles | first ${
        first.timestamp
      } o:${first.open.toFixed(4)} c:${first.close.toFixed(4)} | last ${
        last.timestamp
      } o:${last.open.toFixed(4)} c:${last.close.toFixed(4)}`
    );
  }
}

function calculateSMA(candles, period) {
  if (candles.length < period) return null;
  const relevantCandles = candles.slice(-period);
  const sum = relevantCandles.reduce((acc, candle) => acc + candle.close, 0);
  return sum / period;
}

function calculateRSI(candles, period) {
  //need at least period + 1 candles to calculate RSI
  if (candles.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100; //avoid division by zero

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateBollingerBands(candles, period = 20, multiplier = 2) {
  if (candles.length < period) return null;

  const relevant = candles.slice(-period);
  const closes = relevant.map((c) => c.close);
  const sma = closes.reduce((acc, val) => acc + val, 0) / closes.length;

  const variance =
    closes.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) /
    closes.length;
  const stdDev = Math.sqrt(variance);

  return {
    middle: sma,
    upper: sma + stdDev * multiplier,
    lower: sma - stdDev * multiplier,
  };
}

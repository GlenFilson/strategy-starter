import WebSocket from "ws";
import Decimal from "decimal.js";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const ASSET = "SOL";
const PYTH_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const WS_URL = "wss://hermes.pyth.network/ws";
const DEBUG = false; // Set to true for verbose logging

// Candlestick settings
const CANDLESTICK_DURATION = 1000 * 1; // 1 second
const CANDLESTICK_INTERVAL = "1s";
const SYMBOL = "SOLUSDT";
const CANDLESTICK_WINDOW_SIZE = 30;

// Indicator periods
const SMA_SHORT_PERIOD = 10;
const SMA_LONG_PERIOD = 30;

// Trade settings
const TRADE_PERCENTAGE = 0.1; // 10% of portfolio per trade
const RESERVE_SOL_FOR_FEES = 0.02; // SOL reserved for transaction fees
const SLIPPAGE_BPS = 50; // 0.5% slippage tolerance
const JITO_TIP_LAMPORTS = 1000;

// ============================================================================
// INITIALIZATION
// ============================================================================

const ws = new WebSocket(WS_URL);

// Solana setup
const connection = new Connection(
  process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com"
);
const secret = JSON.parse(process.env.PRIVATE_KEY);
const keypair = Keypair.fromSecretKey(new Uint8Array(secret));

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ============================================================================
// LOGGING UTILITY
// ============================================================================

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function debugLog(message) {
  if (DEBUG) {
    console.log(`[${new Date().toISOString()}] [DEBUG] ${message}`);
  }
}

// ============================================================================
// CANDLE DATA STRUCTURE
// ============================================================================

class Candle {
  constructor(timestamp, open, high, low, close) {
    this.timestamp = timestamp;
    this.open = open;
    this.high = high;
    this.low = low;
    this.close = close;
  }

  toString() {
    return `${this.timestamp} - O: ${this.open.toFixed(
      4
    )} H: ${this.high.toFixed(4)} L: ${this.low.toFixed(
      4
    )} C: ${this.close.toFixed(4)}`;
  }
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const candles = [];

const indicators = {
  smaShort: [],
  smaLong: [],
};

// Trade execution lock to prevent multiple simultaneous trades
let isExecutingTrade = false;

// ============================================================================
// WEBSOCKET LIFECYCLE
// ============================================================================

ws.onopen = async () => {
  log("Connected to Pyth WebSocket");
  logStartupConfiguration();

  const startTime = Date.now() - CANDLESTICK_DURATION * CANDLESTICK_WINDOW_SIZE;
  const endTime = Date.now();

  log(
    `Fetching historical candles for ${SYMBOL} at ${CANDLESTICK_INTERVAL} interval`
  );

  await fetchHistoricalCandles(
    startTime,
    endTime,
    SYMBOL,
    CANDLESTICK_INTERVAL
  );
  log(`Fetched ${candles.length} candles`);

  updateIndicators();

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
  onTick(price, timestamp);
};

ws.onerror = (error) => {
  log(`WebSocket error: ${error.message}`);
};

ws.onclose = () => {
  log("WebSocket disconnected");
};

// ============================================================================
// PRICE TICK HANDLER
// ============================================================================

async function onTick(price, timestamp) {
  // Update candlestick with new price
  const candleClosed = updateCandles(price, timestamp);
  let signal = null;
  // Recalculate indicators
  if (candleClosed) {
    updateIndicators(true);
    debugLog("Candle closed, SMA values updated");
    signal = generateSignal(price);
  } else {
    updateIndicators(false);
  }

  // Execute trade if signal exists and not already trading
  if (signal && !isExecutingTrade) {
    executeTrade(signal, price.toNumber());
  }
}

// ============================================================================
// INDICATOR CALCULATION
// ============================================================================

function updateIndicators(appendSMA = false) {
  const smaShortVal = calculateSMA(candles, SMA_SHORT_PERIOD);
  const smaLongVal = calculateSMA(candles, SMA_LONG_PERIOD);

  if (appendSMA) {
    pushAndTrim(indicators.smaShort, smaShortVal);
    pushAndTrim(indicators.smaLong, smaLongVal);
  }

  debugLog(
    `SMA Short: ${smaShortVal?.toFixed(2) || "N/A"} | SMA Long: ${
      smaLongVal?.toFixed(2) || "N/A"
    }`
  );
}

function calculateSMA(candles, period) {
  // Simple Moving Average: average of last N closing prices
  if (candles.length < period) return null;
  const relevantCandles = candles.slice(-period);
  const sum = relevantCandles.reduce((acc, candle) => acc + candle.close, 0);
  return sum / period;
}

function pushAndTrim(array, value) {
  // Keep array size bounded
  array.push(value);
  if (array.length > CANDLESTICK_WINDOW_SIZE) array.shift();
}

// ============================================================================
// SIGNAL GENERATION
// ============================================================================

function generateSignal(price) {
  const lastShort = indicators.smaShort[indicators.smaShort.length - 1];
  const lastLong = indicators.smaLong[indicators.smaLong.length - 1];

  if (lastShort == null || lastLong == null) {
    return null;
  }

  // BUY signal: Short SMA crosses above Long SMA (bullish crossover)
  if (lastShort > lastLong) {
    // Check previous values to confirm crossover
    const prevShort = indicators.smaShort[indicators.smaShort.length - 2];
    const prevLong = indicators.smaLong[indicators.smaLong.length - 2];

    if (prevShort != null && prevLong != null && prevShort <= prevLong) {
      debugLog(`BUY signal generated at $${price.toNumber().toFixed(2)}`);
      return { signal: "BUY", price };
    }
  }
  // SELL signal: Short SMA crosses below Long SMA (bearish crossover)
  else if (lastShort < lastLong) {
    // Check previous values to confirm crossover
    const prevShort = indicators.smaShort[indicators.smaShort.length - 2];
    const prevLong = indicators.smaLong[indicators.smaLong.length - 2];

    if (prevShort != null && prevLong != null && prevShort >= prevLong) {
      debugLog(`SELL signal generated at $${price.toNumber().toFixed(2)}`);
      return { signal: "SELL", price };
    }
  }

  return null;
}

// ============================================================================
// PRICE PARSING
// ============================================================================

function parsePrice(price_feed) {
  // Pyth returns price with exponent; multiply to get actual price
  const price = new Decimal(price_feed.price.price);
  const confidence = new Decimal(price_feed.price.conf);
  const exponent = new Decimal(price_feed.price.expo);
  const timestamp = new Date(price_feed.price.publish_time * 1000);
  const actual_price = price.times(Math.pow(10, exponent.toNumber()));
  const actual_confidence = confidence.times(Math.pow(10, exponent.toNumber()));
  return { price: actual_price, confidence: actual_confidence, timestamp };
}

// ============================================================================
// CANDLESTICK MANAGEMENT
// ============================================================================

function updateCandles(price, timestamp) {
  if (candles.length === 0) return false;

  const numericPrice = price.toNumber();
  const currentCandle = candles[candles.length - 1];
  const currentCandleEndTimestamp =
    currentCandle.timestamp + CANDLESTICK_DURATION;

  // Candle period has closed; create new candle
  if (timestamp >= currentCandleEndTimestamp) {
    const newTimestamp = currentCandleEndTimestamp;
    const newCandle = new Candle(
      newTimestamp,
      numericPrice,
      numericPrice,
      numericPrice,
      numericPrice
    );

    candles.push(newCandle);

    // Keep only recent candles in memory
    if (candles.length > CANDLESTICK_WINDOW_SIZE) {
      candles.shift();
    }
    debugLog(`New candle created at ${new Date(newTimestamp).toISOString()}`);
    return true;
  }
  // Update current candle with new price
  else {
    currentCandle.high = Math.max(currentCandle.high, numericPrice);
    currentCandle.low = Math.min(currentCandle.low, numericPrice);
    currentCandle.close = numericPrice;
    return false;
  }
}

async function fetchHistoricalCandles(
  startTime,
  endTime,
  symbol,
  candleStickInterval
) {
  // Fetch historical data from Binance to initialize candlestick buffer
  const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${candleStickInterval}&startTime=${startTime}&endTime=${endTime}&limit=1000`;

  try {
    const response = await axios.get(binanceUrl);
    const klines = response.data;

    for (const kline of klines) {
      const timestamp = parseInt(kline[0], 10);
      const open = parseFloat(kline[1]);
      const high = parseFloat(kline[2]);
      const low = parseFloat(kline[3]);
      const close = parseFloat(kline[4]);
      const candle = new Candle(timestamp, open, high, low, close);
      candles.push(candle);
      updateIndicators(true);
    }

    log("Historical candles loaded:");
    log("Timestamp - Open - High - Low - Close");
    for (const candle of candles) {
      log(candle.toString());
    }
  } catch (error) {
    log(`Failed to fetch historical candles: ${error.message}`);
  }
}

async function getJupiterQuote(inputMint, outputMint, amount) {
  const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?onlyDirectRoutes=true&inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`;
  const response = await axios.get(quoteUrl);
  return response.data;
}

async function getJupiterSwapInstructions(quote, userPublicKey) {
  const response = await axios.post(
    "https://lite-api.jup.ag/swap/v1/swap-instructions",
    {
      userPublicKey: userPublicKey.toString(),
      quoteResponse: quote,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: JITO_TIP_LAMPORTS,
      dynamicComputeUnitLimit: true,
    }
  );
  return response.data;
}

function createTransactionInstruction(instructionData) {
  return new TransactionInstruction({
    programId: new PublicKey(instructionData.programId),
    keys: instructionData.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(instructionData.data, "base64"),
  });
}

async function executeTrade(signal, price) {
  if (isExecutingTrade) return;
  isExecutingTrade = true;

  try {
    const portfolioValue = await getPortfolioValue(price);
    if (!portfolioValue) return;

    const tradeAmount = calculateTradeAmount(signal, portfolioValue, price);
    if (tradeAmount === null) return;

    const inputMint =
      signal.signal === "BUY" ? USDC_MINT.toBase58() : SOL_MINT.toBase58();
    const outputMint =
      signal.signal === "BUY" ? SOL_MINT.toBase58() : USDC_MINT.toBase58();

    const quote = await getJupiterQuote(inputMint, outputMint, tradeAmount);
    if (!quote) throw new Error("No quote available");

    const swapData = await getJupiterSwapInstructions(quote, keypair.publicKey);

    const instructions = [];
    if (swapData.computeBudgetInstructions) {
      swapData.computeBudgetInstructions.forEach((ix) =>
        instructions.push(createTransactionInstruction(ix))
      );
    }
    if (swapData.setupInstructions) {
      swapData.setupInstructions.forEach((ix) =>
        instructions.push(createTransactionInstruction(ix))
      );
    }
    if (swapData.swapInstruction) {
      instructions.push(createTransactionInstruction(swapData.swapInstruction));
    }
    if (swapData.cleanupInstruction) {
      instructions.push(
        createTransactionInstruction(swapData.cleanupInstruction)
      );
    }

    if (instructions.length === 0) throw new Error("No valid instructions");

    const { blockhash } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([keypair]);

    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });

    const confirmation = await connection.confirmTransaction(txid, "confirmed");
    if (confirmation.value.err) throw new Error("Transaction failed");

    log(`${signal.signal} @ $${price.toFixed(2)}: ${txid}`);
  } catch (error) {
    log(`Trade failed: ${error}`);
  } finally {
    isExecutingTrade = false;
  }
}

async function getPortfolioValue(price) {
  try {
    const usdcAccount = getAssociatedTokenAddressSync(
      USDC_MINT,
      keypair.publicKey
    );
    const solBalance = await connection.getBalance(keypair.publicKey);
    const usdcBalance = await connection.getTokenAccountBalance(usdcAccount);

    const reserveLamports = RESERVE_SOL_FOR_FEES * 1e9;
    const availableSolBalance = Math.max(0, solBalance - reserveLamports);
    const totalSolBalance = availableSolBalance / 1e9;
    const solInUSDC = totalSolBalance * price;
    const totalPortfolioUSDC = solInUSDC + (usdcBalance.value.uiAmount || 0);

    return {
      solBalance: totalSolBalance,
      usdcBalance: usdcBalance.value.uiAmount || 0,
      totalPortfolioUSDC,
      availableSolLamports: availableSolBalance,
    };
  } catch (error) {
    log(`Failed to fetch portfolio value: ${error.message}`);
    return null;
  }
}

function calculateTradeAmount(signal, portfolio, price) {
  const tradeAmountUSDC = Math.floor(
    portfolio.totalPortfolioUSDC * TRADE_PERCENTAGE * 1e6
  );

  if (signal.signal === "BUY") {
    const availableUSDC = portfolio.usdcBalance * 1e6;
    if (tradeAmountUSDC > availableUSDC) {
      log(
        `Skipped: Insufficient USDC (have ${(availableUSDC / 1e6).toFixed(
          2
        )} USDC, need ${(tradeAmountUSDC / 1e6).toFixed(2)} USDC)`
      );
      return null;
    }
    return tradeAmountUSDC;
  } else {
    const solToSell = (portfolio.totalPortfolioUSDC * TRADE_PERCENTAGE) / price;
    const solToSellLamports = Math.floor(solToSell * 1e9);
    const maxSellableLamports = portfolio.availableSolLamports;

    if (solToSellLamports > maxSellableLamports || solToSellLamports <= 0) {
      log(
        `Skipped: Insufficient SOL (have ${(maxSellableLamports / 1e9).toFixed(
          4
        )} SOL, need ${(solToSellLamports / 1e9).toFixed(4)} SOL)`
      );
      return null;
    }

    return solToSellLamports;
  }
}

// ============================================================================
// STARTUP LOGGING
// ============================================================================

function logStartupConfiguration() {
  log(
    `Bot started - SMA: ${SMA_SHORT_PERIOD}/${SMA_LONG_PERIOD} | Trade: ${
      TRADE_PERCENTAGE * 100
    }% | Reserve: ${RESERVE_SOL_FOR_FEES} SOL`
  );
}

## Trading Bot Competition Starter

Welcome to the official starter kit for the cryptocurrency trading bot competition. Use this project to build and showcase your own automated strategy for a chance to win a Nintendo Switch + Mario Kart bundle.

- **Competition window:** live trading over the 2025 Christmas holidays
- **Submission deadline:** December 31, 2025
- **Prize:** Nintendo Switch + Mario Kart
- **Judging:** quality of strategy concept + realized PnL
- **How to submit:** share your GitHub repository through the Google Form linked in the announcement bio or email either society’s inbox
- **Questions:** reach out via the societies’ email or social media channels

---

## Repository Overview

- `bot.js`: baseline Solana trading bot that streams real-time prices from Pyth, computes simple moving averages, and routes trades.
- `generateWallet.js`: helper script for creating a Solana wallet and exporting the secret key.
- `fetch_pyth_data.py`: utility to download historical OHLCV candles from Pyth for research.
- `backtest.ipynb`: notebook scaffold for prototyping and backtesting strategies.
- `BTC_1h_data.csv`, `SOL_1h_data.csv`: sample hourly datasets.
- `requirements.txt`, `package.json`: Python and Node.js dependency manifests.

Feel free to replace or extend anything. The judging panel cares most about your strategy design and live performance.

---

## Prerequisites

- Node.js 18+ and npm
- Python 3.10+ (for data collection and backtesting utilities)
- A Solana wallet (the competition team will fund approved submissions for live trading; self-fund only if you want to test independently)
- A Pyth WebSocket-compatible RPC endpoint (default uses `https://api.mainnet-beta.solana.com`)

---

## Quick Start

1. **Install Node dependencies**

   ```bash
   cd /Users/glen/Desktop/strategy-starter
   npm install
   ```

2. **Create a Solana keypair (optional)**

   ```bash
   node generateWallet.js
   ```

   The script writes `new-wallet.json` containing your secret key. Keep this safe—once you submit, the organizers will fund the wallet before the live run. You may self-fund with small amounts only if you want to test on your own beforehand.

3. **Create an environment file**
   Create `.env` in the project root with:

   ```
   PRIVATE_KEY=[JSON array of 64 secret key bytes]
   SOLANA_RPC=https://api.mainnet-beta.solana.com
   ```

   - Use `new-wallet.json` as a starting point for `PRIVATE_KEY` (ensure it remains a valid JSON array such as `[1,2,...]`).
   - You can point `SOLANA_RPC` at any RPC provider that supports your throughput needs.

4. **Run the reference bot**
   ```bash
   node bot.js
   ```
   The baseline bot listens to Pyth price updates, maintains rolling candles, and executes trades on SMA crossovers. Use it as a scaffold—replace the signal logic, portfolio management, and execution routing with your own ideas.

---

## Strategy Development Workflow

- **Design your edge:** Decide on indicators, statistical signals, or machine learning models. Document your rationale in the repository; clarity matters during judging.
- **Offline research:** Work inside `backtest.ipynb` or your own framework. The included CSVs and the Python fetcher help you assemble datasets.
- **Fetch more data:**
  ```bash
  python -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
  python fetch_pyth_data.py --help  # add your own CLI wrapper if desired
  ```
  Modify `fetch_pyth_data.py` parameters to align with your symbol, interval, and lookback horizon. Save outputs to CSV for backtesting.
- **Live trading checklist:**
  - Confirm environment variables are set and private keys are secure.
  - Dry-run your strategy on devnet or a paper-trading harness before mainnet.
  - Implement logging and fail-safes (rate limits, error handling, stop-loss rules).
  - Monitor runtime during the competition window; you are responsible for uptime.

---

## Submission Requirements

- Host your strategy in a public or private GitHub repository (give the judging team access if private).
- Include:
  - Clear README describing your concept, risk controls, and deployment steps.
  - Source code for the trading bot and any supporting research scripts.
  - Optional documentation (architecture diagrams, notebooks, research notes).
- Submit the repository link via:
  - **Google Form** linked in the announcement bio **or**
  - **Email** to either society’s official inbox.
- Deadline: **23:59 UTC, December 31, 2025**.

---

## Evaluation Criteria

- **Strategy strength:** originality, soundness, and alignment with live market behavior.
- **Risk management:** drawdown controls, sizing discipline, robust error handling.
- **PnL performance:** realized results during the live trading window.
- **Code quality:** readability, modularity, deployability.
- **Documentation:** ability for judges to understand and reproduce your setup.

---

## Safety, Compliance, and Ethics

- You must operate within local regulations and the competition rules.
- Manage API keys and private keys securely; never hard-code secrets.
- Ensure you have rights to any third-party data or libraries you include.
- Trade responsibly: mainnet transactions carry real financial risk.

---

## Support

Questions? Contact either society via the emails or social channels shared in the competition announcement. The quickest responses come through the Building Division WhatsApp channel—mention “Trading Bot Competition” so we can route your request fast.

Good luck, and happy building!

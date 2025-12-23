# Polymarket Momentum Lag Trading Bot

A production-ready Node.js trading bot that exploits 30-90 second momentum lags in Polymarket's 15-minute crypto prediction markets.

## Strategy Overview

This bot targets 15-minute "up or down" prediction markets on Polymarket for Bitcoin (BTC), Ethereum (ETH), Solana (SOL), and XRP. It exploits a documented lag in Polymarket's order books during hard directional moves in the underlying crypto prices, caused by volatility compression and thin liquidity.

### Key Signals

1. **Scan for opportunities**: Continuously monitor active 15-minute markets for supported assets
2. **Detect hard moves**: Identify directional breaks where the crypto price moves >2% in <1 minute with low volatility leading in (Bollinger Bands squeeze)
3. **Lag detection**: Compare real-time crypto spot price to Polymarket's implied probability prices. Look for a 3-5% gap:
   - If crypto drops hard but "Up" shares are still priced >55%, buy "Down" shares
   - If crypto rises hard but "Down" shares are still priced >55%, buy "Up" shares
4. **Entry**: Place a market buy order for the lagging side if gap ≥3%, position size = 1-5% of account balance, only if liquidity >$1k
5. **Exit**: Hold until the market catches up (gap <1%, typically 8-12 minutes) or 12 minutes max, then market sell

### Risk Management

- Maximum 3 concurrent positions
- Stop if drawdown >10%
- Backtest mode for simulation
- Win rate target: 99%+ accuracy on signal detection
- Average return target: 50-150% per trade

## Installation

```bash
# Clone the repository
git clone https://github.com/fciaf420/polymarket-momentum-bot.git
cd polymarket-momentum-bot

# Install dependencies
npm install

# Install dashboard dependencies
cd dashboard && npm install && cd ..

# Copy environment configuration
cp .env.example .env

# Edit .env with your settings
nano .env

# Build everything
npm run build:all
```

## Configuration

Create a `.env` file based on `.env.example`:

```env
# ===========================================
# REQUIRED: Wallet Configuration
# ===========================================
PRIVATE_KEY=your_private_key_here    # Without 0x prefix

# ===========================================
# Polymarket API Configuration
# ===========================================
HOST=https://clob.polymarket.com
CHAIN_ID=137                         # Polygon Mainnet
WS_RTDS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
WS_USER_URL=wss://ws-subscriptions-clob.polymarket.com/ws/user

# ===========================================
# Trading Strategy Parameters
# ===========================================
POSITION_SIZE_PCT=0.02    # 2% of balance per trade
GAP_THRESHOLD=0.03        # 3% gap required to enter
MOVE_THRESHOLD=0.02       # 2% price move required
MAX_POSITIONS=3           # Max concurrent positions
MIN_LIQUIDITY=1000        # Minimum $1000 liquidity
MAX_HOLD_MINUTES=12       # Maximum hold time
EXIT_GAP_THRESHOLD=0.01   # Exit when gap < 1%

# ===========================================
# Risk Management
# ===========================================
MAX_DRAWDOWN=0.10         # 10% max drawdown
STOP_LOSS_PCT=0           # Per-trade stop loss (0 = disabled)

# ===========================================
# Volatility Detection (Bollinger Bands)
# ===========================================
BB_PERIOD=20              # Bollinger Bands period
BB_STD_DEV=2              # Standard deviation multiplier
VOLATILITY_SQUEEZE_THRESHOLD=0.005  # Low volatility threshold

# ===========================================
# Operation Mode
# ===========================================
BACKTEST=true             # Set to false for live trading
DRY_RUN=true              # Set to false to execute real trades
AUTO_APPROVE=false        # Auto-approve USDC spending

# ===========================================
# Logging
# ===========================================
LOG_LEVEL=info            # debug, info, warn, error
TRADE_HISTORY_PATH=./trades.csv

# ===========================================
# Binance Fallback
# ===========================================
BINANCE_FALLBACK_ENABLED=true
BINANCE_WS_URL=wss://stream.binance.com:9443/ws

# ===========================================
# Proxy (for geo-restricted regions)
# ===========================================
PROXY_URL=                # http://host:port or socks5://host:port

# ===========================================
# Dashboard
# ===========================================
DASHBOARD_ENABLED=true
DASHBOARD_PORT=3001

# ===========================================
# Polymarket Wallet (optional)
# ===========================================
# Use if trading via Polymarket proxy/Safe wallet
POLYMARKET_WALLET=
```

## Usage

### Backtest Mode

Run the strategy against historical data:

```bash
# Run backtest with default settings (last 7 days)
npm run backtest

# Run backtest with custom date range
npm start -- --backtest --start 2024-01-01 --end 2024-01-31
```

### Dry Run Mode

Simulate trading without executing real orders:

```bash
# Set in .env: DRY_RUN=true, BACKTEST=false
npm start
```

### Live Trading

**WARNING: Live trading uses real funds. Ensure you understand the risks.**

```bash
# Set in .env: DRY_RUN=false, BACKTEST=false
npm start
```

## Dashboard

The bot includes a real-time web dashboard for monitoring trading activity.

### Features

- **Live Status**: Running/Paused/Stopped indicator with uptime
- **Account Stats**: Balance, P&L, drawdown, win rate
- **Open Positions**: Real-time position cards with unrealized P&L
- **Signal Feed**: Recent trading signals with execution status
- **Risk Metrics**: Drawdown, Sharpe ratio, profit factor
- **Price Monitor**: Live crypto prices with real-time market odds
  - Current UP/DOWN percentages for each asset
  - Countdown timer until market expiry
  - Visual odds bar showing probability distribution
  - Active markets list with expiry times
- **Move Progress**: Visual indicator showing price move percentage toward threshold
- **Validation Chain**: Step-by-step signal validation visualization
- **Trading Config**: Live display of current strategy parameters
- **Config Banner**: Overview of active configuration (dry run, backtest mode, etc.)
- **Trade History**: Paginated trade log with filters
- **WebSocket Health**: Connection status for Dashboard, Binance, and Polymarket feeds
- **Position Sync**: Automatic sync with on-chain positions every 10 seconds

### Accessing the Dashboard

When the bot is running, open your browser to:

```
http://localhost:3001
```

### Dashboard Controls

- **Pause/Resume**: Stop scanning for new trades without closing positions
- **Connection Indicators**: Shows status of all WebSocket connections
  - `Dash` - Dashboard WebSocket
  - `BN` - Binance price feed
  - `PM` - Polymarket market data

### API Endpoints

The dashboard exposes REST API endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Bot running state |
| `GET /api/account` | Balance and P&L |
| `GET /api/positions` | Open positions |
| `GET /api/signals` | Recent signals |
| `GET /api/trades` | Trade history |
| `GET /api/risk/metrics` | Risk indicators |
| `POST /api/control/pause` | Pause trading |
| `POST /api/control/resume` | Resume trading |

## Project Structure

```
src/
├── index.ts              # Main entry point
├── config.ts             # Configuration management
├── strategy.ts           # Core trading strategy logic
├── risk-manager.ts       # Position sizing and risk controls
├── backtest.ts           # Backtesting module
├── test-trading.ts       # Trading validation test script
├── test-btc-trade.ts     # BTC-specific trade testing
├── clients/
│   ├── index.ts          # Client exports
│   ├── binance-ws.ts     # Binance WebSocket for price feeds
│   ├── polymarket-ws.ts  # Polymarket real-time data
│   ├── clob-client.ts    # Polymarket CLOB trading client
│   ├── usdc-approval.ts  # USDC & CTF contract approvals
│   └── market-discovery.ts # Active market discovery
├── dashboard/
│   ├── server.ts         # Express + WebSocket server
│   ├── state.ts          # State aggregation
│   └── index.ts          # Dashboard exports
├── types/
│   └── index.ts          # TypeScript type definitions
└── utils/
    ├── logger.ts         # Winston logging
    ├── volatility.ts     # Bollinger Bands & move progress
    ├── helpers.ts        # Utility functions
    └── csv.ts            # Trade history export

dashboard/                # React frontend (Vite + Tailwind)
├── src/
│   ├── App.tsx           # Main application component
│   ├── components/
│   │   ├── AccountStats.tsx    # Balance and P&L display
│   │   ├── ConfigBanner.tsx    # Configuration overview
│   │   ├── Header.tsx          # Navigation and controls
│   │   ├── LivePositions.tsx   # Open positions display
│   │   ├── MoveProgress.tsx    # Price move percentage
│   │   ├── PriceMonitor.tsx    # Live prices and odds
│   │   ├── RecentSignals.tsx   # Signal feed
│   │   ├── RiskMetrics.tsx     # Risk indicators
│   │   ├── TradeHistory.tsx    # Trade log
│   │   ├── TradingConfig.tsx   # Strategy parameters
│   │   └── ValidationChain.tsx # Signal validation steps
│   ├── hooks/
│   │   └── useWebSocket.ts     # WebSocket connection hook
│   ├── services/
│   │   └── api.ts              # REST API client
│   └── types/
│       └── index.ts            # TypeScript types
├── vite.config.ts
└── package.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build backend TypeScript |
| `npm run build:dashboard` | Build React dashboard |
| `npm run build:all` | Build both backend and dashboard |
| `npm start` | Run the bot (with dashboard) |
| `npm run backtest` | Run backtesting |
| `npm run test:trading` | Validate trading setup |
| `npm run lint` | Run ESLint |
| `npm run clean` | Remove dist folder |

## Architecture

### Real-Time Data

- **Primary**: Polymarket WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`)
- **Fallback**: Binance WebSocket (`wss://stream.binance.com:9443/ws`)

### Market Discovery

- REST API polling every 5 minutes to find active 15-minute markets
- Automatic subscription to new markets
- Cleanup of expired markets

### Signal Detection

1. **Volatility Squeeze**: Bollinger Bands width below threshold
2. **Hard Move Detection**: >2% move in <60 seconds
3. **Gap Calculation**: Difference between crypto price direction and market implied probability
4. **Confidence Scoring**: Based on move magnitude, speed, and pre-move squeeze

### Order Execution

- Market orders via Polymarket CLOB API
- Order book liquidity checks before entry
- Automatic position tracking and P&L calculation
- On-chain position sync every 10 seconds for reliability
- Signal cooldown (5s) to prevent duplicate executions

### Wallet Support

- **EOA Wallet**: Direct trading with your private key
- **Proxy Wallet**: Support for Polymarket Safe/proxy wallets via `POLYMARKET_WALLET` env var
- **Auto-Approval**: Automatic USDC and CTF exchange approvals when `AUTO_APPROVE=true`

## API Documentation

- [Polymarket CLOB API Docs](https://docs.polymarket.com)
- [Polymarket Real-Time Data](https://docs.polymarket.com/#real-time-data)

## Prerequisites

1. **Polygon USDC**: Fund your wallet with USDC on Polygon network
2. **USDC Approval**: Approve USDC spending on Polymarket contracts
3. **API Access**: API credentials are auto-derived from your private key

## Output

### Console Logs

```
2024-01-15 10:30:45.123 [info]: Signal detected {"asset":"BTC","direction":"DOWN","gap":"4.50%","confidence":"85.0%"}
2024-01-15 10:30:45.456 [info]: >>> ENTRY BTC DOWN {"price":"0.4500","size":"222.22"}
2024-01-15 10:38:12.789 [info]: <<< EXIT BTC DOWN {"price":"0.7200","size":"222.22","pnl":"60.00"}
```

### Trade History CSV

Trades are exported to `trades.csv` with the following columns:
- timestamp, asset, market, side, entry_price, exit_price
- size, cost_basis, proceeds, pnl, pnl_percent
- hold_time_minutes, exit_reason, signal_gap, signal_confidence

## Risk Warnings

- **This is experimental software** - Use at your own risk
- **Prediction markets are volatile** - You can lose your entire investment
- **No guarantees** - Past performance does not indicate future results
- **Test thoroughly** - Always run in backtest/dry-run mode first

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## License

MIT License - See [LICENSE](LICENSE) for details.

## Disclaimer

This software is for educational and research purposes only. Trading cryptocurrencies and prediction markets involves significant risk of loss. Never trade with money you cannot afford to lose. The authors are not responsible for any financial losses incurred through the use of this software.

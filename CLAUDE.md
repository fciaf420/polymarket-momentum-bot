# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a production-ready TypeScript trading bot that exploits 30-90 second momentum lags in Polymarket's 15-minute crypto prediction markets. The bot detects hard directional moves in crypto prices (BTC, ETH, SOL, XRP) and trades the lag between spot price movements and Polymarket's order book updates.

**Core Strategy**: When crypto price moves >2% in <1 minute, look for 3-5% gaps between spot price and Polymarket implied probability. Enter on the lagging side, exit when gap closes (typically 8-12 minutes).

## Common Commands

```bash
# Development
npm run dev              # Run in development mode with ts-node
npm run build            # Compile TypeScript to dist/
npm start                # Run compiled code from dist/

# Testing & Simulation
npm run backtest         # Run backtest mode (default: last 7 days)
npm start -- --backtest --start 2024-01-01 --end 2024-01-31  # Custom date range

# Trading Modes
npm start                # Uses .env BACKTEST setting
npm start -- --auto-approve  # Live mode with auto USDC approval
```

**Important flags**:
- `--backtest`: Force backtest mode
- `--live`: Force live trading (requires BACKTEST=false in .env)
- `--auto-approve`: Auto-approve USDC spending on Polymarket contracts
- `--start YYYY-MM-DD`: Backtest start date
- `--end YYYY-MM-DD`: Backtest end date

## Architecture

### High-Level Data Flow

```
Market Discovery → WebSocket Feeds → Strategy → Risk Manager → CLOB Client
     (REST)         (Real-time)       (Core)    (Validation)    (Orders)
```

### Core Components

**Entry Point** (`src/index.ts`)
- Handles startup sequence: config → balance check → USDC approvals → market discovery → WebSocket connections
- Manages graceful shutdown and error handling
- Orchestrates the main application lifecycle

**Strategy Engine** (`src/strategy.ts` - `MomentumLagStrategy`)
- Central orchestrator that extends EventEmitter
- Maintains two critical data structures:
  - `cryptoPrices: Map<CryptoAsset, CryptoPriceData>` - Rolling 10-minute window of spot prices
  - `marketPrices: Map<conditionId, MarketPriceData>` - Real-time Polymarket order book state
- **Scan loop** (500ms): Calls `detectHardMove()` on price history, calculates gaps, generates signals
- **Position monitor** (1s): Checks exit conditions (gap closed, max hold time, stop loss, market expiry)
- Key methods:
  - `scanForOpportunities()`: Main signal detection loop
  - `executeSignal()`: Places market buy orders via CLOB client
  - `monitorPositions()`: Checks exit conditions and closes positions
  - `handleCryptoPriceUpdate()`: Updates rolling price history for volatility analysis

**Risk Management** (`src/risk-manager.ts`)
- Position sizing with Kelly criterion-inspired confidence adjustment
- Circuit breakers: Max drawdown, daily loss limits, concentration limits
- Adjusts position size based on:
  - Signal confidence (0.5x - 1.5x multiplier)
  - Liquidity (max 10% of available liquidity)
  - Volatility (reduce 20% in high vol)
  - Recent losses (reduce 30% after 2+ losses in last 3 trades)
- Tracks drawdown from high water mark, not initial balance

**Configuration** (`src/config.ts`)
- All settings loaded from `.env` with validation
- Critical validations: private key format (64 hex chars), percentage bounds (0-1), chain ID (137 or 80002)
- Supports both Polygon Mainnet (137) and Amoy Testnet (80002)

### Client Architecture

**WebSocket Clients** (`src/clients/`)
- `BinanceWebSocketClient`: Crypto spot prices (primary source)
  - Supports SOCKS5/HTTP proxies via `proxyUrl` config for geo-restricted regions
  - Emits `price` events with asset, price, timestamp
- `PolymarketWebSocketClient`: Market data (prices, order books)
  - Subscribes to market price changes and order book updates
  - Emits `priceChange` and `orderBook` events
- Both maintain reconnection logic and error handling

**Market Discovery** (`src/clients/market-discovery.ts`)
- Polls REST API every 5 minutes for active 15-minute markets
- Filters by keywords: "15min", "up", "down", asset names (BTC/ETH/SOL/XRP)
- Returns `CryptoMarket` objects with `conditionId`, `upTokenId`, `downTokenId`, `expiryTime`

**CLOB Client** (`src/clients/clob-client.ts`)
- Wraps Polymarket's CLOB API for order execution
- Handles API credential derivation from private key
- Key methods:
  - `marketBuy(tokenId, size, market)`: Places market buy order
  - `marketSell(tokenId, size, market)`: Places market sell order
  - `getBalance()`: Returns USDC balance on Polygon
- Supports dry run mode (simulates orders without execution)

**USDC Approval** (`src/clients/usdc-approval.ts`)
- Checks and approves USDC spending on three Polymarket contracts:
  - CTF_EXCHANGE (main trading)
  - NEG_RISK_CTF_EXCHANGE (conditional tokens)
  - NEG_RISK_ADAPTER (market adapter)
- Only required for live trading, skipped in backtest/dry-run modes

### Signal Detection Pipeline

1. **Hard Move Detection** (`src/utils/volatility.ts` - `detectHardMove()`)
   - Analyzes price history for >2% moves in <60 seconds
   - Uses Bollinger Bands to detect pre-move volatility squeeze
   - Returns `PriceMove` with direction, magnitude, duration, volatility metrics

2. **Gap Calculation** (`src/utils/helpers.ts` - `calculatePriceGap()`)
   - Compares crypto move direction vs Polymarket implied probability
   - Example: BTC drops 3% but "Up" shares still at 60% = 10% gap
   - Returns which token to buy (up/down) and gap magnitude

3. **Confidence Scoring** (`strategy.ts` - `calculateSignalConfidence()`)
   - Base 50% + adjustments:
     - Gap size: +20% for 10%+ gaps
     - Move strength: +15% for 5%+ moves
     - Speed: +10% if <30 seconds
     - Post-squeeze: +10%
     - High liquidity: +5% if >$5k
   - Capped at 99%

### State Management

**Strategy State** (`MomentumLagStrategy.state`)
- `positions: Map<conditionId, Position>` - Active positions keyed by market
- `accountBalance` - Updated on each trade close
- `paused` - Circuit breaker flag
- `currentDrawdown` - Calculated from high water mark

**Position Lifecycle**
1. Signal generated → `executeSignal()` → Market buy order
2. Position created with `status: 'open'`
3. Monitor loop checks exit conditions every 1 second
4. Exit triggered → `closePosition()` → Market sell order
5. Position updated with `status: 'closed'`, removed from active map
6. Trade recorded to CSV via `TradeHistoryWriter`

### Type Definitions (`src/types/index.ts`)

Key interfaces to understand:
- `CryptoMarket`: Polymarket market metadata (conditionId, tokens, expiry)
- `Signal`: Detected trading opportunity with confidence score
- `Position`: Active trade with entry/exit prices, PnL tracking
- `PriceMove`: Hard move detection result with volatility context
- `TradeRecord`: Historical trade for CSV export

## Configuration Notes

**Required Environment Variables**:
- `PRIVATE_KEY`: Ethereum private key (64 hex chars, no 0x prefix)

**Operation Modes**:
- `BACKTEST=true`: Simulation with historical data
- `DRY_RUN=true`: Real-time but simulated orders
- Both false: Live trading with real funds

**Critical Thresholds**:
- `GAP_THRESHOLD=0.03`: Minimum 3% gap to enter (higher = fewer, higher quality signals)
- `MOVE_THRESHOLD=0.02`: Minimum 2% price move (higher = stronger signals only)
- `EXIT_GAP_THRESHOLD=0.01`: Exit when gap closes to 1%
- `MAX_HOLD_MINUTES=12`: Force exit after 12 minutes

**Risk Controls**:
- `MAX_POSITIONS=3`: Maximum concurrent positions
- `MAX_DRAWDOWN=0.10`: Stop trading at 10% drawdown
- `POSITION_SIZE_PCT=0.02`: 2% of balance per trade (adjusted by confidence)

## Development Workflow

1. **Testing Strategy Changes**:
   - Set `BACKTEST=true` and `DRY_RUN=true` in `.env`
   - Run `npm run backtest` to test against historical data
   - Review `trades_backtest.csv` for performance metrics

2. **Live Simulation**:
   - Set `BACKTEST=false`, `DRY_RUN=true`
   - Run `npm start` to test with live data but no real orders
   - Monitor console logs for signal detection

3. **Going Live**:
   - Ensure USDC balance on Polygon (check with block explorer)
   - Set `BACKTEST=false`, `DRY_RUN=false`
   - Run `npm start -- --auto-approve` (first time only)
   - Monitor `trades.csv` for executed trades

## Important Implementation Details

**WebSocket Reconnection**: Both Binance and Polymarket clients have built-in reconnection logic. Don't add manual reconnection in strategy code.

**Price Data Window**: `cryptoPrices` maintains 10 minutes of history. Older data is automatically pruned. Don't manually clear this unless resetting state.

**Order Execution**: `ClobClient` returns `{ status, avgFillPrice, filledSize }`. Always check `status === 'failed'` before creating positions.

**Exit Conditions Priority**:
1. Market expiry (1 min buffer)
2. Stop loss (if enabled)
3. Gap closed (<1%)
4. Max hold time (12 min)

**Event Emitters**: Strategy emits `positionOpened` and `positionClosed` events. Use these for monitoring/logging, not for core logic.

**Proxy Configuration**: If Binance is geo-blocked, set `PROXY_URL` in `.env`. Supports HTTP, HTTPS, SOCKS4, SOCKS5. Format: `socks5://user:pass@host:port`

## Common Debugging Patterns

**No signals detected**:
- Check `LOG_LEVEL=debug` to see price updates
- Verify crypto prices are updating (Binance connection)
- Lower `GAP_THRESHOLD` or `MOVE_THRESHOLD` temporarily
- Check if markets are active (discovery client logs)

**Orders failing**:
- Verify USDC approvals: `npm start -- --auto-approve`
- Check USDC balance is sufficient
- Ensure market hasn't expired (`expiryTime`)
- Review liquidity in order book

**Drawdown issues**:
- Risk manager pauses at `MAX_DRAWDOWN`
- Check `state.paused` and `pauseReason`
- Drawdown calculated from high water mark, not initial balance
- To resume: fix losses or increase `MAX_DRAWDOWN`

## API Documentation References

- [Polymarket CLOB API](https://docs.polymarket.com)
- [Polymarket WebSocket Real-Time Data](https://docs.polymarket.com/#real-time-data)
- [Binance WebSocket Streams](https://binance-docs.github.io/apidocs/spot/en/#websocket-market-streams)

/**
 * Type definitions for Polymarket Momentum Trading Bot
 */

// ===========================================
// Market Types
// ===========================================

export interface Market {
  conditionId: string;
  questionId: string;
  tokens: Token[];
  minIncentiveSize: string;
  maxIncentiveSize: string;
  active: boolean;
  closed: boolean;
  makerBase: number;
  takerBase: number;
  description: string;
  endDate: string;
  question: string;
  marketSlug: string;
  fpmm: string;
  category: string;
  enableOrderBook: boolean;
}

export interface Token {
  tokenId: string;
  outcome: string; // "Yes" or "No"
  winner: boolean;
  price: number;
}

export interface CryptoMarket extends Market {
  asset: CryptoAsset;
  direction: MarketDirection;
  expiryTime: Date;
  upTokenId: string;
  downTokenId: string;
}

export type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP';
export type MarketDirection = 'UP' | 'DOWN';
export type OrderSide = 'BUY' | 'SELL';

// ===========================================
// Price Types
// ===========================================

export interface PricePoint {
  timestamp: number;
  price: number;
}

export interface CryptoPriceData {
  asset: CryptoAsset;
  price: number;
  timestamp: number;
  source: 'polymarket' | 'binance';
  priceHistory: PricePoint[]; // Last 60 seconds of prices
}

export interface MarketPriceData {
  conditionId: string;
  upPrice: number;      // Price of "Up" shares (0-1)
  downPrice: number;    // Price of "Down" shares (0-1)
  upImpliedProb: number;  // Implied probability (0-100)
  downImpliedProb: number;
  timestamp: number;
  bestBidUp: number;
  bestAskUp: number;
  bestBidDown: number;
  bestAskDown: number;
  liquidityUp: number;  // Available liquidity in USD
  liquidityDown: number;
}

export interface OrderBookEntry {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  timestamp: number;
  totalLiquidity: number;
}

// ===========================================
// Signal Types
// ===========================================

export interface VolatilityMetrics {
  standardDeviation: number;
  bollingerBandWidth: number;
  upperBand: number;
  lowerBand: number;
  middleBand: number;
  isSqueezing: boolean;  // Low volatility condition
}

export interface PriceMove {
  asset: CryptoAsset;
  movePercent: number;      // Percentage change
  direction: 'up' | 'down';
  durationSeconds: number;
  startPrice: number;
  endPrice: number;
  timestamp: number;
  volatilityBefore: VolatilityMetrics;
}

export interface Signal {
  id: string;
  timestamp: number;
  asset: CryptoAsset;
  market: CryptoMarket;
  priceMove: PriceMove;
  gapPercent: number;       // Gap between crypto price and implied probability
  suggestedSide: MarketDirection;  // Which side to buy
  tokenId: string;          // Token to buy
  entryPrice: number;       // Current price of the token
  liquidity: number;        // Available liquidity
  confidence: number;       // Signal confidence 0-1
  reason: string;
}

// ===========================================
// Validation Chain Types
// ===========================================

export type ValidationCheckStatus = 'passed' | 'failed' | 'skipped';

export interface ValidationCheck {
  name: string;
  status: ValidationCheckStatus;
  value?: string;
  threshold?: string;
  reason?: string;
}

export interface AssetValidation {
  asset: CryptoAsset;
  timestamp: number;
  checks: ValidationCheck[];
  finalResult: 'signal_triggered' | 'blocked' | 'no_opportunity';
  blockReason?: string;
}

// ===========================================
// Position Types
// ===========================================

export interface Position {
  id: string;
  market: CryptoMarket;
  tokenId: string;
  side: MarketDirection;
  entryPrice: number;
  entryTimestamp: number;
  size: number;           // Number of shares
  costBasis: number;      // Total cost in USDC
  currentPrice: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  signal: Signal;
  status: PositionStatus;
  exitPrice?: number;
  exitTimestamp?: number;
  realizedPnl?: number;
  exitReason?: ExitReason;
}

export type PositionStatus = 'open' | 'closing' | 'closed';
export type ExitReason = 'gap_closed' | 'max_hold_time' | 'market_resolved' | 'stop_loss' | 'manual';

// ===========================================
// Order Types
// ===========================================

export interface Order {
  id: string;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  type: 'market' | 'limit';
  price?: number;
  size: number;
  status: OrderStatus;
  filledSize: number;
  avgFillPrice: number;
  timestamp: number;
}

export type OrderStatus = 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'failed';

// ===========================================
// Trade History Types
// ===========================================

export interface TradeRecord {
  timestamp: string;
  asset: CryptoAsset;
  market: string;
  side: MarketDirection;
  entryPrice: number;
  exitPrice: number;
  size: number;
  costBasis: number;
  proceeds: number;
  pnl: number;
  pnlPercent: number;
  holdTimeMinutes: number;
  exitReason: ExitReason;
  signalGap: number;
  signalConfidence: number;
}

// ===========================================
// Account Types
// ===========================================

export interface AccountBalance {
  usdc: number;
  positions: Position[];
  totalValue: number;
  availableBalance: number;
  initialBalance: number;
  currentDrawdown: number;
  maxDrawdownHit: boolean;
}

// ===========================================
// WebSocket Message Types
// ===========================================

export interface WSMessage {
  type: string;
  data: unknown;
  timestamp?: number;
}

export interface PriceUpdateMessage {
  asset_id: string;
  price: string;
  timestamp: number;
}

export interface OrderBookMessage {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
  hash: string;
}

export interface TradeMessage {
  asset_id: string;
  price: string;
  size: string;
  side: string;
  timestamp: number;
}

// ===========================================
// Configuration Types
// ===========================================

export interface Config {
  // Wallet
  privateKey: string;
  polymarketWallet?: string;  // Polymarket Safe/proxy wallet address (if different from EOA)

  // Polymarket
  host: string;
  chainId: number;
  wsRtdsUrl: string;
  wsUserUrl: string;

  // Strategy
  positionSizePct: number;
  gapThreshold: number;
  moveThreshold: number;
  maxPositions: number;
  minLiquidity: number;
  maxHoldMinutes: number;
  exitGapThreshold: number;

  // Risk
  maxDrawdown: number;
  stopLossPct: number;

  // Volatility
  bbPeriod: number;
  bbStdDev: number;
  volatilitySqueezeThreshold: number;

  // Mode
  backtest: boolean;
  dryRun: boolean;

  // Logging
  logLevel: string;
  tradeHistoryPath: string;

  // Binance
  binanceFallbackEnabled: boolean;
  binanceWsUrl: string;

  // Proxy (for geo-restricted APIs like Binance)
  proxyUrl?: string;

  // API (derived)
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;

  // Dashboard
  dashboardEnabled: boolean;
  dashboardPort: number;
}

// ===========================================
// Backtest Types
// ===========================================

export interface BacktestResult {
  startDate: Date;
  endDate: Date;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  averagePnl: number;
  maxDrawdown: number;
  sharpeRatio: number;
  averageHoldTime: number;
  signalAccuracy: number;
  trades: TradeRecord[];
}

export interface HistoricalPrice {
  timestamp: number;
  price: number;
}

export interface HistoricalMarketData {
  conditionId: string;
  prices: HistoricalPrice[];
}

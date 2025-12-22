// Dashboard types matching backend DashboardState

export type CryptoAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface Position {
  id: string;
  signal: {
    asset: CryptoAsset;
    direction: 'up' | 'down';
    gap: number;
    confidence: number;
  };
  side: 'YES' | 'NO';
  entryPrice: number;
  currentPrice: number;
  size: number;
  costBasis: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  entryTime: number;
  exitPrice?: number;
  realizedPnl?: number;
  exitReason?: string;
}

export interface Signal {
  id: string;
  asset: CryptoAsset;
  direction: 'up' | 'down';
  gap: number;
  cryptoPrice: number;
  impliedPrice: number;
  confidence: number;
  timestamp: number;
  executed: boolean;
  executionReason?: string;
}

export interface CryptoPrice {
  price: number;
  timestamp: number;
}

export interface MarketPriceData {
  upPrice: number;           // 0-1 scale
  downPrice: number;         // 0-1 scale
  upImpliedProb: number;     // Percentage (0-100)
  downImpliedProb: number;   // Percentage (0-100)
  liquidityUp: number;
  liquidityDown: number;
  bestBidUp: number;
  bestAskUp: number;
  bestBidDown: number;
  bestAskDown: number;
  timestamp: number;
}

export interface CryptoMarket {
  conditionId: string;
  asset: CryptoAsset;
  direction: 'UP' | 'DOWN';
  expiryTime: string;        // ISO date string or Date
  upTokenId: string;
  downTokenId: string;
  question: string;
  endDate: string;
}

export interface TradeRecord {
  id: string;
  asset: CryptoAsset;
  side: 'YES' | 'NO';
  direction: 'up' | 'down';
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  entryTime: string;
  exitTime: string;
  holdDuration: number;
  exitReason: string;
}

export interface TradeSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  averagePnl: number;
  averageHoldTime: number;
  bestTrade: number;
  worstTrade: number;
}

export interface RiskMetrics {
  currentDrawdown: number;
  maxDrawdown: number;
  positionConcentration: number;
  totalExposure: number;
  dailyPnl: number;
  totalPnl: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
}

export interface RiskLimits {
  maxDrawdown: number;
  maxPositions: number;
  maxPositionSize: number;
  minLiquidity: number;
}

export interface DashboardState {
  status: {
    isRunning: boolean;
    paused: boolean;
    pauseReason?: string;
    uptime: number;
  };
  connections: {
    binance: boolean;
    polymarket: boolean;
  };
  account: {
    balance: number;
    initialBalance: number;
    totalValue: number;
    availableBalance: number;
    currentDrawdown: number;
    totalPnl: number;
  };
  positions: Position[];
  signals: Signal[];
  prices: {
    crypto: Record<CryptoAsset, CryptoPrice>;
    markets: Record<string, MarketPriceData>;
  };
  markets: CryptoMarket[];
  risk: {
    metrics: RiskMetrics;
    limits: RiskLimits;
  };
  trades: {
    summary: TradeSummary;
  };
}

export interface WSMessage {
  type: string;
  data?: unknown;
  timestamp: number;
}

export interface PriceUpdate {
  status: {
    isRunning: boolean;
    paused: boolean;
    pauseReason?: string;
    uptime: number;
  };
  connections: {
    binance: boolean;
    polymarket: boolean;
  };
  crypto: Record<CryptoAsset, CryptoPrice>;
  markets: Record<string, MarketPriceData>;
  activeMarkets: CryptoMarket[]; // Active markets list for UI updates
  positions: Array<{
    id: string;
    currentPrice: number;
    currentValue: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
  }>;
  account: {
    balance: number;
    totalPnl: number;
    drawdown: number;
  };
}

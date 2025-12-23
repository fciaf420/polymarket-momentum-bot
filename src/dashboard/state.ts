/**
 * Dashboard State Aggregator
 * Collects state from strategy and risk manager for dashboard display
 */

import type { MomentumLagStrategy } from '../strategy.js';
import type { RiskManager } from '../risk-manager.js';
import type {
  Config,
  Position,
  Signal,
  CryptoAsset,
  MarketPriceData,
  TradeRecord,
  AssetValidation,
} from '../types/index.js';

// Frontend-compatible market type (simplified from backend CryptoMarket)
export interface FrontendMarket {
  conditionId: string;
  asset: CryptoAsset;
  direction: 'UP' | 'DOWN';
  expiryTime: string;
  upTokenId: string;
  downTokenId: string;
  question: string;
  endDate: string;
}

// Frontend-compatible position type
export interface FrontendPosition {
  id: string;
  signal: {
    asset: CryptoAsset;
    direction: string;
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

// Frontend-compatible signal type
export interface FrontendSignal {
  id: string;
  asset: CryptoAsset;
  direction: string;
  gap: number;
  cryptoPrice: number;
  impliedPrice: number;
  confidence: number;
  timestamp: number;
  executed: boolean;
  executionReason?: string;
}

// Move progress for dashboard progress bars
export interface MoveProgress {
  asset: CryptoAsset;
  currentMovePercent: number;
  direction: 'up' | 'down' | 'flat';
  progress: number; // 0-1, where 1 = threshold hit
  durationSeconds: number;
  startPrice: number;
  currentPrice: number;
  threshold: number;
}

// Order book level for dashboard display
export interface OrderBookLevel {
  price: number;
  size: number;
  total: number; // Cumulative size
}

// Order book for a single market side (UP or DOWN token)
export interface MarketOrderBook {
  tokenId: string;
  asset: CryptoAsset;
  side: 'UP' | 'DOWN';
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
  spreadPercent: number;
  midPrice: number;
  bidLiquidity: number; // Total $ available on bids
  askLiquidity: number; // Total $ available on asks
  lastUpdate: number;
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
  positions: FrontendPosition[];
  signals: FrontendSignal[];
  prices: {
    crypto: Record<CryptoAsset, { price: number; timestamp: number }>;
    markets: Record<string, MarketPriceData>;
  };
  markets: FrontendMarket[];
  risk: {
    metrics: {
      currentDrawdown: number;
      maxDrawdown: number;
      positionConcentration: number;
      totalExposure: number;
      dailyPnl: number;
      totalPnl: number;
      winRate: number;
      profitFactor: number;
      sharpeRatio: number;
      averageWin: number;
      averageLoss: number;
    };
    limits: {
      maxDrawdown: number;
      maxPositions: number;
      maxPositionSize: number;
      minLiquidity: number;
      maxDailyLoss: number;
      maxConcentration: number;
    };
  };
  trades: {
    summary: {
      totalTrades: number;
      winningTrades: number;
      losingTrades: number;
      winRate: number;
      totalPnl: number;
      averagePnl: number;
      averageHoldTime: number;
      bestTrade: number;
      worstTrade: number;
    };
  };
  config: {
    positionSizePct: number;
    gapThreshold: number;
    moveThreshold: number;
    maxPositions: number;
    minLiquidity: number;
    maxHoldMinutes: number;
    exitGapThreshold: number;
    maxDrawdown: number;
    maxEntrySlippage: number;
    backtest: boolean;
    dryRun: boolean;
  };
  validation: AssetValidation[];
  moveProgress: MoveProgress[];
  orderbooks: MarketOrderBook[];
}

export class DashboardStateAggregator {
  private strategy: MomentumLagStrategy;
  private riskManager: RiskManager;
  private config: Config;
  private startTime: number;

  constructor(
    strategy: MomentumLagStrategy,
    riskManager: RiskManager,
    config: Config
  ) {
    this.strategy = strategy;
    this.riskManager = riskManager;
    this.config = config;
    this.startTime = Date.now();
  }

  /**
   * Transform backend Signal to frontend format
   */
  private transformSignal(signal: Signal): any {
    return {
      id: signal.id,
      asset: signal.asset,
      direction: signal.suggestedSide?.toLowerCase() || signal.priceMove?.direction || 'up',
      gap: signal.gapPercent || 0,
      cryptoPrice: signal.priceMove?.endPrice || 0,
      impliedPrice: signal.entryPrice || 0,
      confidence: signal.confidence || 0,
      timestamp: signal.timestamp || Date.now(),
      executed: true,
      executionReason: signal.reason,
    };
  }

  /**
   * Transform backend Position to frontend format
   */
  private transformPosition(position: Position): any {
    return {
      id: position.id,
      signal: {
        asset: position.signal?.asset || position.market?.asset || 'BTC',
        direction: position.signal?.suggestedSide?.toLowerCase() || position.signal?.priceMove?.direction || 'up',
        gap: position.signal?.gapPercent || 0,
        confidence: position.signal?.confidence || 0,
      },
      side: position.side === 'UP' ? 'YES' : position.side === 'DOWN' ? 'NO' : position.side,
      entryPrice: position.entryPrice || 0,
      currentPrice: position.currentPrice || position.entryPrice || 0,
      size: position.size || 0,
      costBasis: position.costBasis || 0,
      currentValue: position.currentValue || position.costBasis || 0,
      unrealizedPnl: position.unrealizedPnl || 0,
      unrealizedPnlPercent: position.unrealizedPnlPercent || 0,
      entryTime: position.entryTimestamp || Date.now(),
      exitPrice: position.exitPrice,
      realizedPnl: position.realizedPnl,
      exitReason: position.exitReason,
    };
  }

  /**
   * Get full dashboard state
   */
  public getState(): DashboardState {
    const strategyState = this.strategy.getState();
    const rawPositions = this.strategy.getPositions();
    const rawSignals = this.strategy.getSignals(50);
    const cryptoPrices = this.strategy.getCryptoPrices();
    const marketPrices = this.strategy.getMarketPrices();
    const markets = this.strategy.getActiveMarkets();
    const riskMetrics = this.riskManager.getMetrics();
    const riskLimits = this.riskManager.getLimits();
    const tradeSummary = this.strategy.getTradeHistoryWriter().getSummary();
    const wsHealth = this.strategy.getWebSocketHealth();

    // Transform positions and signals to frontend format
    const positions = rawPositions.map(p => this.transformPosition(p));
    const signals = rawSignals.map(s => this.transformSignal(s));

    // Calculate total position value
    const totalPositionValue = rawPositions.reduce((sum, p) => sum + p.currentValue, 0);

    // Convert crypto prices to simple format
    const cryptoPricesSimple: Record<CryptoAsset, { price: number; timestamp: number }> = {} as Record<CryptoAsset, { price: number; timestamp: number }>;
    cryptoPrices.forEach((data, asset) => {
      cryptoPricesSimple[asset] = {
        price: data.price,
        timestamp: data.timestamp,
      };
    });

    // Convert market prices to object
    const marketPricesObj: Record<string, MarketPriceData> = {};
    marketPrices.forEach((data, conditionId) => {
      marketPricesObj[conditionId] = data;
    });

    return {
      status: {
        isRunning: strategyState.isRunning,
        paused: strategyState.paused,
        pauseReason: strategyState.pauseReason,
        uptime: Date.now() - this.startTime,
      },
      connections: wsHealth,
      account: {
        balance: strategyState.accountBalance,
        initialBalance: strategyState.initialBalance,
        totalValue: strategyState.accountBalance + totalPositionValue,
        availableBalance: strategyState.accountBalance,
        currentDrawdown: strategyState.currentDrawdown,
        totalPnl: strategyState.accountBalance - strategyState.initialBalance,
      },
      positions,
      signals,
      prices: {
        crypto: cryptoPricesSimple,
        markets: marketPricesObj,
      },
      // Transform markets to ensure Date objects are serialized as strings
      markets: markets.map(m => ({
        conditionId: m.conditionId,
        asset: m.asset,
        direction: 'UP' as const,
        expiryTime: m.expiryTime instanceof Date ? m.expiryTime.toISOString() : String(m.expiryTime),
        upTokenId: m.upTokenId,
        downTokenId: m.downTokenId,
        question: m.question || `${m.asset} Up or Down`,
        endDate: m.expiryTime instanceof Date ? m.expiryTime.toISOString() : String(m.expiryTime),
      })),
      risk: {
        metrics: {
          currentDrawdown: riskMetrics.currentDrawdown,
          maxDrawdown: riskMetrics.maxDrawdown,
          positionConcentration: riskMetrics.positionConcentration,
          totalExposure: riskMetrics.totalExposure,
          dailyPnl: riskMetrics.dailyPnl,
          totalPnl: riskMetrics.totalPnl,
          winRate: riskMetrics.winRate,
          profitFactor: riskMetrics.profitFactor,
          sharpeRatio: riskMetrics.sharpeRatio,
          averageWin: riskMetrics.averageWin,
          averageLoss: riskMetrics.averageLoss,
        },
        limits: {
          maxDrawdown: riskLimits.maxDrawdown,
          maxPositions: riskLimits.maxPositions,
          maxPositionSize: riskLimits.maxPositionSize,
          minLiquidity: riskLimits.minLiquidity,
          maxDailyLoss: riskLimits.maxDailyLoss,
          maxConcentration: riskLimits.maxConcentration,
        },
      },
      trades: {
        summary: tradeSummary,
      },
      config: {
        positionSizePct: this.config.positionSizePct,
        gapThreshold: this.config.gapThreshold,
        moveThreshold: this.config.moveThreshold,
        maxPositions: this.config.maxPositions,
        minLiquidity: this.config.minLiquidity,
        maxHoldMinutes: this.config.maxHoldMinutes,
        exitGapThreshold: this.config.exitGapThreshold,
        maxDrawdown: this.config.maxDrawdown,
        maxEntrySlippage: this.config.maxEntrySlippage,
        backtest: this.config.backtest,
        dryRun: this.config.dryRun,
      },
      validation: this.strategy.getValidationState(),
      moveProgress: this.strategy.getMoveProgressAll(),
      orderbooks: [], // Orderbooks are fetched separately via WebSocket
    };
  }

  /**
   * Get positions only
   */
  public getPositions(): Position[] {
    return this.strategy.getPositions();
  }

  /**
   * Get recent signals
   */
  public getSignals(limit: number = 50): Signal[] {
    return this.strategy.getSignals(limit);
  }

  /**
   * Get trade history
   */
  public getTradeHistory(limit: number = 100): TradeRecord[] {
    const trades = this.strategy.getTradeHistoryWriter().readAll();
    return trades.slice(-limit).reverse();
  }

  /**
   * Get sanitized config (no secrets)
   */
  public getSanitizedConfig(): Partial<Config> {
    return {
      host: this.config.host,
      chainId: this.config.chainId,
      positionSizePct: this.config.positionSizePct,
      gapThreshold: this.config.gapThreshold,
      moveThreshold: this.config.moveThreshold,
      maxPositions: this.config.maxPositions,
      minLiquidity: this.config.minLiquidity,
      maxHoldMinutes: this.config.maxHoldMinutes,
      exitGapThreshold: this.config.exitGapThreshold,
      maxDrawdown: this.config.maxDrawdown,
      maxEntrySlippage: this.config.maxEntrySlippage,
      backtest: this.config.backtest,
      dryRun: this.config.dryRun,
    };
  }

  /**
   * Pause strategy
   */
  public pause(reason?: string): void {
    this.strategy.pause(reason);
  }

  /**
   * Resume strategy
   */
  public resume(): void {
    this.strategy.resume();
  }
}

export default DashboardStateAggregator;

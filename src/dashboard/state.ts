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
  CryptoMarket,
  TradeRecord,
  AssetValidation,
} from '../types/index.js';

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
    crypto: Record<CryptoAsset, { price: number; timestamp: number }>;
    markets: Record<string, MarketPriceData>;
  };
  markets: CryptoMarket[];
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
    };
    limits: {
      maxDrawdown: number;
      maxPositions: number;
      maxPositionSize: number;
      minLiquidity: number;
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
    backtest: boolean;
    dryRun: boolean;
  };
  validation: AssetValidation[];
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
   * Get full dashboard state
   */
  public getState(): DashboardState {
    const strategyState = this.strategy.getState();
    const positions = this.strategy.getPositions();
    const signals = this.strategy.getSignals(50);
    const cryptoPrices = this.strategy.getCryptoPrices();
    const marketPrices = this.strategy.getMarketPrices();
    const markets = this.strategy.getActiveMarkets();
    const riskMetrics = this.riskManager.getMetrics();
    const riskLimits = this.riskManager.getLimits();
    const tradeSummary = this.strategy.getTradeHistoryWriter().getSummary();
    const wsHealth = this.strategy.getWebSocketHealth();

    // Calculate total position value
    const totalPositionValue = positions.reduce((sum, p) => sum + p.currentValue, 0);

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
      markets,
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
        },
        limits: {
          maxDrawdown: riskLimits.maxDrawdown,
          maxPositions: riskLimits.maxPositions,
          maxPositionSize: riskLimits.maxPositionSize,
          minLiquidity: riskLimits.minLiquidity,
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
        backtest: this.config.backtest,
        dryRun: this.config.dryRun,
      },
      validation: this.strategy.getValidationState(),
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

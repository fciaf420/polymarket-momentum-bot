/**
 * Risk Management Module
 * Handles position sizing, drawdown monitoring, and risk controls
 */

import { EventEmitter } from 'events';
import type { Config, Position, CryptoMarket } from './types/index.js';
import logger, { logRisk } from './utils/logger.js';
import { formatPercent, formatCurrency } from './utils/helpers.js';

interface RiskMetrics {
  currentDrawdown: number;
  maxDrawdown: number;
  positionConcentration: number;
  totalExposure: number;
  dailyPnl: number;
  totalPnl: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  sharpeRatio: number;
}

interface RiskLimits {
  maxDrawdown: number;
  maxPositions: number;
  maxPositionSize: number;
  maxDailyLoss: number;
  maxConcentration: number;
  minLiquidity: number;
}

interface RiskEvent {
  type: 'warning' | 'breach' | 'limit_hit';
  metric: string;
  current: number;
  limit: number;
  message: string;
  timestamp: number;
}

export class RiskManager extends EventEmitter {
  private limits: RiskLimits;
  private metrics: RiskMetrics;
  private events: RiskEvent[] = [];
  private positions: Map<string, Position> = new Map();
  private closedTrades: Array<{ pnl: number; timestamp: number }> = [];

  // Session tracking
  private sessionStartBalance: number = 0;
  private currentBalance: number = 0;
  private highWaterMark: number = 0;

  // Circuit breakers
  private isPaused: boolean = false;
  private pauseReason?: string;

  constructor(config: Config) {
    super();

    // Initialize limits from config
    this.limits = {
      maxDrawdown: config.maxDrawdown,
      maxPositions: config.maxPositions,
      maxPositionSize: config.positionSizePct,
      maxDailyLoss: config.maxDrawdown / 2, // Half of max drawdown
      maxConcentration: 0.5, // Max 50% in single asset
      minLiquidity: config.minLiquidity,
    };

    // Initialize metrics
    this.metrics = {
      currentDrawdown: 0,
      maxDrawdown: 0,
      positionConcentration: 0,
      totalExposure: 0,
      dailyPnl: 0,
      totalPnl: 0,
      winRate: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      sharpeRatio: 0,
    };
  }

  /**
   * Initialize risk manager with starting balance
   */
  public initialize(startingBalance: number): void {
    this.sessionStartBalance = startingBalance;
    this.currentBalance = startingBalance;
    this.highWaterMark = startingBalance;

    logger.info('Risk manager initialized', {
      startingBalance: formatCurrency(startingBalance),
      maxDrawdown: formatPercent(this.limits.maxDrawdown),
      maxPositions: this.limits.maxPositions,
    });
  }

  /**
   * Check if a new position can be opened
   */
  public canOpenPosition(market: CryptoMarket, size: number): { allowed: boolean; reason?: string } {
    // Check if paused
    if (this.isPaused) {
      return { allowed: false, reason: this.pauseReason || 'Trading paused' };
    }

    // Check max positions
    if (this.positions.size >= this.limits.maxPositions) {
      return { allowed: false, reason: `Max positions (${this.limits.maxPositions}) reached` };
    }

    // Check position size
    const positionPct = size / this.currentBalance;
    if (positionPct > this.limits.maxPositionSize) {
      return {
        allowed: false,
        reason: `Position size ${formatPercent(positionPct)} exceeds max ${formatPercent(this.limits.maxPositionSize)}`,
      };
    }

    // Check drawdown
    if (this.metrics.currentDrawdown >= this.limits.maxDrawdown) {
      return {
        allowed: false,
        reason: `Max drawdown ${formatPercent(this.limits.maxDrawdown)} reached`,
      };
    }

    // Check daily loss
    if (this.metrics.dailyPnl < 0 && Math.abs(this.metrics.dailyPnl) / this.sessionStartBalance >= this.limits.maxDailyLoss) {
      return {
        allowed: false,
        reason: `Max daily loss ${formatPercent(this.limits.maxDailyLoss)} reached`,
      };
    }

    // Check concentration (don't have too many positions in same asset)
    const assetPositions = Array.from(this.positions.values()).filter(p => p.signal.asset === market.asset);
    const assetExposure = assetPositions.reduce((sum, p) => sum + p.costBasis, 0) + size;
    const concentration = assetExposure / this.currentBalance;

    if (concentration > this.limits.maxConcentration) {
      return {
        allowed: false,
        reason: `${market.asset} concentration ${formatPercent(concentration)} exceeds max ${formatPercent(this.limits.maxConcentration)}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Calculate optimal position size
   */
  public calculatePositionSize(
    signalConfidence: number,
    liquidity: number,
    volatility: number
  ): number {
    // Base position size from config
    let size = this.currentBalance * this.limits.maxPositionSize;

    // Adjust for confidence (Kelly criterion inspired)
    const confidenceMultiplier = Math.max(0.5, Math.min(1.5, signalConfidence * 1.5));
    size *= confidenceMultiplier;

    // Adjust for liquidity (don't be too large relative to available liquidity)
    const liquidityPct = size / liquidity;
    if (liquidityPct > 0.1) {
      // Don't take more than 10% of available liquidity
      size = liquidity * 0.1;
    }

    // Adjust for volatility (reduce size in high volatility)
    if (volatility > 0.02) {
      size *= 0.8;
    }

    // Adjust based on recent performance (reduce after losses)
    if (this.closedTrades.length >= 3) {
      const recentTrades = this.closedTrades.slice(-3);
      const recentLosses = recentTrades.filter(t => t.pnl < 0).length;
      if (recentLosses >= 2) {
        size *= 0.7;
        logger.debug('Position size reduced due to recent losses');
      }
    }

    // Ensure minimum size (to avoid dust trades)
    const minSize = 10; // $10 minimum
    if (size < minSize) {
      return 0; // Skip trade if too small
    }

    return size;
  }

  /**
   * Update position tracking
   */
  public updatePosition(position: Position): void {
    this.positions.set(position.market.conditionId, position);
    this.updateMetrics();
  }

  /**
   * Remove a closed position
   */
  public removePosition(conditionId: string, realizedPnl: number): void {
    this.positions.delete(conditionId);

    // Track closed trade
    this.closedTrades.push({
      pnl: realizedPnl,
      timestamp: Date.now(),
    });

    // Update balance
    this.currentBalance += realizedPnl;
    this.metrics.totalPnl += realizedPnl;
    this.metrics.dailyPnl += realizedPnl;

    // Update high water mark
    if (this.currentBalance > this.highWaterMark) {
      this.highWaterMark = this.currentBalance;
    }

    this.updateMetrics();
    this.checkRiskLimits();
  }

  /**
   * Update all risk metrics
   */
  private updateMetrics(): void {
    // Calculate drawdown
    this.metrics.currentDrawdown = (this.highWaterMark - this.currentBalance) / this.highWaterMark;

    // Update max drawdown
    if (this.metrics.currentDrawdown > this.metrics.maxDrawdown) {
      this.metrics.maxDrawdown = this.metrics.currentDrawdown;
    }

    // Calculate total exposure
    this.metrics.totalExposure = Array.from(this.positions.values())
      .reduce((sum, p) => sum + p.currentValue, 0);

    // Calculate concentration (max single asset exposure)
    const assetExposures = new Map<string, number>();
    for (const position of this.positions.values()) {
      const current = assetExposures.get(position.signal.asset) || 0;
      assetExposures.set(position.signal.asset, current + position.currentValue);
    }
    this.metrics.positionConcentration = Math.max(...assetExposures.values(), 0) / this.currentBalance;

    // Calculate win/loss stats from closed trades
    if (this.closedTrades.length > 0) {
      const wins = this.closedTrades.filter(t => t.pnl > 0);
      const losses = this.closedTrades.filter(t => t.pnl <= 0);

      this.metrics.winRate = wins.length / this.closedTrades.length;
      this.metrics.averageWin = wins.length > 0
        ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length
        : 0;
      this.metrics.averageLoss = losses.length > 0
        ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length
        : 0;

      // Profit factor
      const grossWins = wins.reduce((sum, t) => sum + t.pnl, 0);
      const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
      this.metrics.profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
    }

    // Calculate Sharpe ratio (simplified)
    if (this.closedTrades.length >= 10) {
      const returns = this.closedTrades.map(t => t.pnl / this.sessionStartBalance);
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      this.metrics.sharpeRatio = stdDev > 0 ? (avgReturn * Math.sqrt(252)) / stdDev : 0;
    }

    this.emit('metricsUpdated', this.metrics);
  }

  /**
   * Check risk limits and trigger circuit breakers if needed
   */
  private checkRiskLimits(): void {
    // Check max drawdown
    if (this.metrics.currentDrawdown >= this.limits.maxDrawdown) {
      this.triggerCircuitBreaker('Max drawdown limit reached', 'drawdown');
    }

    // Check daily loss limit
    if (this.metrics.dailyPnl < 0 && Math.abs(this.metrics.dailyPnl) / this.sessionStartBalance >= this.limits.maxDailyLoss) {
      this.triggerCircuitBreaker('Daily loss limit reached', 'daily_loss');
    }

    // Emit warning events
    if (this.metrics.currentDrawdown >= this.limits.maxDrawdown * 0.75 && !this.isPaused) {
      this.emitRiskEvent({
        type: 'warning',
        metric: 'drawdown',
        current: this.metrics.currentDrawdown,
        limit: this.limits.maxDrawdown,
        message: `Approaching max drawdown: ${formatPercent(this.metrics.currentDrawdown)} / ${formatPercent(this.limits.maxDrawdown)}`,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Trigger circuit breaker to halt trading
   */
  private triggerCircuitBreaker(reason: string, metric: string): void {
    if (this.isPaused) {
      return;
    }

    this.isPaused = true;
    this.pauseReason = reason;

    logRisk('Circuit breaker triggered', {
      reason,
      metric,
      currentDrawdown: formatPercent(this.metrics.currentDrawdown),
      dailyPnl: formatCurrency(this.metrics.dailyPnl),
    });

    this.emitRiskEvent({
      type: 'breach',
      metric,
      current: metric === 'drawdown' ? this.metrics.currentDrawdown : Math.abs(this.metrics.dailyPnl) / this.sessionStartBalance,
      limit: metric === 'drawdown' ? this.limits.maxDrawdown : this.limits.maxDailyLoss,
      message: reason,
      timestamp: Date.now(),
    });

    this.emit('circuitBreaker', { reason, metric });
  }

  /**
   * Emit a risk event
   */
  private emitRiskEvent(event: RiskEvent): void {
    this.events.push(event);
    this.emit('riskEvent', event);
  }

  /**
   * Reset daily metrics (call at start of new trading day)
   */
  public resetDailyMetrics(): void {
    this.metrics.dailyPnl = 0;

    // Only unpause if drawdown is acceptable
    if (this.pauseReason?.includes('Daily') && this.metrics.currentDrawdown < this.limits.maxDrawdown) {
      this.isPaused = false;
      this.pauseReason = undefined;
      logger.info('Daily metrics reset, trading resumed');
    }
  }

  /**
   * Force unpause (manual override)
   */
  public unpause(): boolean {
    if (this.metrics.currentDrawdown >= this.limits.maxDrawdown) {
      logger.warn('Cannot unpause: max drawdown still exceeded');
      return false;
    }

    this.isPaused = false;
    this.pauseReason = undefined;
    logger.info('Risk manager unpaused manually');
    return true;
  }

  /**
   * Get current risk metrics
   */
  public getMetrics(): RiskMetrics {
    return { ...this.metrics };
  }

  /**
   * Get risk limits
   */
  public getLimits(): RiskLimits {
    return { ...this.limits };
  }

  /**
   * Check if trading is paused
   */
  public isPausedState(): { paused: boolean; reason?: string } {
    return { paused: this.isPaused, reason: this.pauseReason };
  }

  /**
   * Get risk events
   */
  public getEvents(): RiskEvent[] {
    return [...this.events];
  }

  /**
   * Get risk summary
   */
  public getSummary(): {
    balance: number;
    pnl: number;
    drawdown: number;
    positions: number;
    winRate: number;
    isPaused: boolean;
  } {
    return {
      balance: this.currentBalance,
      pnl: this.metrics.totalPnl,
      drawdown: this.metrics.currentDrawdown,
      positions: this.positions.size,
      winRate: this.metrics.winRate,
      isPaused: this.isPaused,
    };
  }
}

export default RiskManager;

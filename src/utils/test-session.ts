/**
 * Test Session Recorder
 * Records detailed session data for analysis of trading execution
 */

import fs from 'fs';
import type { Signal, Position, CryptoAsset, MarketPriceData, Config } from '../types/index.js';
import logger from './logger.js';

export interface SignalEvent {
  timestamp: number;
  type: 'signal_detected';
  asset: CryptoAsset;
  side: 'UP' | 'DOWN';
  gapPercent: number;
  confidence: number;
  expectedPrice: number;
  marketPrice: number;
  liquidity: number;
  reason: string;
}

export interface OrderEvent {
  timestamp: number;
  type: 'order_submitted' | 'order_filled' | 'order_failed';
  asset: CryptoAsset;
  side: 'UP' | 'DOWN';
  orderType: 'BUY' | 'SELL';
  requestedSize: number;
  filledSize?: number;
  expectedPrice?: number;
  fillPrice?: number;
  latencyMs?: number;
  slippage?: number;
  error?: string;
}

export interface PositionEvent {
  timestamp: number;
  type: 'position_opened' | 'position_closed';
  asset: CryptoAsset;
  side: 'UP' | 'DOWN';
  size: number;
  entryPrice?: number;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  holdTimeMinutes?: number;
  exitReason?: string;
  isOrphaned?: boolean;
}

export interface MarketSnapshot {
  timestamp: number;
  conditionId: string;
  asset: CryptoAsset;
  upPrice: number;
  downPrice: number;
  upLiquidity: number;
  downLiquidity: number;
  spreadUp: number;
  spreadDown: number;
}

export interface SessionData {
  sessionId: string;
  startTime: string;
  endTime?: string;
  config: Partial<Config>;
  events: (SignalEvent | OrderEvent | PositionEvent)[];
  marketSnapshots: MarketSnapshot[];
  summary?: SessionSummary;
}

export interface SessionSummary {
  durationMinutes: number;
  signalsDetected: number;
  signalsExecuted: number;
  ordersSubmitted: number;
  ordersFilled: number;
  ordersFailed: number;
  positionsOpened: number;
  positionsClosed: number;
  orphanedPositionsHandled: number;
  totalPnl: number;
  winCount: number;
  lossCount: number;
  avgLatencyMs: number;
  avgSlippage: number;
}

export class TestSessionRecorder {
  private sessionData: SessionData;
  private filePath: string;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private marketPrices: Map<string, MarketPriceData> = new Map();

  constructor(config: Partial<Config>) {
    const now = new Date();
    const sessionId = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);

    this.filePath = `./test_session_${sessionId}.json`;

    // Only store relevant config (no private keys)
    const safeConfig: Partial<Config> = {
      positionSizePct: config.positionSizePct,
      gapThreshold: config.gapThreshold,
      moveThreshold: config.moveThreshold,
      maxPositions: config.maxPositions,
      minLiquidity: config.minLiquidity,
      maxHoldMinutes: config.maxHoldMinutes,
      exitGapThreshold: config.exitGapThreshold,
      maxTradeUsd: config.maxTradeUsd,
      maxDrawdown: config.maxDrawdown,
      stopLossPct: config.stopLossPct,
      dryRun: config.dryRun,
    };

    this.sessionData = {
      sessionId,
      startTime: now.toISOString(),
      config: safeConfig,
      events: [],
      marketSnapshots: [],
    };

    logger.info(`Test session recorder started: ${this.filePath}`);
  }

  /**
   * Record a signal detection event
   */
  recordSignal(signal: Signal): void {
    const event: SignalEvent = {
      timestamp: Date.now(),
      type: 'signal_detected',
      asset: signal.asset,
      side: signal.suggestedSide,
      gapPercent: signal.gapPercent,
      confidence: signal.confidence,
      expectedPrice: signal.entryPrice,
      marketPrice: signal.entryPrice, // Will be updated with actual market price
      liquidity: signal.liquidity,
      reason: signal.reason,
    };

    this.sessionData.events.push(event);
    this.save();
  }

  /**
   * Record an order submission
   */
  recordOrderSubmitted(
    asset: CryptoAsset,
    side: 'UP' | 'DOWN',
    orderType: 'BUY' | 'SELL',
    requestedSize: number,
    expectedPrice: number
  ): void {
    const event: OrderEvent = {
      timestamp: Date.now(),
      type: 'order_submitted',
      asset,
      side,
      orderType,
      requestedSize,
      expectedPrice,
    };

    this.sessionData.events.push(event);
    this.save();
  }

  /**
   * Record an order fill
   */
  recordOrderFilled(
    asset: CryptoAsset,
    side: 'UP' | 'DOWN',
    orderType: 'BUY' | 'SELL',
    requestedSize: number,
    filledSize: number,
    expectedPrice: number,
    fillPrice: number,
    latencyMs: number
  ): void {
    const slippage = expectedPrice > 0
      ? (fillPrice - expectedPrice) / expectedPrice
      : 0;

    const event: OrderEvent = {
      timestamp: Date.now(),
      type: 'order_filled',
      asset,
      side,
      orderType,
      requestedSize,
      filledSize,
      expectedPrice,
      fillPrice,
      latencyMs,
      slippage,
    };

    this.sessionData.events.push(event);
    this.save();
  }

  /**
   * Record an order failure
   */
  recordOrderFailed(
    asset: CryptoAsset,
    side: 'UP' | 'DOWN',
    orderType: 'BUY' | 'SELL',
    requestedSize: number,
    error: string
  ): void {
    const event: OrderEvent = {
      timestamp: Date.now(),
      type: 'order_failed',
      asset,
      side,
      orderType,
      requestedSize,
      error,
    };

    this.sessionData.events.push(event);
    this.save();
  }

  /**
   * Record a position opened event
   */
  recordPositionOpened(position: Position): void {
    const event: PositionEvent = {
      timestamp: Date.now(),
      type: 'position_opened',
      asset: position.signal.asset,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      isOrphaned: position.isOrphaned,
    };

    this.sessionData.events.push(event);
    this.save();
  }

  /**
   * Record a position closed event
   */
  recordPositionClosed(position: Position): void {
    const holdTimeMinutes = position.exitTimestamp
      ? (position.exitTimestamp - position.entryTimestamp) / (60 * 1000)
      : 0;

    const event: PositionEvent = {
      timestamp: Date.now(),
      type: 'position_closed',
      asset: position.signal.asset,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      exitPrice: position.exitPrice,
      pnl: position.realizedPnl,
      pnlPercent: position.costBasis > 0
        ? (position.realizedPnl || 0) / position.costBasis
        : 0,
      holdTimeMinutes,
      exitReason: position.exitReason,
      isOrphaned: position.isOrphaned,
    };

    this.sessionData.events.push(event);
    this.save();
  }

  /**
   * Update market prices for snapshots
   */
  updateMarketPrices(prices: Map<string, MarketPriceData>): void {
    this.marketPrices = prices;
  }

  /**
   * Take a market snapshot
   */
  takeMarketSnapshot(asset: CryptoAsset, conditionId: string): void {
    const marketData = this.marketPrices.get(conditionId);
    if (!marketData) return;

    const snapshot: MarketSnapshot = {
      timestamp: Date.now(),
      conditionId,
      asset,
      upPrice: marketData.upPrice,
      downPrice: marketData.downPrice,
      upLiquidity: marketData.liquidityUp,
      downLiquidity: marketData.liquidityDown,
      spreadUp: marketData.bestAskUp - marketData.bestBidUp,
      spreadDown: marketData.bestAskDown - marketData.bestBidDown,
    };

    this.sessionData.marketSnapshots.push(snapshot);
  }

  /**
   * Start periodic market snapshots
   */
  startSnapshots(intervalMs: number = 60000): void {
    this.snapshotInterval = setInterval(() => {
      // Snapshots are taken when updateMarketPrices is called
      this.save();
    }, intervalMs);
  }

  /**
   * Stop periodic snapshots
   */
  stopSnapshots(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
  }

  /**
   * Generate session summary
   */
  generateSummary(): SessionSummary {
    const events = this.sessionData.events;
    const startTime = new Date(this.sessionData.startTime).getTime();
    const endTime = Date.now();
    const durationMinutes = (endTime - startTime) / (60 * 1000);

    const signals = events.filter(e => e.type === 'signal_detected') as SignalEvent[];
    const ordersSubmitted = events.filter(e => e.type === 'order_submitted') as OrderEvent[];
    const ordersFilled = events.filter(e => e.type === 'order_filled') as OrderEvent[];
    const ordersFailed = events.filter(e => e.type === 'order_failed') as OrderEvent[];
    const positionsOpened = events.filter(e => e.type === 'position_opened') as PositionEvent[];
    const positionsClosed = events.filter(e => e.type === 'position_closed') as PositionEvent[];

    const orphanedClosed = positionsClosed.filter(p => p.isOrphaned);
    const realTrades = positionsClosed.filter(p => !p.isOrphaned);

    const totalPnl = realTrades.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const wins = realTrades.filter(p => (p.pnl || 0) > 0);
    const losses = realTrades.filter(p => (p.pnl || 0) <= 0);

    const latencies = ordersFilled.filter(o => o.latencyMs !== undefined).map(o => o.latencyMs!);
    const avgLatencyMs = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

    const slippages = ordersFilled.filter(o => o.slippage !== undefined).map(o => o.slippage!);
    const avgSlippage = slippages.length > 0
      ? slippages.reduce((a, b) => a + b, 0) / slippages.length
      : 0;

    return {
      durationMinutes,
      signalsDetected: signals.length,
      signalsExecuted: positionsOpened.filter(p => !p.isOrphaned).length,
      ordersSubmitted: ordersSubmitted.length,
      ordersFilled: ordersFilled.length,
      ordersFailed: ordersFailed.length,
      positionsOpened: positionsOpened.length,
      positionsClosed: positionsClosed.length,
      orphanedPositionsHandled: orphanedClosed.length,
      totalPnl,
      winCount: wins.length,
      lossCount: losses.length,
      avgLatencyMs,
      avgSlippage,
    };
  }

  /**
   * Finalize and save the session
   */
  finalize(): SessionSummary {
    this.stopSnapshots();

    this.sessionData.endTime = new Date().toISOString();
    this.sessionData.summary = this.generateSummary();

    this.save();

    logger.info(`Test session finalized: ${this.filePath}`, this.sessionData.summary);

    return this.sessionData.summary;
  }

  /**
   * Save session data to file
   */
  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.sessionData, null, 2));
    } catch (error) {
      logger.error('Failed to save test session', { error: (error as Error).message });
    }
  }

  /**
   * Get the file path
   */
  getFilePath(): string {
    return this.filePath;
  }
}

// Singleton instance for global access
let testSession: TestSessionRecorder | null = null;

export function initTestSession(config: Partial<Config>): TestSessionRecorder {
  testSession = new TestSessionRecorder(config);
  return testSession;
}

export function getTestSession(): TestSessionRecorder | null {
  return testSession;
}

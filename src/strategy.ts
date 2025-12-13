/**
 * Momentum Lag Trading Strategy
 * Core strategy logic for detecting and exploiting 30-90 second lags
 * in Polymarket's 15-minute crypto prediction markets
 */

import { EventEmitter } from 'events';
import type {
  Config,
  CryptoAsset,
  CryptoMarket,
  CryptoPriceData,
  MarketPriceData,
  Signal,
  Position,
  PriceMove,
  TradeRecord,
  ExitReason,
} from './types/index.js';
import {
  BinanceWebSocketClient,
  PolymarketWebSocketClient,
  PolymarketClobClient,
  MarketDiscoveryClient,
} from './clients/index.js';
import { detectHardMove } from './utils/volatility.js';
import {
  calculatePriceGap,
  generateId,
  normalizeSharePrice,
  formatPercent,
  formatCurrency,
} from './utils/helpers.js';
import logger, { logSignal, logTrade, logPosition, logRisk } from './utils/logger.js';
import { TradeHistoryWriter } from './utils/csv.js';

/**
 * Strategy state and configuration
 */
interface StrategyState {
  isRunning: boolean;
  positions: Map<string, Position>;
  signals: Signal[];
  accountBalance: number;
  initialBalance: number;
  maxDrawdown: number;
  currentDrawdown: number;
  paused: boolean;
  pauseReason?: string;
}

export class MomentumLagStrategy extends EventEmitter {
  private config: Config;
  private state: StrategyState;

  // Clients
  private binanceClient: BinanceWebSocketClient;
  private polymarketWs: PolymarketWebSocketClient;
  private clobClient: PolymarketClobClient;
  private marketDiscovery: MarketDiscoveryClient;

  // Market data
  private cryptoPrices: Map<CryptoAsset, CryptoPriceData> = new Map();
  private marketPrices: Map<string, MarketPriceData> = new Map();
  private activeMarkets: Map<string, CryptoMarket> = new Map();

  // Trade history
  private tradeHistory: TradeHistoryWriter;

  // Monitoring intervals
  private scanInterval: NodeJS.Timeout | null = null;
  private positionMonitorInterval: NodeJS.Timeout | null = null;

  constructor(config: Config) {
    super();
    this.config = config;

    // Initialize state
    this.state = {
      isRunning: false,
      positions: new Map(),
      signals: [],
      accountBalance: 0,
      initialBalance: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
      paused: false,
    };

    // Initialize clients (pass proxy URL for geo-restricted regions)
    this.binanceClient = new BinanceWebSocketClient(config.binanceWsUrl, config.proxyUrl);
    this.polymarketWs = new PolymarketWebSocketClient(config.wsRtdsUrl);
    this.clobClient = new PolymarketClobClient(config);
    this.marketDiscovery = new MarketDiscoveryClient(config.host);

    // Initialize trade history writer
    this.tradeHistory = new TradeHistoryWriter(config.tradeHistoryPath);

    // Bind event handlers
    this.setupEventHandlers();
  }

  /**
   * Set up event handlers for data feeds
   */
  private setupEventHandlers(): void {
    // Binance price updates
    this.binanceClient.on('price', (asset: CryptoAsset, price: number, timestamp: number) => {
      this.handleCryptoPriceUpdate(asset, price, timestamp, 'binance');
    });

    // Polymarket price changes
    this.polymarketWs.on('priceChange', (assetId: string, price: number, timestamp: number) => {
      this.handleMarketPriceUpdate(assetId, price, timestamp);
    });

    // Polymarket order book updates
    this.polymarketWs.on('orderBook', (tokenId: string, orderBook: { totalLiquidity: number }) => {
      this.handleOrderBookUpdate(tokenId, orderBook);
    });

    // Connection events
    this.binanceClient.on('error', (error: Error) => {
      logger.error('Binance connection error', { error: error.message });
    });

    this.polymarketWs.on('error', (error: Error) => {
      logger.error('Polymarket connection error', { error: error.message });
    });
  }

  /**
   * Start the strategy
   */
  public async start(): Promise<void> {
    if (this.state.isRunning) {
      logger.warn('Strategy is already running');
      return;
    }

    logger.info('Starting momentum lag strategy', {
      dryRun: this.config.dryRun,
      gapThreshold: formatPercent(this.config.gapThreshold),
      moveThreshold: formatPercent(this.config.moveThreshold),
      maxPositions: this.config.maxPositions,
      positionSize: formatPercent(this.config.positionSizePct),
    });

    try {
      // Initialize CLOB client
      await this.clobClient.initialize();

      // Get initial balance
      this.state.accountBalance = await this.clobClient.getBalance();
      this.state.initialBalance = this.state.accountBalance;

      logger.info('Account balance', {
        balance: formatCurrency(this.state.accountBalance),
        dryRun: this.config.dryRun,
      });

      // Connect to WebSockets
      const wsConnections = [this.polymarketWs.connect()];
      if (this.config.binanceFallbackEnabled) {
        wsConnections.push(this.binanceClient.connect());
      } else {
        logger.info('Binance fallback disabled, using Polymarket data only');
      }
      await Promise.all(wsConnections);

      // Start market discovery
      await this.marketDiscovery.start((markets) => {
        this.handleMarketsUpdate(markets);
      });

      // Start scanning loop
      this.startScanning();

      // Start position monitoring
      this.startPositionMonitoring();

      this.state.isRunning = true;
      logger.info('Strategy started successfully');

    } catch (error) {
      logger.error('Failed to start strategy', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Stop the strategy
   */
  public async stop(): Promise<void> {
    if (!this.state.isRunning) {
      return;
    }

    logger.info('Stopping strategy...');

    // Stop scanning
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    if (this.positionMonitorInterval) {
      clearInterval(this.positionMonitorInterval);
      this.positionMonitorInterval = null;
    }

    // Close all positions
    await this.closeAllPositions('manual');

    // Disconnect clients
    this.binanceClient.disconnect();
    this.polymarketWs.disconnect();
    this.marketDiscovery.stop();

    this.state.isRunning = false;
    logger.info('Strategy stopped');

    // Log summary
    this.logSessionSummary();
  }

  /**
   * Handle crypto price updates from Binance
   */
  private handleCryptoPriceUpdate(asset: CryptoAsset, price: number, timestamp: number, source: string): void {
    const existing = this.cryptoPrices.get(asset);

    if (!existing) {
      this.cryptoPrices.set(asset, {
        asset,
        price,
        timestamp,
        source: source as 'binance' | 'polymarket',
        priceHistory: [{ price, timestamp }],
      });
      return;
    }

    existing.price = price;
    existing.timestamp = timestamp;
    existing.priceHistory.push({ price, timestamp });

    // Keep last 10 minutes of data
    const cutoff = timestamp - 10 * 60 * 1000;
    existing.priceHistory = existing.priceHistory.filter(p => p.timestamp >= cutoff);
  }

  /**
   * Handle market price updates from Polymarket
   */
  private handleMarketPriceUpdate(assetId: string, price: number, timestamp: number): void {
    // Find the market this token belongs to
    for (const [conditionId, market] of this.activeMarkets) {
      if (market.upTokenId === assetId || market.downTokenId === assetId) {
        const existing = this.marketPrices.get(conditionId) || {
          conditionId,
          upPrice: 0,
          downPrice: 0,
          upImpliedProb: 0,
          downImpliedProb: 0,
          timestamp: 0,
          bestBidUp: 0,
          bestAskUp: 0,
          bestBidDown: 0,
          bestAskDown: 0,
          liquidityUp: 0,
          liquidityDown: 0,
        };

        if (market.upTokenId === assetId) {
          existing.upPrice = normalizeSharePrice(price);
          existing.upImpliedProb = existing.upPrice;
        } else {
          existing.downPrice = normalizeSharePrice(price);
          existing.downImpliedProb = existing.downPrice;
        }

        existing.timestamp = timestamp;
        this.marketPrices.set(conditionId, existing);

        // Log price updates at debug level
        logger.debug('Price update', {
          asset: market.asset,
          upPrice: existing.upPrice.toFixed(2),
          downPrice: existing.downPrice.toFixed(2),
        });
        break;
      }
    }
  }

  /**
   * Handle order book updates
   */
  private handleOrderBookUpdate(tokenId: string, orderBook: { totalLiquidity: number }): void {
    for (const [conditionId, market] of this.activeMarkets) {
      const existing = this.marketPrices.get(conditionId);
      if (!existing) continue;

      if (market.upTokenId === tokenId) {
        existing.liquidityUp = orderBook.totalLiquidity;
      } else if (market.downTokenId === tokenId) {
        existing.liquidityDown = orderBook.totalLiquidity;
      }
    }
  }

  /**
   * Handle markets update from discovery
   */
  private handleMarketsUpdate(markets: CryptoMarket[]): void {
    this.activeMarkets.clear();

    for (const market of markets) {
      this.activeMarkets.set(market.conditionId, market);

      // Initialize market prices from token data (from Gamma API)
      let upPrice = 0.5;
      let downPrice = 0.5;
      for (const token of market.tokens) {
        if (token.tokenId === market.upTokenId) {
          upPrice = token.price;
        } else if (token.tokenId === market.downTokenId) {
          downPrice = token.price;
        }
      }

      // Set initial market prices
      this.marketPrices.set(market.conditionId, {
        conditionId: market.conditionId,
        upPrice,
        downPrice,
        upImpliedProb: upPrice,
        downImpliedProb: downPrice,
        timestamp: Date.now(),
        bestBidUp: upPrice - 0.01,
        bestAskUp: upPrice + 0.01,
        bestBidDown: downPrice - 0.01,
        bestAskDown: downPrice + 0.01,
        liquidityUp: 1000, // Assume minimum liquidity
        liquidityDown: 1000,
      });

      logger.info('Market prices initialized', {
        asset: market.asset,
        upPrice: upPrice.toFixed(2),
        downPrice: downPrice.toFixed(2),
      });

      // Subscribe to market data for real-time updates
      this.polymarketWs.subscribeToMarket(market.conditionId, [market.upTokenId, market.downTokenId]);
      this.polymarketWs.subscribeToOrderBook(market.conditionId, market.upTokenId);
      this.polymarketWs.subscribeToOrderBook(market.conditionId, market.downTokenId);
    }

    logger.info('Active markets updated', { count: markets.length });
  }

  /**
   * Start the main scanning loop
   */
  private startScanning(): void {
    // Scan every 500ms for high-frequency detection
    this.scanInterval = setInterval(() => {
      if (!this.state.paused) {
        this.scanForOpportunities();
      }
    }, 500);
  }

  /**
   * Start position monitoring
   */
  private startPositionMonitoring(): void {
    // Monitor positions every second
    this.positionMonitorInterval = setInterval(() => {
      this.monitorPositions();
    }, 1000);
  }

  /**
   * Scan for trading opportunities
   */
  private scanForOpportunities(): void {
    // Check if we can take new positions
    if (this.state.positions.size >= this.config.maxPositions) {
      return;
    }

    // Check drawdown
    if (this.checkDrawdown()) {
      return;
    }

    // Scan each asset for hard moves
    const assets: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

    for (const asset of assets) {
      const priceData = this.cryptoPrices.get(asset);
      if (!priceData || priceData.priceHistory.length < 10) {
        continue;
      }

      // Detect hard move
      const move = detectHardMove(
        priceData.priceHistory,
        asset,
        this.config.moveThreshold,
        60, // 1 minute window
        this.config.bbPeriod
      );

      if (!move) {
        continue;
      }

      // Check for volatility squeeze before the move (better signals)
      const hadSqueeze = move.volatilityBefore.isSqueezing;

      // Find matching markets for this asset
      const markets = Array.from(this.activeMarkets.values()).filter(m => m.asset === asset);

      for (const market of markets) {
        // Skip if we already have a position in this market
        if (this.state.positions.has(market.conditionId)) {
          continue;
        }

        // Get market prices
        const marketData = this.marketPrices.get(market.conditionId);
        if (!marketData) {
          continue;
        }

        // Calculate gap
        const gapResult = calculatePriceGap(
          move.movePercent,
          marketData.upImpliedProb,
          marketData.downImpliedProb
        );

        if (gapResult.gap < this.config.gapThreshold) {
          continue;
        }

        // Check liquidity
        const liquidity = gapResult.tokenSide === 'up' ? marketData.liquidityUp : marketData.liquidityDown;
        if (liquidity < this.config.minLiquidity) {
          logger.debug('Skipping signal due to low liquidity', {
            asset,
            liquidity: formatCurrency(liquidity),
            required: formatCurrency(this.config.minLiquidity),
          });
          continue;
        }

        // Calculate confidence
        const confidence = this.calculateSignalConfidence(move, gapResult.gap, hadSqueeze, liquidity);

        // Create signal
        const signal: Signal = {
          id: generateId(),
          timestamp: Date.now(),
          asset,
          market,
          priceMove: move,
          gapPercent: gapResult.gap,
          suggestedSide: gapResult.direction,
          tokenId: gapResult.tokenSide === 'up' ? market.upTokenId : market.downTokenId,
          entryPrice: gapResult.tokenSide === 'up' ? marketData.upPrice : marketData.downPrice,
          liquidity,
          confidence,
          reason: `${asset} ${move.direction} ${formatPercent(Math.abs(move.movePercent))} in ${move.durationSeconds.toFixed(0)}s, gap ${formatPercent(gapResult.gap)}${hadSqueeze ? ' (post-squeeze)' : ''}`,
        };

        logSignal({
          asset: signal.asset,
          direction: signal.suggestedSide,
          gap: signal.gapPercent,
          confidence: signal.confidence,
          market: market.marketSlug,
        });

        // Execute trade
        this.executeSignal(signal);
      }
    }
  }

  /**
   * Calculate signal confidence based on various factors
   */
  private calculateSignalConfidence(
    move: PriceMove,
    gap: number,
    hadSqueeze: boolean,
    liquidity: number
  ): number {
    let confidence = 0.5;

    // Higher gap = higher confidence
    confidence += Math.min(gap / 0.10, 0.2); // Up to 20% boost for 10%+ gap

    // Stronger move = higher confidence
    confidence += Math.min(Math.abs(move.movePercent) / 0.05, 0.15); // Up to 15% for 5%+ move

    // Faster move = higher confidence
    if (move.durationSeconds < 30) {
      confidence += 0.1;
    }

    // Post-squeeze moves are more reliable
    if (hadSqueeze) {
      confidence += 0.1;
    }

    // Higher liquidity = higher confidence
    if (liquidity > 5000) {
      confidence += 0.05;
    }

    return Math.min(confidence, 0.99);
  }

  /**
   * Execute a trading signal
   */
  private async executeSignal(signal: Signal): Promise<void> {
    try {
      // Calculate position size
      const positionValue = this.state.accountBalance * this.config.positionSizePct;

      logger.info('Executing signal', {
        asset: signal.asset,
        side: signal.suggestedSide,
        positionValue: formatCurrency(positionValue),
        entryPrice: signal.entryPrice.toFixed(4),
      });

      // Place market buy order
      const order = await this.clobClient.marketBuy(
        signal.tokenId,
        positionValue,
        signal.market
      );

      if (order.status === 'failed') {
        logger.error('Failed to execute signal', { signal: signal.id });
        return;
      }

      // Create position
      const position: Position = {
        id: generateId(),
        market: signal.market,
        tokenId: signal.tokenId,
        side: signal.suggestedSide,
        entryPrice: order.avgFillPrice,
        entryTimestamp: Date.now(),
        size: order.filledSize,
        costBasis: order.avgFillPrice * order.filledSize,
        currentPrice: order.avgFillPrice,
        currentValue: order.avgFillPrice * order.filledSize,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        signal,
        status: 'open',
      };

      this.state.positions.set(signal.market.conditionId, position);

      logTrade({
        action: 'ENTRY',
        asset: signal.asset,
        side: signal.suggestedSide,
        price: order.avgFillPrice,
        size: order.filledSize,
      });

      this.emit('positionOpened', position);

    } catch (error) {
      logger.error('Error executing signal', {
        signal: signal.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Monitor open positions for exit conditions
   */
  private async monitorPositions(): Promise<void> {
    const now = Date.now();

    for (const [conditionId, position] of this.state.positions) {
      if (position.status !== 'open') {
        continue;
      }

      // Get current market price
      const marketData = this.marketPrices.get(conditionId);
      const priceData = this.cryptoPrices.get(position.signal.asset);

      if (!marketData || !priceData) {
        continue;
      }

      // Update position with current price
      const currentPrice = position.side === 'UP' ? marketData.upPrice : marketData.downPrice;
      position.currentPrice = currentPrice;
      position.currentValue = currentPrice * position.size;
      position.unrealizedPnl = position.currentValue - position.costBasis;
      position.unrealizedPnlPercent = position.unrealizedPnl / position.costBasis;

      // Calculate hold time
      const holdTimeMs = now - position.entryTimestamp;
      const holdTimeMinutes = holdTimeMs / (60 * 1000);

      // Log position status periodically
      if (Math.floor(holdTimeMinutes) % 2 === 0 && holdTimeMs % 60000 < 1000) {
        logPosition({
          asset: position.signal.asset,
          side: position.side,
          entryPrice: position.entryPrice,
          currentPrice: position.currentPrice,
          unrealizedPnl: position.unrealizedPnl,
          holdTime: holdTimeMinutes,
        });
      }

      // Check exit conditions
      let shouldExit = false;
      let exitReason: ExitReason = 'gap_closed';

      // 1. Gap has closed (market caught up)
      const currentGap = calculatePriceGap(
        position.signal.priceMove.movePercent,
        marketData.upImpliedProb,
        marketData.downImpliedProb
      );

      if (currentGap.gap < this.config.exitGapThreshold) {
        shouldExit = true;
        exitReason = 'gap_closed';
      }

      // 2. Max hold time exceeded
      if (holdTimeMinutes >= this.config.maxHoldMinutes) {
        shouldExit = true;
        exitReason = 'max_hold_time';
      }

      // 3. Stop loss (if configured)
      if (this.config.stopLossPct > 0 && position.unrealizedPnlPercent < -this.config.stopLossPct) {
        shouldExit = true;
        exitReason = 'stop_loss';
        logRisk('Stop loss triggered', {
          asset: position.signal.asset,
          pnlPercent: formatPercent(position.unrealizedPnlPercent),
        });
      }

      // 4. Market is about to expire (1 minute buffer)
      const timeToExpiry = position.market.expiryTime.getTime() - now;
      if (timeToExpiry < 60 * 1000) {
        shouldExit = true;
        exitReason = 'market_resolved';
      }

      if (shouldExit) {
        await this.closePosition(position, exitReason);
      }
    }
  }

  /**
   * Close a position
   */
  private async closePosition(position: Position, reason: ExitReason): Promise<void> {
    position.status = 'closing';

    logger.info('Closing position', {
      asset: position.signal.asset,
      side: position.side,
      reason,
      unrealizedPnl: formatCurrency(position.unrealizedPnl),
    });

    try {
      // Place market sell order
      const order = await this.clobClient.marketSell(
        position.tokenId,
        position.size,
        position.market
      );

      if (order.status === 'failed') {
        logger.error('Failed to close position', { positionId: position.id });
        position.status = 'open';
        return;
      }

      // Update position
      position.exitPrice = order.avgFillPrice;
      position.exitTimestamp = Date.now();
      position.realizedPnl = (order.avgFillPrice * order.filledSize) - position.costBasis;
      position.exitReason = reason;
      position.status = 'closed';

      // Update account balance
      this.state.accountBalance += position.realizedPnl;

      // Remove from active positions
      this.state.positions.delete(position.market.conditionId);

      logTrade({
        action: 'EXIT',
        asset: position.signal.asset,
        side: position.side,
        price: order.avgFillPrice,
        size: order.filledSize,
        pnl: position.realizedPnl,
      });

      // Record trade
      this.recordTrade(position);

      this.emit('positionClosed', position);

    } catch (error) {
      logger.error('Error closing position', {
        positionId: position.id,
        error: (error as Error).message,
      });
      position.status = 'open';
    }
  }

  /**
   * Close all positions
   */
  private async closeAllPositions(reason: ExitReason): Promise<void> {
    const positions = Array.from(this.state.positions.values());

    for (const position of positions) {
      if (position.status === 'open') {
        await this.closePosition(position, reason);
      }
    }
  }

  /**
   * Record trade to history
   */
  private recordTrade(position: Position): void {
    const holdTimeMinutes = (position.exitTimestamp! - position.entryTimestamp) / (60 * 1000);

    const record: TradeRecord = {
      timestamp: new Date(position.exitTimestamp!).toISOString(),
      asset: position.signal.asset,
      market: position.market.marketSlug,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: position.exitPrice!,
      size: position.size,
      costBasis: position.costBasis,
      proceeds: position.exitPrice! * position.size,
      pnl: position.realizedPnl!,
      pnlPercent: position.realizedPnl! / position.costBasis,
      holdTimeMinutes,
      exitReason: position.exitReason!,
      signalGap: position.signal.gapPercent,
      signalConfidence: position.signal.confidence,
    };

    this.tradeHistory.write(record);
  }

  /**
   * Check drawdown and pause if exceeded
   */
  private checkDrawdown(): boolean {
    const drawdown = (this.state.initialBalance - this.state.accountBalance) / this.state.initialBalance;
    this.state.currentDrawdown = drawdown;

    if (drawdown > this.state.maxDrawdown) {
      this.state.maxDrawdown = drawdown;
    }

    if (drawdown >= this.config.maxDrawdown) {
      if (!this.state.paused) {
        this.state.paused = true;
        this.state.pauseReason = `Max drawdown ${formatPercent(this.config.maxDrawdown)} reached`;

        logRisk('Max drawdown reached - strategy paused', {
          drawdown: formatPercent(drawdown),
          maxDrawdown: formatPercent(this.config.maxDrawdown),
        });
      }
      return true;
    }

    return false;
  }

  /**
   * Log session summary
   */
  private logSessionSummary(): void {
    const summary = this.tradeHistory.getSummary();

    logger.info('=== Session Summary ===', {
      totalTrades: summary.totalTrades,
      winningTrades: summary.winningTrades,
      losingTrades: summary.losingTrades,
      winRate: formatPercent(summary.winRate),
      totalPnl: formatCurrency(summary.totalPnl),
      averagePnl: formatCurrency(summary.averagePnl),
      averageHoldTime: `${summary.averageHoldTime.toFixed(1)} min`,
      maxDrawdown: formatPercent(this.state.maxDrawdown),
      finalBalance: formatCurrency(this.state.accountBalance),
    });
  }

  /**
   * Get current state
   */
  public getState(): StrategyState {
    return { ...this.state };
  }

  /**
   * Get open positions
   */
  public getPositions(): Position[] {
    return Array.from(this.state.positions.values());
  }

  /**
   * Pause the strategy
   */
  public pause(reason?: string): void {
    this.state.paused = true;
    this.state.pauseReason = reason;
    logger.info('Strategy paused', { reason });
  }

  /**
   * Resume the strategy
   */
  public resume(): void {
    if (this.state.currentDrawdown >= this.config.maxDrawdown) {
      logger.warn('Cannot resume: max drawdown still exceeded');
      return;
    }

    this.state.paused = false;
    this.state.pauseReason = undefined;
    logger.info('Strategy resumed');
  }
}

export default MomentumLagStrategy;

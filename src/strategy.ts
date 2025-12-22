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
  AssetValidation,
  ValidationCheck,
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
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private positionMonitorInterval: ReturnType<typeof setInterval> | null = null;

  // Validation chain tracking (for dashboard)
  private validationState: Map<CryptoAsset, AssetValidation> = new Map();

  // Execution tracking to prevent signal spam
  private pendingExecutions: Set<string> = new Set(); // conditionIds with in-flight orders
  private failedMarkets: Map<string, number> = new Map(); // conditionId -> cooldown until timestamp

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
    this.marketDiscovery = new MarketDiscoveryClient(config.host, config.maxHoldMinutes);

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

        const tokenType = market.upTokenId === assetId ? 'UP' : 'DOWN';
        const normalizedPrice = normalizeSharePrice(price);

        if (market.upTokenId === assetId) {
          existing.upPrice = normalizedPrice;
          existing.upImpliedProb = existing.upPrice;
        } else {
          existing.downPrice = normalizedPrice;
          existing.downImpliedProb = existing.downPrice;
        }

        existing.timestamp = timestamp;
        this.marketPrices.set(conditionId, existing);

        // Log WS price updates to diagnose 50/50 issue
        logger.debug('WS price update', {
          asset: market.asset,
          tokenType,
          newPrice: (normalizedPrice * 100).toFixed(1) + '%',
          tokenId: assetId.substring(0, 16) + '...',
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
    // Clear both maps to ensure fresh data for new markets
    // This is critical when markets expire and new ones are discovered
    this.activeMarkets.clear();
    this.marketPrices.clear();

    for (const market of markets) {
      this.activeMarkets.set(market.conditionId, market);

      // Initialize market prices from token data (live prices from CLOB /midpoint API)
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
        upPrice: (upPrice * 100).toFixed(1) + '%',
        downPrice: (downPrice * 100).toFixed(1) + '%',
        upTokenId: market.upTokenId.substring(0, 16) + '...',
        downTokenId: market.downTokenId.substring(0, 16) + '...',
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
    const assets: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

    // Global checks first
    const maxPositionsReached = this.state.positions.size >= this.config.maxPositions;
    const drawdownHit = this.checkDrawdown();

    for (const asset of assets) {
      const checks: ValidationCheck[] = [];
      let blocked = false;
      let blockReason = '';

      // CHECK 1: Max positions
      if (maxPositionsReached) {
        checks.push({
          name: 'Max Positions',
          status: 'failed',
          value: `${this.state.positions.size}`,
          threshold: `${this.config.maxPositions}`,
          reason: 'At maximum concurrent positions',
        });
        blocked = true;
        blockReason = 'Max positions reached';
      } else {
        checks.push({
          name: 'Max Positions',
          status: 'passed',
          value: `${this.state.positions.size}`,
          threshold: `${this.config.maxPositions}`,
        });
      }

      // CHECK 2: Drawdown
      if (!blocked && drawdownHit) {
        checks.push({
          name: 'Drawdown',
          status: 'failed',
          value: formatPercent(this.state.currentDrawdown),
          threshold: formatPercent(this.config.maxDrawdown),
          reason: 'Max drawdown exceeded',
        });
        blocked = true;
        blockReason = 'Max drawdown exceeded';
      } else if (!blocked) {
        checks.push({
          name: 'Drawdown',
          status: 'passed',
          value: formatPercent(this.state.currentDrawdown),
          threshold: formatPercent(this.config.maxDrawdown),
        });
      } else {
        checks.push({ name: 'Drawdown', status: 'skipped' });
      }

      // CHECK 3: Price data available
      const priceData = this.cryptoPrices.get(asset);
      if (!blocked && (!priceData || priceData.priceHistory.length < 10)) {
        checks.push({
          name: 'Price Data',
          status: 'failed',
          value: priceData ? `${priceData.priceHistory.length} points` : 'none',
          threshold: '10+ points',
          reason: 'Insufficient price history',
        });
        blocked = true;
        blockReason = 'No price data';
      } else if (!blocked) {
        checks.push({
          name: 'Price Data',
          status: 'passed',
          value: `${priceData!.priceHistory.length} points`,
        });
      } else {
        checks.push({ name: 'Price Data', status: 'skipped' });
      }

      // CHECK 4: Hard move detection
      let move: PriceMove | null = null;
      if (!blocked && priceData) {
        move = detectHardMove(
          priceData.priceHistory,
          asset,
          this.config.moveThreshold,
          60,
          this.config.bbPeriod
        );

        if (!move) {
          checks.push({
            name: 'Hard Move',
            status: 'failed',
            value: 'No move detected',
            threshold: formatPercent(this.config.moveThreshold),
            reason: 'Price not moving enough',
          });
          blocked = true;
          blockReason = 'No hard move detected';
        } else {
          checks.push({
            name: 'Hard Move',
            status: 'passed',
            value: `${move.direction} ${formatPercent(Math.abs(move.movePercent))}`,
            threshold: formatPercent(this.config.moveThreshold),
          });
        }
      } else {
        checks.push({ name: 'Hard Move', status: 'skipped' });
      }

      // CHECK 5: Active market exists
      const markets = Array.from(this.activeMarkets.values()).filter(m => m.asset === asset);
      if (!blocked && markets.length === 0) {
        checks.push({
          name: 'Active Market',
          status: 'failed',
          value: '0 markets',
          reason: 'No active 15m market',
        });
        blocked = true;
        blockReason = 'No active market';
      } else if (!blocked) {
        checks.push({
          name: 'Active Market',
          status: 'passed',
          value: `${markets.length} market(s)`,
        });
      } else {
        checks.push({ name: 'Active Market', status: 'skipped' });
      }

      // Process first active market only (one per asset)
      let signalTriggered = false;
      if (!blocked && move && markets.length > 0) {
        const hadSqueeze = move.volatilityBefore.isSqueezing;
        const market = markets[0]; // Use first active market

        // CHECK 6: No existing position
        if (this.state.positions.has(market.conditionId)) {
          checks.push({
            name: 'No Existing Position',
            status: 'failed',
            reason: 'Already have position in this market',
          });
          blockReason = 'Already have position';
          blocked = true;
        } else {
          checks.push({ name: 'No Existing Position', status: 'passed' });
        }

        // CHECK 7: Market data available
        const marketData = !blocked ? this.marketPrices.get(market.conditionId) : null;

        // Debug: Log raw market data values to verify they're correct
        if (marketData) {
          logger.debug('Market data values', {
            asset,
            upPrice: marketData.upPrice.toFixed(4),
            downPrice: marketData.downPrice.toFixed(4),
            upImpliedProb: marketData.upImpliedProb.toFixed(4),
            downImpliedProb: marketData.downImpliedProb.toFixed(4),
            movePercent: move ? (move.movePercent * 100).toFixed(2) + '%' : 'N/A',
          });
        }

        if (!blocked && !marketData) {
          checks.push({
            name: 'Market Data',
            status: 'failed',
            reason: 'No market price data',
          });
          blockReason = 'No market price data';
          blocked = true;
        } else if (!blocked && marketData) {
          checks.push({
            name: 'Market Data',
            status: 'passed',
            value: `UP ${formatPercent(marketData.upPrice)} / DN ${formatPercent(marketData.downPrice)}`,
          });

          // CHECK 8: Gap threshold
          logger.debug('Gap calc inputs', {
            asset,
            movePercent: (move.movePercent * 100).toFixed(2) + '%',
            moveDirection: move.direction,
            upImpliedProb: (marketData.upImpliedProb * 100).toFixed(1) + '%',
            downImpliedProb: (marketData.downImpliedProb * 100).toFixed(1) + '%',
          });

          const gapResult = calculatePriceGap(
            move.movePercent,
            marketData.upImpliedProb,
            marketData.downImpliedProb,
            this.config.moveThreshold
          );

          const absMove = Math.abs(move.movePercent);
          const expectedPrice = Math.min(0.5 + absMove * 5, 0.95);
          const currentProb = move.direction === 'up' ? marketData.upImpliedProb : marketData.downImpliedProb;
          const rawGap = expectedPrice - currentProb;

          logger.debug('Gap calc result', {
            asset,
            expectedPrice: (expectedPrice * 100).toFixed(1) + '%',
            currentProb: (currentProb * 100).toFixed(1) + '%',
            rawGap: (rawGap * 100).toFixed(1) + '%',
            finalGap: (gapResult.gap * 100).toFixed(1) + '%',
            threshold: (this.config.gapThreshold * 100).toFixed(1) + '%',
          });

          if (gapResult.gap < this.config.gapThreshold) {
            checks.push({
              name: 'Gap Threshold',
              status: 'failed',
              value: formatPercent(gapResult.gap),
              threshold: formatPercent(this.config.gapThreshold),
              reason: `Move ${formatPercent(move.movePercent)} → Exp ${formatPercent(expectedPrice)} vs Mkt ${formatPercent(currentProb)} = ${formatPercent(rawGap)}`,
            });
            blockReason = `Gap ${formatPercent(gapResult.gap)} < ${formatPercent(this.config.gapThreshold)}`;
            blocked = true;
          } else {
            checks.push({
              name: 'Gap Threshold',
              status: 'passed',
              value: formatPercent(gapResult.gap),
              threshold: formatPercent(this.config.gapThreshold),
            });

            // CHECK 9: Liquidity
            const liquidity = gapResult.tokenSide === 'up' ? marketData.liquidityUp : marketData.liquidityDown;
            if (liquidity < this.config.minLiquidity) {
              checks.push({
                name: 'Liquidity',
                status: 'failed',
                value: formatCurrency(liquidity),
                threshold: formatCurrency(this.config.minLiquidity),
                reason: 'Insufficient liquidity',
              });
              blockReason = `Liquidity $${liquidity.toFixed(0)} < $${this.config.minLiquidity}`;
              blocked = true;
            } else {
              checks.push({
                name: 'Liquidity',
                status: 'passed',
                value: formatCurrency(liquidity),
                threshold: formatCurrency(this.config.minLiquidity),
              });

              // ALL CHECKS PASSED - Create and execute signal
              const confidence = this.calculateSignalConfidence(move, gapResult.gap, hadSqueeze, liquidity);

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

              this.executeSignal(signal);
              signalTriggered = true;
            }
          }
        }
      }

      // Update validation state for this asset
      this.validationState.set(asset, {
        asset,
        timestamp: Date.now(),
        checks,
        finalResult: signalTriggered ? 'signal_triggered' : (blocked ? 'blocked' : 'no_opportunity'),
        blockReason: blocked ? blockReason : undefined,
      });
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
    const conditionId = signal.market.conditionId;

    // Check MAX_POSITIONS limit
    if (this.state.positions.size >= this.config.maxPositions) {
      logger.debug('Skipping signal - max positions reached', {
        current: this.state.positions.size,
        max: this.config.maxPositions,
      });
      return;
    }

    // Check if execution is already in progress for this market
    if (this.pendingExecutions.has(conditionId)) {
      logger.debug('Skipping signal - execution already in progress');
      return;
    }

    // Check if market is on cooldown after failure
    const cooldownUntil = this.failedMarkets.get(conditionId);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      logger.debug('Skipping signal - market on cooldown after failure');
      return;
    }

    // Mark as executing
    this.pendingExecutions.add(conditionId);

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
        // Add 30 second cooldown for this market
        this.failedMarkets.set(conditionId, Date.now() + 30000);
        return;
      }

      // Clear any previous failure cooldown on success
      this.failedMarkets.delete(conditionId);

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

      this.state.positions.set(conditionId, position);

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
      // Add 30 second cooldown for this market on error
      this.failedMarkets.set(conditionId, Date.now() + 30000);
    } finally {
      // Always remove from pending executions
      this.pendingExecutions.delete(conditionId);
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
        marketData.downImpliedProb,
        this.config.moveThreshold
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
   * Get recent signals (for dashboard)
   */
  public getSignals(limit: number = 50): Signal[] {
    return this.state.signals.slice(-limit);
  }

  /**
   * Get crypto prices (for dashboard)
   */
  public getCryptoPrices(): Map<CryptoAsset, CryptoPriceData> {
    return new Map(this.cryptoPrices);
  }

  /**
   * Get market prices (for dashboard)
   */
  public getMarketPrices(): Map<string, MarketPriceData> {
    return new Map(this.marketPrices);
  }

  /**
   * Get active markets (for dashboard)
   */
  public getActiveMarkets(): CryptoMarket[] {
    return Array.from(this.activeMarkets.values());
  }

  /**
   * Get validation state (for dashboard)
   */
  public getValidationState(): AssetValidation[] {
    return Array.from(this.validationState.values());
  }

  /**
   * Get trade history writer (for dashboard)
   */
  public getTradeHistoryWriter(): TradeHistoryWriter {
    return this.tradeHistory;
  }

  /**
   * Get WebSocket connection health
   */
  public getWebSocketHealth(): { binance: boolean; polymarket: boolean } {
    return {
      binance: this.binanceClient.isConnected(),
      polymarket: this.polymarketWs.isConnected(),
    };
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

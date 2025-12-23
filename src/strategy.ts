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
import { detectHardMove, getMoveProgress } from './utils/volatility.js';
import {
  calculatePriceGapV2,
  generateId,
  normalizeSharePrice,
  formatPercent,
  formatCurrency,
} from './utils/helpers.js';
import logger, { logSignal, logTrade, logPosition, logRisk } from './utils/logger.js';
import { TradeHistoryWriter } from './utils/csv.js';
import { initTestSession, TestSessionRecorder } from './utils/test-session.js';

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

  // Test session recorder for detailed execution analysis
  private testSession: TestSessionRecorder | null = null;

  // Monitoring intervals
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private positionMonitorInterval: ReturnType<typeof setInterval> | null = null;
  private positionSyncInterval: ReturnType<typeof setInterval> | null = null;

  // Validation chain tracking (for dashboard)
  private validationState: Map<CryptoAsset, AssetValidation> = new Map();

  // Execution tracking to prevent signal spam
  private pendingExecutions: Set<string> = new Set(); // conditionIds with in-flight orders
  private failedMarkets: Map<string, number> = new Map(); // conditionId -> cooldown until timestamp

  // Recently closed positions - prevent re-adding as orphans during Data API sync lag
  private recentlyClosedPositions: Map<string, number> = new Map(); // conditionId -> closed timestamp
  private readonly POSITION_COOLDOWN_MS = 30000; // 30 second cooldown after close

  // Signal cooldown to prevent duplicate signals for same opportunity
  private lastSignal: Map<CryptoAsset, { direction: 'up' | 'down'; timestamp: number }> = new Map();
  private readonly SIGNAL_COOLDOWN_MS = 5000; // 5 second cooldown per asset+direction

  // Warm-up mode tracking - only trade markets discovered fresh (not mid-window)
  private warmupMarkets: Set<string> = new Set(); // conditionIds discovered at startup (monitor only)
  private warmupComplete: boolean = false; // True once all startup markets have expired
  private startupTimestamp: number = 0; // When bot started

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

      // Initialize test session recorder for detailed execution analysis
      this.testSession = initTestSession(this.config);
      logger.info('Test session recorder initialized', {
        filePath: this.testSession.getFilePath(),
        positionSizePct: formatPercent(this.config.positionSizePct),
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

    if (this.positionSyncInterval) {
      clearInterval(this.positionSyncInterval);
      this.positionSyncInterval = null;
    }

    // Close all positions
    await this.closeAllPositions('manual');

    // Disconnect clients
    this.binanceClient.disconnect();
    this.polymarketWs.disconnect();
    this.marketDiscovery.stop();

    this.state.isRunning = false;
    logger.info('Strategy stopped');

    // Finalize test session and log detailed summary
    if (this.testSession) {
      const sessionSummary = this.testSession.finalize();
      logger.info('=== TEST SESSION SUMMARY ===', {
        durationMinutes: sessionSummary.durationMinutes.toFixed(1),
        signalsDetected: sessionSummary.signalsDetected,
        signalsExecuted: sessionSummary.signalsExecuted,
        ordersSubmitted: sessionSummary.ordersSubmitted,
        ordersFilled: sessionSummary.ordersFilled,
        ordersFailed: sessionSummary.ordersFailed,
        positionsOpened: sessionSummary.positionsOpened,
        positionsClosed: sessionSummary.positionsClosed,
        orphanedHandled: sessionSummary.orphanedPositionsHandled,
        totalPnl: formatCurrency(sessionSummary.totalPnl),
        winCount: sessionSummary.winCount,
        lossCount: sessionSummary.lossCount,
        avgLatencyMs: sessionSummary.avgLatencyMs.toFixed(0),
        avgSlippage: formatPercent(sessionSummary.avgSlippage),
      });
    }

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
    // Track warm-up mode: on startup, mark all discovered markets as warm-up only
    // We only trade markets discovered fresh (after startup markets expire)
    const isFirstUpdate = this.startupTimestamp === 0;
    if (isFirstUpdate) {
      this.startupTimestamp = Date.now();
      // Mark all initial markets as warm-up (monitor but don't trade)
      for (const market of markets) {
        this.warmupMarkets.add(market.conditionId);
      }
      if (markets.length > 0) {
        logger.info('=== WARM-UP MODE STARTED ===', {
          warmupMarkets: markets.length,
          reason: 'Waiting for fresh 15m markets to start trading',
          assets: markets.map(m => m.asset).join(', '),
          conditionIds: markets.map(m => `${m.asset}:${m.conditionId.substring(0, 8)}`).join(', '),
        });
      } else {
        // No markets at startup - lucky timing, skip warm-up
        this.warmupComplete = true;
        logger.info('=== CLEAN START - NO WARM-UP NEEDED ===', {
          reason: 'No active markets at startup, will trade first fresh markets',
        });
      }
    } else if (!this.warmupComplete) {
      // Check if any warm-up markets are still active
      const activeWarmupMarkets = markets.filter(m => this.warmupMarkets.has(m.conditionId));
      const newFreshMarkets = markets.filter(m => !this.warmupMarkets.has(m.conditionId));

      if (activeWarmupMarkets.length === 0 && newFreshMarkets.length > 0) {
        // All warm-up markets expired, new fresh markets available - transition to active trading
        this.warmupComplete = true;
        logger.info('=== WARM-UP COMPLETE - ACTIVE TRADING ENABLED ===', {
          freshMarkets: newFreshMarkets.length,
          assets: newFreshMarkets.map(m => m.asset).join(', '),
          conditionIds: newFreshMarkets.map(m => `${m.asset}:${m.conditionId.substring(0, 8)}`).join(', '),
          warmupDurationSeconds: Math.round((Date.now() - this.startupTimestamp) / 1000),
        });
      } else if (newFreshMarkets.length > 0) {
        // Some fresh markets appeared but old warm-up markets still active
        // NOTE: Fresh markets are still tradeable via the check at line ~870!
        logger.info('Fresh markets available (warmup markets still tracked)', {
          warmupRemaining: activeWarmupMarkets.length,
          warmupAssets: activeWarmupMarkets.map(m => m.asset).join(', '),
          freshAvailable: newFreshMarkets.length,
          freshAssets: newFreshMarkets.map(m => m.asset).join(', '),
          freshConditionIds: newFreshMarkets.map(m => `${m.asset}:${m.conditionId.substring(0, 8)}`).join(', '),
          note: 'Fresh markets ARE tradeable now',
        });
      }
    }

    // Clear both maps to ensure fresh data for new markets
    // This is critical when markets expire and new ones are discovered
    this.activeMarkets.clear();
    this.marketPrices.clear();

    for (const market of markets) {
      // Calculate window start time (expiry - 15 minutes)
      const expiryMs = market.expiryTime instanceof Date
        ? market.expiryTime.getTime()
        : new Date(market.expiryTime).getTime();
      const windowStartTime = expiryMs - (15 * 60 * 1000);

      // Capture current crypto price as window start price
      // (This is approximate - ideally we'd get the exact price at window start)
      const priceData = this.cryptoPrices.get(market.asset);
      const windowStartCryptoPrice = priceData?.price;

      // Augment market with window tracking data
      const augmentedMarket: CryptoMarket = {
        ...market,
        windowStartTime,
        windowStartCryptoPrice,
      };

      this.activeMarkets.set(market.conditionId, augmentedMarket);

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
    // Sync on-chain positions immediately on start
    this.syncOnChainPositions();

    // Monitor positions every second
    this.positionMonitorInterval = setInterval(() => {
      this.monitorPositions();
    }, 1000);

    // Sync on-chain positions every 10 seconds for reliability
    this.positionSyncInterval = setInterval(() => {
      this.syncOnChainPositions();
    }, 10000);
  }

  /**
   * Sync positions with on-chain state from CLOB API
   * This ensures dashboard shows real positions even if bot restarts
   */
  private async syncOnChainPositions(): Promise<void> {
    try {
      const onChainPositions = await this.clobClient.getPositions();

      if (onChainPositions.length === 0) {
        // No on-chain positions - clear any stale internal tracking
        if (this.state.positions.size > 0) {
          logger.info('No on-chain positions found, clearing stale internal positions');
          this.state.positions.clear();
        }
        return;
      }

      // Build a set of on-chain token IDs for quick lookup
      const onChainTokenIds = new Set(onChainPositions.map(p => p.asset_id));

      // Remove internal positions that no longer exist on-chain OR have expired markets
      const now = Date.now();
      for (const [conditionId, position] of this.state.positions) {
        const tokenId = position.side === 'UP' ? position.market.upTokenId : position.market.downTokenId;

        // Check if market has expired
        const expiryTime = position.market.expiryTime instanceof Date
          ? position.market.expiryTime.getTime()
          : new Date(position.market.expiryTime).getTime();

        if (expiryTime < now) {
          logger.info('Removing position - market expired and resolved', {
            asset: position.signal.asset,
            conditionId: conditionId.substring(0, 16),
            expiredMinutesAgo: ((now - expiryTime) / 60000).toFixed(1),
          });
          this.state.positions.delete(conditionId);
          continue;
        }

        if (!onChainTokenIds.has(tokenId)) {
          logger.info('Position no longer exists on-chain, removing from tracking', {
            asset: position.signal.asset,
            conditionId: conditionId.substring(0, 16),
          });
          this.state.positions.delete(conditionId);
        }
      }

      // Check for orphaned on-chain positions not in our tracking
      for (const onChainPos of onChainPositions) {
        const size = parseFloat(onChainPos.size);
        if (size <= 0) continue;

        // Find which market this token belongs to
        let foundInTracking = false;
        for (const position of this.state.positions.values()) {
          const tokenId = position.side === 'UP' ? position.market.upTokenId : position.market.downTokenId;
          if (tokenId === onChainPos.asset_id) {
            // Update size from on-chain data
            position.size = size;
            position.currentValue = position.currentPrice * size;
            position.unrealizedPnl = position.currentValue - position.costBasis;
            position.unrealizedPnlPercent = position.costBasis > 0 ? position.unrealizedPnl / position.costBasis : 0;
            foundInTracking = true;
            break;
          }
        }

        if (!foundInTracking) {
          // Orphaned position - find the market it belongs to
          // First try active markets, then fetch from API
          let market = Array.from(this.activeMarkets.values()).find(
            m => m.upTokenId === onChainPos.asset_id || m.downTokenId === onChainPos.asset_id
          );

          // If not in active markets, fetch from API (handles markets with <2min left)
          if (!market) {
            market = await this.marketDiscovery.getMarketByTokenId(onChainPos.asset_id);
          }

          if (market) {
              // Check if market has already expired - don't track resolved positions
              const now = Date.now();
              const expiryTime = market.expiryTime instanceof Date
                ? market.expiryTime.getTime()
                : new Date(market.expiryTime).getTime();

              if (expiryTime < now) {
                logger.debug('Skipping orphaned position - market already expired', {
                  asset: market.asset,
                  tokenId: onChainPos.asset_id.substring(0, 20),
                  expiredMinutesAgo: ((now - expiryTime) / 60000).toFixed(1),
                });
                continue;
              }

              // Check if this position was recently closed - Data API may lag behind actual state
              const closedTimestamp = this.recentlyClosedPositions.get(market.conditionId);
              if (closedTimestamp && (now - closedTimestamp) < this.POSITION_COOLDOWN_MS) {
                logger.debug('Skipping orphaned position - recently closed (Data API lag)', {
                  asset: market.asset,
                  tokenId: onChainPos.asset_id.substring(0, 20),
                  closedSecondsAgo: ((now - closedTimestamp) / 1000).toFixed(0),
                  cooldownMs: this.POSITION_COOLDOWN_MS,
                });
                continue;
              }

              const side = market.upTokenId === onChainPos.asset_id ? 'UP' : 'DOWN';
              const avgPrice = parseFloat(onChainPos.avg_entry_price) || 0.5;

              logger.info('Found orphaned on-chain position, adding to tracking', {
                asset: market.asset,
                side,
                size: size.toFixed(2),
                avgPrice: avgPrice.toFixed(4),
                tokenId: onChainPos.asset_id.substring(0, 20),
              });

              // Create a synthetic position for tracking (marked as orphaned)
              const position: Position = {
                id: generateId(),
                market,
                isOrphaned: true, // Mark as orphaned - will be excluded from trade stats
                signal: {
                  id: 'orphan-' + generateId(),
                  timestamp: Date.now(),
                  asset: market.asset,
                  market,
                  priceMove: {
                    asset: market.asset,
                    movePercent: 0,
                    direction: side === 'UP' ? 'up' : 'down',
                    durationSeconds: 0,
                    startPrice: 0,
                    endPrice: 0,
                    timestamp: Date.now(),
                    volatilityBefore: {
                      standardDeviation: 0,
                      bollingerBandWidth: 0,
                      upperBand: 0,
                      lowerBand: 0,
                      middleBand: 0,
                      isSqueezing: false,
                    },
                  },
                  gapPercent: 0,
                  suggestedSide: side,
                  tokenId: onChainPos.asset_id,
                  entryPrice: avgPrice,
                  liquidity: 0,
                  confidence: 0,
                  reason: 'Orphaned position from on-chain sync',
                },
                side,
                tokenId: onChainPos.asset_id,
                entryPrice: avgPrice,
                currentPrice: avgPrice,
                size,
                costBasis: avgPrice * size,
                currentValue: avgPrice * size,
                unrealizedPnl: 0,
                unrealizedPnlPercent: 0,
                entryTimestamp: Date.now(),
                status: 'open',
              };

              this.state.positions.set(market.conditionId, position);
          } else {
            // No matching market found (likely already settled)
            logger.debug('On-chain position has no matching active market (likely expired)', {
              tokenId: onChainPos.asset_id.substring(0, 20),
              size: size.toFixed(2),
              activeMarketCount: this.activeMarkets.size,
            });
          }
        }
      }

      logger.debug('On-chain position sync complete', {
        onChainCount: onChainPositions.length,
        trackedCount: this.state.positions.size,
      });

    } catch (error) {
      logger.warn('Failed to sync on-chain positions', { error: (error as Error).message });
    }
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

        // CHECK 6.5: Warm-up mode check - don't trade markets discovered at startup
        const isInWarmupSet = this.warmupMarkets.has(market.conditionId);
        if (!blocked && !this.warmupComplete && isInWarmupSet) {
          const warmupElapsed = Math.round((Date.now() - this.startupTimestamp) / 1000);
          logger.info('Signal BLOCKED by warm-up', {
            asset,
            conditionId: market.conditionId.substring(0, 12) + '...',
            warmupComplete: this.warmupComplete,
            isInWarmupSet,
            warmupSetSize: this.warmupMarkets.size,
            warmupElapsed: `${warmupElapsed}s`,
          });
          checks.push({
            name: 'Warm-up Mode',
            status: 'failed',
            value: `${warmupElapsed}s since startup`,
            reason: 'Market discovered mid-window, waiting for fresh market',
          });
          blockReason = 'Warm-up mode - waiting for fresh market';
          blocked = true;
        } else if (!blocked) {
          // Fresh market or warmup complete - allowed to trade
          logger.debug('Warm-up check passed', {
            asset,
            conditionId: market.conditionId.substring(0, 12) + '...',
            warmupComplete: this.warmupComplete,
            isInWarmupSet,
            reason: this.warmupComplete ? 'Warmup complete' : 'Fresh market (not in warmup set)',
          });
          checks.push({
            name: 'Warm-up Mode',
            status: 'passed',
            value: this.warmupComplete ? 'Complete' : 'Fresh market',
          });
        } else {
          checks.push({ name: 'Warm-up Mode', status: 'skipped' });
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

          // CHECK 8: Gap threshold using TOTAL WINDOW MOVE
          // The reference price is the crypto price at window start (expiry - 15 min)
          // We compare current price to reference to determine total move
          const referencePrice = market.windowStartCryptoPrice;
          const currentCryptoPrice = priceData!.price;

          // Calculate total window move (current vs reference price)
          let totalWindowMove = 0;
          if (referencePrice && referencePrice > 0) {
            totalWindowMove = (currentCryptoPrice - referencePrice) / referencePrice;
          }

          logger.debug('Gap calc inputs (V2 - Total Window Move)', {
            asset,
            referencePrice: referencePrice?.toFixed(2) ?? 'N/A',
            currentCryptoPrice: currentCryptoPrice.toFixed(2),
            totalWindowMove: (totalWindowMove * 100).toFixed(2) + '%',
            recentMove: (move.movePercent * 100).toFixed(2) + '%',
            upImpliedProb: (marketData.upImpliedProb * 100).toFixed(1) + '%',
            downImpliedProb: (marketData.downImpliedProb * 100).toFixed(1) + '%',
          });

          // Use new gap calculation based on total window move
          const gapResult = calculatePriceGapV2(
            totalWindowMove,
            move.movePercent,
            marketData.upImpliedProb,
            marketData.downImpliedProb,
            this.config.moveThreshold
          );

          const expectedPrice = gapResult.expectedProb;
          const currentProb = gapResult.direction === 'UP' ? marketData.upImpliedProb : marketData.downImpliedProb;
          const rawGap = expectedPrice - currentProb;

          // Log at debug level when gap is 0 (too spammy at info)
          if (gapResult.gap === 0) {
            logger.debug('Gap is ZERO', {
              asset,
              totalWindowMove: (totalWindowMove * 100).toFixed(2) + '%',
              recentMove: (move.movePercent * 100).toFixed(2) + '%',
              moveThreshold: (this.config.moveThreshold * 100).toFixed(2) + '%',
              moveExceedsThreshold: Math.abs(move.movePercent) > this.config.moveThreshold,
              upImpliedProb: (marketData.upImpliedProb * 100).toFixed(1) + '%',
              downImpliedProb: (marketData.downImpliedProb * 100).toFixed(1) + '%',
              expectedPrice: (expectedPrice * 100).toFixed(1) + '%',
              currentProb: (currentProb * 100).toFixed(1) + '%',
              rawGap: (rawGap * 100).toFixed(1) + '%',
              reason: rawGap <= 0 ? 'Market already at or above expected price' : 'Move below threshold',
            });
          } else {
            logger.debug('Gap calc result (V2)', {
              asset,
              totalWindowMove: (totalWindowMove * 100).toFixed(2) + '%',
              expectedPrice: (expectedPrice * 100).toFixed(1) + '%',
              currentProb: (currentProb * 100).toFixed(1) + '%',
              rawGap: (rawGap * 100).toFixed(1) + '%',
              finalGap: (gapResult.gap * 100).toFixed(1) + '%',
              threshold: (this.config.gapThreshold * 100).toFixed(1) + '%',
            });
          }

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

              // Check signal cooldown to prevent duplicate signals
              const lastSig = this.lastSignal.get(asset);
              const now = Date.now();
              const signalDirection = move.direction;

              if (lastSig) {
                const timeSinceLastSignal = now - lastSig.timestamp;
                const sameDirection = lastSig.direction === signalDirection;

                // Skip if same direction and within cooldown period
                if (sameDirection && timeSinceLastSignal < this.SIGNAL_COOLDOWN_MS) {
                  checks.push({
                    name: 'Signal Cooldown',
                    status: 'failed',
                    value: `${((this.SIGNAL_COOLDOWN_MS - timeSinceLastSignal) / 1000).toFixed(0)}s remaining`,
                    threshold: `${this.SIGNAL_COOLDOWN_MS / 1000}s`,
                    reason: 'Cooldown active for same direction',
                  });
                  blockReason = `Signal cooldown: ${signalDirection} signal fired ${(timeSinceLastSignal / 1000).toFixed(0)}s ago`;
                  blocked = true;
                  break; // Exit the market loop for this asset
                }
              }

              // Update last signal tracker
              this.lastSignal.set(asset, { direction: signalDirection, timestamp: now });

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

              // Add signal to state for dashboard tracking
              this.state.signals.push(signal);
              // Keep only last 100 signals
              if (this.state.signals.length > 100) {
                this.state.signals = this.state.signals.slice(-100);
              }

              logSignal({
                asset: signal.asset,
                direction: signal.suggestedSide,
                gap: signal.gapPercent,
                confidence: signal.confidence,
                market: market.marketSlug,
              });

              // Record signal to test session
              if (this.testSession) {
                this.testSession.recordSignal(signal);
              }

              // Emit signal event for dashboard WebSocket
              this.emit('signalDetected', signal);

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
      // Calculate position size based on bankroll percentage from .env
      const positionValue = this.state.accountBalance * this.config.positionSizePct;
      const signalTimestamp = signal.timestamp; // When signal was first detected

      logger.info('Executing signal', {
        asset: signal.asset,
        side: signal.suggestedSide,
        positionValue: formatCurrency(positionValue),
        bankrollPct: formatPercent(this.config.positionSizePct),
        signalPrice: signal.entryPrice.toFixed(4),
        gap: formatPercent(signal.gapPercent),
        confidence: formatPercent(signal.confidence),
      });

      // Capture order submission time
      const orderSubmitTimestamp = Date.now();

      // Record order submission to test session
      if (this.testSession) {
        this.testSession.recordOrderSubmitted(
          signal.asset,
          signal.suggestedSide,
          'BUY',
          positionValue,
          signal.entryPrice
        );
      }

      // Place FAK (Fill-And-Kill / IOC) limit buy order with slippage tolerance
      // This allows partial fills up to maxEntrySlippage above signal price
      // Better than FOK which fails entirely if order can't be 100% filled
      const maxLimitPrice = signal.entryPrice * (1 + this.config.maxEntrySlippage);
      logger.debug('FAK order with slippage cap', {
        signalPrice: signal.entryPrice.toFixed(4),
        maxSlippage: (this.config.maxEntrySlippage * 100).toFixed(1) + '%',
        maxLimitPrice: maxLimitPrice.toFixed(4),
      });
      const order = await this.clobClient.limitBuyFAK(
        signal.tokenId,
        positionValue,
        maxLimitPrice,  // Use signal price + slippage tolerance as limit
        signal.market
      );

      if (order.status === 'failed') {
        logger.error('Failed to execute signal', { signal: signal.id });
        // Record order failure to test session
        if (this.testSession) {
          this.testSession.recordOrderFailed(
            signal.asset,
            signal.suggestedSide,
            'BUY',
            positionValue,
            order.failureReason || 'unknown'
          );
        }
        // Add 30 second cooldown for this market
        this.failedMarkets.set(conditionId, Date.now() + 30000);
        return;
      }

      // Clear any previous failure cooldown on success
      this.failedMarkets.delete(conditionId);

      // Calculate execution metrics
      const fillTimestamp = Date.now();
      const orderLatencyMs = fillTimestamp - signalTimestamp;
      const slippage = signal.entryPrice > 0
        ? (order.avgFillPrice - signal.entryPrice) / signal.entryPrice
        : 0;

      logger.info('Order filled', {
        asset: signal.asset,
        side: signal.suggestedSide,
        expectedPrice: signal.entryPrice.toFixed(4),
        fillPrice: order.avgFillPrice.toFixed(4),
        slippage: (slippage * 100).toFixed(2) + '%',
        latencyMs: orderLatencyMs,
        filledSize: order.filledSize.toFixed(2),
      });

      // Record order fill to test session
      if (this.testSession) {
        this.testSession.recordOrderFilled(
          signal.asset,
          signal.suggestedSide,
          'BUY',
          positionValue,
          order.filledSize,
          signal.entryPrice,
          order.avgFillPrice,
          orderLatencyMs
        );
      }

      // Create position with timing data
      const position: Position = {
        id: generateId(),
        market: signal.market,
        tokenId: signal.tokenId,
        side: signal.suggestedSide,
        entryPrice: order.avgFillPrice,
        entryTimestamp: fillTimestamp,
        size: order.filledSize,
        costBasis: order.avgFillPrice * order.filledSize,
        currentPrice: order.avgFillPrice,
        currentValue: order.avgFillPrice * order.filledSize,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        signal,
        status: 'open',
        isOrphaned: false,
        signalTimestamp,
        orderSubmitTimestamp,
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

      // Record position opened to test session
      if (this.testSession) {
        this.testSession.recordPositionOpened(position);
      }

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
      // Use total window move for gap calculation
      const referencePrice = position.market.windowStartCryptoPrice;
      const currentCryptoPrice = priceData.price;
      let totalWindowMove = 0;
      if (referencePrice && referencePrice > 0) {
        totalWindowMove = (currentCryptoPrice - referencePrice) / referencePrice;
      }

      const currentGap = calculatePriceGapV2(
        totalWindowMove,
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

      // 4. Market approaching expiry - OVERRIDE any exit decision
      // Let position resolve naturally (trying to sell with no liquidity is pointless)
      const timeToExpiry = position.market.expiryTime.getTime() - now;
      if (timeToExpiry < 60 * 1000 && timeToExpiry > 0) {
        if (shouldExit) {
          logger.info('Position approaching expiry, skipping sell - will let market resolve', {
            asset: position.signal.asset,
            timeToExpirySeconds: Math.floor(timeToExpiry / 1000),
            originalExitReason: exitReason,
          });
          shouldExit = false; // Override - don't try to sell, let it resolve
        }
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
      // Market sell to ensure we can always exit
      // FOK for exits caused issues when liquidity was thin near expiry
      const order = await this.clobClient.marketSell(
        position.tokenId,
        position.size,
        position.market
      );

      if (order.status === 'failed') {
        // Check if failure is due to market resolution (tokens already redeemed)
        if (order.failureReason === 'no_balance_tokens_resolved' ||
            order.failureReason === 'market_closed') {
          logger.info('Position resolved by market - tokens already redeemed', {
            asset: position.signal.asset,
            side: position.side,
            conditionId: position.market.conditionId.substring(0, 16),
          });

          // Mark as resolved and remove from tracking
          position.exitTimestamp = Date.now();
          position.exitReason = 'market_resolved';
          position.status = 'closed';
          position.realizedPnl = 0; // Unknown until balance update

          this.state.positions.delete(position.market.conditionId);
          this.emit('positionClosed', position);
          // Record position closed to test session
          if (this.testSession) {
            this.testSession.recordPositionClosed(position);
          }
          return;
        }

        // No liquidity near expiry - stop retrying, let market resolve naturally
        if (order.failureReason === 'no_liquidity') {
          logger.info('No liquidity to sell - will let market resolve', {
            asset: position.signal.asset,
            side: position.side,
            size: position.size.toFixed(2),
          });
          position.status = 'open'; // Keep open but stop retrying
          return;
        }

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

      // Track this position as recently closed to prevent orphan re-add spam
      this.recentlyClosedPositions.set(position.market.conditionId, Date.now());

      // Clean up old entries from recentlyClosedPositions (older than 2x cooldown)
      const cleanupThreshold = Date.now() - (this.POSITION_COOLDOWN_MS * 2);
      for (const [cid, closedTime] of this.recentlyClosedPositions) {
        if (closedTime < cleanupThreshold) {
          this.recentlyClosedPositions.delete(cid);
        }
      }

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

      // Record position closed to test session
      if (this.testSession) {
        this.testSession.recordPositionClosed(position);
      }

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
    // Skip recording orphaned positions - they pollute stats with fake signal values
    if (position.isOrphaned) {
      logger.info('Skipping trade record for orphaned position', {
        asset: position.signal.asset,
        side: position.side,
        pnl: position.realizedPnl?.toFixed(2),
      });
      return;
    }

    const holdTimeMinutes = (position.exitTimestamp! - position.entryTimestamp) / (60 * 1000);

    // Calculate execution metrics
    const orderLatencyMs = position.signalTimestamp
      ? position.entryTimestamp - position.signalTimestamp
      : undefined;

    const slippage = position.signal.entryPrice > 0
      ? (position.entryPrice - position.signal.entryPrice) / position.signal.entryPrice
      : undefined;

    // Get market spread at entry if available
    const marketData = this.marketPrices.get(position.market.conditionId);
    const marketSpreadAtEntry = marketData
      ? (position.side === 'UP'
          ? marketData.bestAskUp - marketData.bestBidUp
          : marketData.bestAskDown - marketData.bestBidDown)
      : undefined;

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
      // Debug fields
      isOrphaned: position.isOrphaned || false,
      orderLatencyMs,
      slippage,
      expectedPrice: position.signal.entryPrice,
      marketSpreadAtEntry,
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
   * Get move progress for all assets (for dashboard progress bars)
   */
  public getMoveProgressAll(): Array<{
    asset: CryptoAsset;
    currentMovePercent: number;
    direction: 'up' | 'down' | 'flat';
    progress: number;
    durationSeconds: number;
    startPrice: number;
    currentPrice: number;
    threshold: number;
  }> {
    const result: Array<{
      asset: CryptoAsset;
      currentMovePercent: number;
      direction: 'up' | 'down' | 'flat';
      progress: number;
      durationSeconds: number;
      startPrice: number;
      currentPrice: number;
      threshold: number;
    }> = [];

    for (const [asset, priceData] of this.cryptoPrices) {
      const progress = getMoveProgress(
        priceData.priceHistory,
        asset,
        this.config.moveThreshold,
        60 // 60 second window
      );

      if (progress) {
        result.push({
          ...progress,
          threshold: this.config.moveThreshold,
        });
      } else {
        // Return zero progress if no data
        result.push({
          asset,
          currentMovePercent: 0,
          direction: 'flat',
          progress: 0,
          durationSeconds: 0,
          startPrice: priceData.price,
          currentPrice: priceData.price,
          threshold: this.config.moveThreshold,
        });
      }
    }

    return result;
  }

  /**
   * Get on-chain data directly from blockchain
   * Fetches real balance and positions from Polymarket Data API
   */
  public async getOnChainData(): Promise<{
    balance: number;
    positions: Array<{
      tokenId: string;
      size: number;
      avgEntryPrice: number;
      currentValue: number;
    }>;
    timestamp: number;
    source: 'onchain';
  }> {
    try {
      // Fetch on-chain balance
      const balance = await this.clobClient.getBalance();

      // Fetch on-chain positions from Data API
      const rawPositions = await this.clobClient.getPositions();

      // Transform positions
      const positions = rawPositions.map(p => ({
        tokenId: p.asset_id,
        size: parseFloat(p.size),
        avgEntryPrice: parseFloat(p.avg_entry_price),
        currentValue: parseFloat(p.size) * parseFloat(p.avg_entry_price),
      }));

      return {
        balance,
        positions,
        timestamp: Date.now(),
        source: 'onchain',
      };
    } catch (error) {
      logger.error('Failed to fetch on-chain data', { error: (error as Error).message });
      throw error;
    }
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

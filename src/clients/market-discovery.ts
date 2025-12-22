/**
 * Market Discovery Client
 * Fetches and filters active 15-minute crypto prediction markets using Polymarket REST APIs
 *
 * API Documentation: https://docs.polymarket.com
 *
 * The 15-minute crypto markets are organized into series:
 * - btc-up-or-down-15m: Bitcoin Up or Down
 * - eth-up-or-down-15m: Ethereum Up or Down
 * - sol-up-or-down-15m: Solana Up or Down
 * - xrp-up-or-down-15m: XRP Up or Down
 *
 * Each series has events that are created every 15 minutes.
 * Events have slug format: btc-updown-15m-{unix_timestamp}
 */

import axios, { AxiosInstance } from 'axios';
import { CronJob } from 'cron';
import type { CryptoMarket, CryptoAsset, Token } from '../types/index.js';
import logger, { logMarket } from '../utils/logger.js';
import { retryWithBackoff } from '../utils/helpers.js';

// ===========================================
// API Response Types
// ===========================================

// Series response from Gamma API
interface GammaSeries {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  seriesType: string;
  recurrence: string;
  active: boolean;
  closed: boolean;
  events?: GammaEvent[];
}

// Event response from Gamma API (for 15m markets)
interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description: string;
  endDate: string;
  startTime?: string;
  active: boolean;
  closed: boolean;
  liquidity: number;
  markets: GammaEventMarket[];
}

// Market within an event
interface GammaEventMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  endDate: string;
  outcomes: string; // JSON string like "[\"Up\", \"Down\"]"
  outcomePrices: string; // JSON string like "[\"0.56\", \"0.44\"]"
  clobTokenIds: string; // JSON string with token IDs
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
}

// ===========================================
// Crypto Market Detection
// ===========================================

// 15-minute crypto market series slugs
const CRYPTO_SERIES = {
  BTC: 'btc-up-or-down-15m',
  ETH: 'eth-up-or-down-15m',
  SOL: 'sol-up-or-down-15m',
  XRP: 'xrp-up-or-down-15m',
} as const;

// ===========================================
// Market Discovery Client
// ===========================================

export class MarketDiscoveryClient {
  private clobClient: AxiosInstance;
  private gammaClient: AxiosInstance;
  private activeMarkets: Map<string, CryptoMarket> = new Map();
  private refreshJob: CronJob | null = null;
  private onMarketsUpdate: ((markets: CryptoMarket[]) => void) | null = null;

  // API endpoints
  private static readonly CLOB_API = 'https://clob.polymarket.com';
  private static readonly GAMMA_API = 'https://gamma-api.polymarket.com';

  constructor(host: string) {
    // CLOB API client
    this.clobClient = axios.create({
      baseURL: host || MarketDiscoveryClient.CLOB_API,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Gamma API client (crypto-focused)
    this.gammaClient = axios.create({
      baseURL: MarketDiscoveryClient.GAMMA_API,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    logger.info('Market discovery initialized', {
      clobApi: host || MarketDiscoveryClient.CLOB_API,
      gammaApi: MarketDiscoveryClient.GAMMA_API,
    });
  }

  /**
   * Start market discovery with periodic refresh
   */
  public async start(onUpdate?: (markets: CryptoMarket[]) => void): Promise<void> {
    this.onMarketsUpdate = onUpdate || null;

    // Initial fetch
    await this.refreshMarkets();

    // Refresh every 2 minutes (more frequent for 15-min markets)
    this.refreshJob = new CronJob('*/2 * * * *', async () => {
      await this.refreshMarkets();
    });

    this.refreshJob.start();
    logger.info('Market discovery started - refreshing every 2 minutes');
  }

  /**
   * Stop market discovery
   */
  public stop(): void {
    if (this.refreshJob) {
      this.refreshJob.stop();
      this.refreshJob = null;
    }
    logger.info('Market discovery stopped');
  }

  /**
   * Refresh active markets from all API sources
   */
  public async refreshMarkets(): Promise<void> {
    try {
      logger.debug('Refreshing markets from APIs...');

      // Primary source: fetch from 15m series (most reliable)
      const seriesMarkets = await this.fetchFrom15mSeries();

      // Collect all markets
      const allMarkets: CryptoMarket[] = [...seriesMarkets];

      // Deduplicate by conditionId
      const uniqueMarkets = this.deduplicateMarkets(allMarkets);

      // Filter for tradeable markets
      const tradeableMarkets = uniqueMarkets.filter(m => this.isMarketTradeable(m));

      // Fetch LIVE prices from CLOB API (Gamma API prices are stale!)
      logger.info('Fetching live prices from CLOB API...');
      const marketsWithLivePrices = await Promise.all(
        tradeableMarkets.map(market => this.refreshMarketPrices(market))
      );

      // Update active markets map
      const previousCount = this.activeMarkets.size;
      this.activeMarkets.clear();

      for (const market of marketsWithLivePrices) {
        this.activeMarkets.set(market.conditionId, market);
      }

      logger.info('Markets refreshed with live prices', {
        sources: 'Gamma Series + CLOB Midpoint API',
        total: allMarkets.length,
        unique: uniqueMarkets.length,
        tradeable: marketsWithLivePrices.length,
        previousCount,
      });

      // Notify callback
      if (this.onMarketsUpdate && marketsWithLivePrices.length > 0) {
        this.onMarketsUpdate(marketsWithLivePrices);
      }

    } catch (error) {
      logger.error('Failed to refresh markets', { error: (error as Error).message });
    }
  }

  /**
   * Fetch active 15-minute markets from all crypto series
   */
  private async fetchFrom15mSeries(): Promise<CryptoMarket[]> {
    const markets: CryptoMarket[] = [];
    const assets = Object.keys(CRYPTO_SERIES) as CryptoAsset[];

    // Fetch all series in parallel
    const results = await Promise.allSettled(
      assets.map(asset => this.fetchSeriesMarkets(asset, CRYPTO_SERIES[asset]))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        markets.push(...result.value);
      }
    }

    return markets;
  }

  /**
   * Fetch active markets from a specific series
   */
  private async fetchSeriesMarkets(asset: CryptoAsset, seriesSlug: string): Promise<CryptoMarket[]> {
    const markets: CryptoMarket[] = [];

    try {
      // Query the series endpoint directly to get recent events
      const response = await retryWithBackoff(async () => {
        return this.gammaClient.get(`/series`, {
          params: {
            slug: seriesSlug,
          },
        });
      }, { maxRetries: 2 });

      const seriesData: GammaSeries[] = response.data || [];
      if (seriesData.length === 0) {
        logger.debug(`No series found for ${seriesSlug}`);
        return markets;
      }

      const series = seriesData[0];
      const events = series.events || [];

      logger.debug(`Series ${seriesSlug} has ${events.length} events`);

      // Find active, non-closed events within our trading window
      for (const event of events) {
        if (event.closed) continue;

        // EARLY FILTER: Check event endDate before making API call
        const eventEndDate = new Date(event.endDate);
        const now = Date.now();
        const timeToExpiry = eventEndDate.getTime() - now;

        // Skip events outside 2-20 minute window
        if (timeToExpiry < 2 * 60 * 1000 || timeToExpiry > 20 * 60 * 1000) {
          continue;
        }

        // Also try to fetch the event directly to get full market data
        try {
          const eventResponse = await this.gammaClient.get('/events', {
            params: { slug: event.slug },
          });

          const fullEvents: GammaEvent[] = eventResponse.data || [];
          if (fullEvents.length === 0) continue;

          const fullEvent = fullEvents[0];
          if (!fullEvent.markets || fullEvent.markets.length === 0) continue;

          for (const market of fullEvent.markets) {
            const cryptoMarket = this.parseEventMarket(market, fullEvent, asset);
            if (cryptoMarket) {
              markets.push(cryptoMarket);
              // Get UP/DOWN prices for logging
              const upToken = cryptoMarket.tokens?.find(t => t.outcome.toLowerCase() === 'up');
              const downToken = cryptoMarket.tokens?.find(t => t.outcome.toLowerCase() === 'down');
              logger.info('Found active 15m market', {
                asset,
                question: market.question.substring(0, 45),
                upPrice: upToken ? (upToken.price * 100).toFixed(1) + '%' : '?',
                downPrice: downToken ? (downToken.price * 100).toFixed(1) + '%' : '?',
                expiresIn: Math.round((new Date(market.endDate).getTime() - Date.now()) / 60000) + 'm',
              });
            }
          }
        } catch (e) {
          logger.debug(`Failed to fetch event ${event.slug}`, { error: (e as Error).message });
        }
      }

    } catch (error) {
      logger.debug(`Failed to fetch ${asset} series markets`, { error: (error as Error).message });
    }

    return markets;
  }

  /**
   * Parse an event market to CryptoMarket
   */
  private parseEventMarket(market: GammaEventMarket, event: GammaEvent, asset: CryptoAsset): CryptoMarket | null {
    if (!market.active || market.closed || !market.acceptingOrders) {
      return null;
    }

    // Parse JSON string fields
    let outcomes: string[] = [];
    let prices: string[] = [];
    let tokenIds: string[] = [];

    try {
      outcomes = JSON.parse(market.outcomes || '[]');
      prices = JSON.parse(market.outcomePrices || '[]');
      tokenIds = JSON.parse(market.clobTokenIds || '[]');

      // Log parsed data for debugging - use info level to diagnose 50/50 issue
      logger.info('Market prices from API', {
        asset,
        question: market.question.substring(0, 40),
        rawOutcomePrices: market.outcomePrices,
        parsedPrices: prices,
        outcomes,
      });
    } catch (e) {
      logger.debug('Failed to parse market JSON fields', { error: (e as Error).message });
      return null;
    }

    // Build tokens array
    const tokens: Token[] = outcomes.map((outcome, idx) => ({
      tokenId: tokenIds[idx] || '',
      outcome,
      winner: false,
      price: parseFloat(prices[idx] || '0.5'),
    }));

    // Find Up and Down token IDs
    let upTokenId = '';
    let downTokenId = '';

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i].toLowerCase();
      if (outcome === 'up') {
        upTokenId = tokenIds[i] || '';
      } else if (outcome === 'down') {
        downTokenId = tokenIds[i] || '';
      }
    }

    if (!upTokenId || !downTokenId) {
      logger.debug('Could not find Up/Down tokens', { outcomes });
      return null;
    }

    // Parse expiry time
    const expiryTime = new Date(market.endDate);
    if (!this.isValidExpiry(expiryTime)) {
      return null;
    }

    return {
      conditionId: market.conditionId,
      questionId: market.id,
      tokens,
      minIncentiveSize: '5',
      maxIncentiveSize: '0',
      active: market.active,
      closed: market.closed,
      makerBase: 0,
      takerBase: 0,
      description: event.description || market.question,
      endDate: market.endDate,
      question: market.question,
      marketSlug: market.slug,
      fpmm: '',
      category: 'crypto',
      enableOrderBook: market.enableOrderBook,
      asset,
      direction: 'UP',
      expiryTime,
      upTokenId,
      downTokenId,
    };
  }

  /**
   * Check if expiry time is valid for trading
   * Only want the next 1-2 markets (expiring in 2-20 minutes)
   */
  private isValidExpiry(expiryTime: Date): boolean {
    const now = Date.now();
    const timeToExpiry = expiryTime.getTime() - now;

    // Must expire in 2-20 minutes (need at least 2 min to trade, max 20 min window)
    return timeToExpiry >= 2 * 60 * 1000 && timeToExpiry <= 20 * 60 * 1000;
  }

  /**
   * Check if market is tradeable
   */
  private isMarketTradeable(market: CryptoMarket): boolean {
    const now = Date.now();
    const expiryBuffer = 60 * 1000; // 1 minute buffer

    return (
      market.active &&
      !market.closed &&
      market.enableOrderBook &&
      market.expiryTime.getTime() - now > expiryBuffer &&
      market.upTokenId !== '' &&
      market.downTokenId !== ''
    );
  }

  /**
   * Deduplicate markets by conditionId
   */
  private deduplicateMarkets(markets: CryptoMarket[]): CryptoMarket[] {
    const seen = new Map<string, CryptoMarket>();

    for (const market of markets) {
      const existing = seen.get(market.conditionId);
      if (!existing) {
        seen.set(market.conditionId, market);
      }
    }

    return Array.from(seen.values());
  }

  // ===========================================
  // Public Getters
  // ===========================================

  public getActiveMarkets(): CryptoMarket[] {
    // Filter out expired markets
    const active: CryptoMarket[] = [];

    for (const [conditionId, market] of this.activeMarkets) {
      if (this.isMarketTradeable(market)) {
        active.push(market);
      } else {
        this.activeMarkets.delete(conditionId);
        logMarket('expired', `${market.asset}`, market.question.substring(0, 30));
      }
    }

    return active;
  }

  public getMarketsForAsset(asset: CryptoAsset): CryptoMarket[] {
    return this.getActiveMarkets().filter(m => m.asset === asset);
  }

  public getMarket(conditionId: string): CryptoMarket | undefined {
    const market = this.activeMarkets.get(conditionId);
    if (market && this.isMarketTradeable(market)) {
      return market;
    }
    return undefined;
  }

  public getMarketCountByAsset(): Record<CryptoAsset, number> {
    const counts: Record<CryptoAsset, number> = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };
    for (const market of this.getActiveMarkets()) {
      counts[market.asset]++;
    }
    return counts;
  }

  /**
   * Get historical prices for a market token (for backtesting)
   */
  public async getHistoricalPrices(
    tokenId: string,
    startTime?: number,
    endTime?: number
  ): Promise<Array<{ timestamp: number; price: number }>> {
    try {
      const params: Record<string, unknown> = { asset_id: tokenId };
      if (startTime) params.start_ts = Math.floor(startTime / 1000);
      if (endTime) params.end_ts = Math.floor(endTime / 1000);

      const response = await this.clobClient.get('/prices-history', { params });

      return (response.data.history || []).map((p: { t: number; p: string }) => ({
        timestamp: p.t * 1000,
        price: parseFloat(p.p),
      }));
    } catch (error) {
      logger.error('Failed to get historical prices', { tokenId, error: (error as Error).message });
      return [];
    }
  }

  /**
   * Fetch LIVE prices from CLOB API /midpoint endpoint
   * This returns the current mid-price (average of best bid/ask)
   * Much more accurate than Gamma API's stale outcomePrices
   */
  public async getLivePrices(upTokenId: string, downTokenId: string): Promise<{ upPrice: number; downPrice: number } | null> {
    try {
      // Fetch midpoints for both UP and DOWN tokens in parallel
      const [upResponse, downResponse] = await Promise.all([
        this.clobClient.get('/midpoint', { params: { token_id: upTokenId } }),
        this.clobClient.get('/midpoint', { params: { token_id: downTokenId } }),
      ]);

      const upPrice = parseFloat(upResponse.data?.mid || '0.5');
      const downPrice = parseFloat(downResponse.data?.mid || '0.5');

      logger.debug('Live prices fetched from CLOB API', {
        upPrice: (upPrice * 100).toFixed(1) + '%',
        downPrice: (downPrice * 100).toFixed(1) + '%',
      });

      return { upPrice, downPrice };
    } catch (error) {
      logger.warn('Failed to fetch live prices from CLOB API', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * Fetch live prices for a market and update its token prices
   */
  public async refreshMarketPrices(market: CryptoMarket): Promise<CryptoMarket> {
    const livePrices = await this.getLivePrices(market.upTokenId, market.downTokenId);

    if (livePrices) {
      // Update token prices with live data
      for (const token of market.tokens) {
        if (token.tokenId === market.upTokenId) {
          token.price = livePrices.upPrice;
        } else if (token.tokenId === market.downTokenId) {
          token.price = livePrices.downPrice;
        }
      }

      logger.info('Market prices updated with live data', {
        asset: market.asset,
        upPrice: (livePrices.upPrice * 100).toFixed(1) + '%',
        downPrice: (livePrices.downPrice * 100).toFixed(1) + '%',
      });
    }

    return market;
  }
}

export default MarketDiscoveryClient;

/**
 * Market Discovery Client
 * Fetches and filters active 15-minute crypto prediction markets using Polymarket REST APIs
 *
 * API Documentation: https://docs.polymarket.com
 *
 * This client uses multiple API endpoints:
 * - CLOB API: GET /markets - List all markets with filtering
 * - Gamma API: GET /markets - Crypto-specific markets with tags
 * - Strapi API: GET /markets - Event-based market data
 *
 * Filtering Strategy:
 * 1. Query APIs with active=true, closed=false filters
 * 2. Filter by tags: "crypto", "bitcoin", "ethereum", etc.
 * 3. Filter by end_date_min/max for 15-minute windows
 * 4. Parse market structure to identify up/down binary markets
 */

import axios, { AxiosInstance } from 'axios';
import { CronJob } from 'cron';
import type { Market, CryptoMarket, CryptoAsset, Token } from '../types/index.js';
import logger, { logMarket } from '../utils/logger.js';
import { retryWithBackoff, generateId } from '../utils/helpers.js';

// ===========================================
// API Response Types
// ===========================================

interface ClobMarketResponse {
  // Array of markets or wrapped in data
  data?: Market[];
  markets?: Market[];
  next_cursor?: string;
}

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  questionId: string;
  slug: string;
  resolutionSource: string;
  endDate: string;
  startDate: string;
  liquidity: string;
  volume: string;
  volume24hr: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  active: boolean;
  closed: boolean;
  archived: boolean;
  new: boolean;
  featured: boolean;
  restricted: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  minimum_order_size: string;
  minimum_tick_size: string;
  tags?: string[];
  image?: string;
  icon?: string;
  description?: string;
}

interface StrapiEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  markets: StrapiMarket[];
  tags: Array<{ id: string; slug: string; label: string }>;
}

interface StrapiMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  acceptingOrders: boolean;
  active: boolean;
  closed: boolean;
}

// ===========================================
// Crypto Market Detection
// ===========================================

// Keywords that indicate a 15-minute crypto binary market
const CRYPTO_KEYWORDS = {
  assets: {
    BTC: ['btc', 'bitcoin'],
    ETH: ['eth', 'ethereum'],
    SOL: ['sol', 'solana'],
    XRP: ['xrp', 'ripple'],
  },
  timeframes: ['15 min', '15min', '15-min', '15m', '15 minute', 'fifteen minute'],
  directions: {
    up: ['up', 'higher', 'above', 'rise', 'increase', 'yes'],
    down: ['down', 'lower', 'below', 'fall', 'decrease', 'no'],
  },
  tags: ['crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'solana', 'xrp', 'price', 'minutely', '15min'],
};

// ===========================================
// Market Discovery Client
// ===========================================

export class MarketDiscoveryClient {
  private clobClient: AxiosInstance;
  private gammaClient: AxiosInstance;
  private strapiClient: AxiosInstance;
  private activeMarkets: Map<string, CryptoMarket> = new Map();
  private refreshJob: CronJob | null = null;
  private onMarketsUpdate: ((markets: CryptoMarket[]) => void) | null = null;

  // API endpoints
  private static readonly CLOB_API = 'https://clob.polymarket.com';
  private static readonly GAMMA_API = 'https://gamma-api.polymarket.com';
  private static readonly STRAPI_API = 'https://strapi-matic.poly.market';

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

    // Strapi API client (event-based)
    this.strapiClient = axios.create({
      baseURL: MarketDiscoveryClient.STRAPI_API,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    logger.info('Market discovery initialized', {
      clobApi: host || MarketDiscoveryClient.CLOB_API,
      gammaApi: MarketDiscoveryClient.GAMMA_API,
      strapiApi: MarketDiscoveryClient.STRAPI_API,
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

      // Fetch from all sources in parallel
      const results = await Promise.allSettled([
        this.fetchFromClobApi(),
        this.fetchFromGammaApi(),
        this.fetchFromStrapiApi(),
      ]);

      // Collect all markets
      const allMarkets: CryptoMarket[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          allMarkets.push(...result.value);
        }
      }

      // Deduplicate by conditionId
      const uniqueMarkets = this.deduplicateMarkets(allMarkets);

      // Filter for tradeable markets
      const tradeableMarkets = uniqueMarkets.filter(m => this.isMarketTradeable(m));

      // Update active markets map
      const previousCount = this.activeMarkets.size;
      this.activeMarkets.clear();

      for (const market of tradeableMarkets) {
        this.activeMarkets.set(market.conditionId, market);
      }

      logger.info('Markets refreshed', {
        sources: 'CLOB + Gamma + Strapi APIs',
        total: allMarkets.length,
        unique: uniqueMarkets.length,
        tradeable: tradeableMarkets.length,
        previousCount,
      });

      // Notify callback
      if (this.onMarketsUpdate && tradeableMarkets.length > 0) {
        this.onMarketsUpdate(tradeableMarkets);
      }

    } catch (error) {
      logger.error('Failed to refresh markets', { error: (error as Error).message });
    }
  }

  /**
   * Fetch markets from CLOB API with filtering
   */
  private async fetchFromClobApi(): Promise<CryptoMarket[]> {
    const markets: CryptoMarket[] = [];

    try {
      // Calculate time window: markets expiring in next 5-20 minutes
      const now = new Date();
      const minExpiry = new Date(now.getTime() + 5 * 60 * 1000);
      const maxExpiry = new Date(now.getTime() + 20 * 60 * 1000);

      // Fetch with filters
      const response = await retryWithBackoff(async () => {
        return this.clobClient.get('/markets', {
          params: {
            active: true,
            closed: false,
            // Some CLOB endpoints support these filters
            end_date_min: minExpiry.toISOString(),
            end_date_max: maxExpiry.toISOString(),
            limit: 100,
          },
        });
      }, { maxRetries: 2 });

      const data = response.data;
      const rawMarkets: Market[] = data.data || data.markets || (Array.isArray(data) ? data : []);

      for (const market of rawMarkets) {
        const cryptoMarket = this.parseToCryptoMarket(market);
        if (cryptoMarket) {
          markets.push(cryptoMarket);
          logMarket('discovered', `${cryptoMarket.asset} via CLOB API`, cryptoMarket.question.substring(0, 50));
        }
      }

    } catch (error) {
      logger.debug('CLOB API fetch failed', { error: (error as Error).message });
    }

    return markets;
  }

  /**
   * Fetch markets from Gamma API (crypto-focused)
   */
  private async fetchFromGammaApi(): Promise<CryptoMarket[]> {
    const markets: CryptoMarket[] = [];

    try {
      // Gamma API supports tag-based filtering
      const response = await retryWithBackoff(async () => {
        return this.gammaClient.get('/markets', {
          params: {
            active: true,
            closed: false,
            archived: false,
            limit: 200,
            // Filter by crypto tags
            tag: 'crypto',
            order: 'endDate',
            ascending: true,
          },
        });
      }, { maxRetries: 2 });

      const gammaMarkets: GammaMarket[] = response.data || [];

      for (const gm of gammaMarkets) {
        const cryptoMarket = this.parseGammaMarket(gm);
        if (cryptoMarket) {
          markets.push(cryptoMarket);
          logMarket('discovered', `${cryptoMarket.asset} via Gamma API`, cryptoMarket.question.substring(0, 50));
        }
      }

    } catch (error) {
      logger.debug('Gamma API fetch failed', { error: (error as Error).message });
    }

    return markets;
  }

  /**
   * Fetch markets from Strapi API (event-based)
   */
  private async fetchFromStrapiApi(): Promise<CryptoMarket[]> {
    const markets: CryptoMarket[] = [];

    try {
      // Search for crypto-related events
      const response = await retryWithBackoff(async () => {
        return this.strapiClient.get('/events', {
          params: {
            active: true,
            closed: false,
            _limit: 100,
            // Filter by tag slugs
            'tags.slug_in': ['crypto', 'bitcoin', 'ethereum', 'cryptocurrency'],
          },
        });
      }, { maxRetries: 2 });

      const events: StrapiEvent[] = response.data || [];

      for (const event of events) {
        // Check if event has crypto tags
        const hasCryptoTag = event.tags?.some(t =>
          CRYPTO_KEYWORDS.tags.includes(t.slug?.toLowerCase())
        );

        if (!hasCryptoTag && !this.textMatchesCrypto(event.title + ' ' + event.description)) {
          continue;
        }

        // Parse each market in the event
        for (const sm of event.markets || []) {
          const cryptoMarket = this.parseStrapiMarket(sm, event);
          if (cryptoMarket) {
            markets.push(cryptoMarket);
            logMarket('discovered', `${cryptoMarket.asset} via Strapi API`, cryptoMarket.question.substring(0, 50));
          }
        }
      }

    } catch (error) {
      logger.debug('Strapi API fetch failed', { error: (error as Error).message });
    }

    return markets;
  }

  /**
   * Parse a CLOB market response to CryptoMarket
   */
  private parseToCryptoMarket(market: Market): CryptoMarket | null {
    // Must be active with order book
    if (!market.active || market.closed || !market.enableOrderBook) {
      return null;
    }

    // Check for crypto asset and timeframe
    const text = `${market.description || ''} ${market.question || ''} ${market.marketSlug || ''}`.toLowerCase();

    const asset = this.detectAsset(text);
    if (!asset) return null;

    const has15Min = this.hasTimeframe(text);
    if (!has15Min) return null;

    // Parse tokens for up/down
    const { upTokenId, downTokenId } = this.parseTokens(market.tokens, text);
    if (!upTokenId || !downTokenId) return null;

    // Parse expiry
    const expiryTime = new Date(market.endDate);
    if (!this.isValidExpiry(expiryTime)) return null;

    return {
      ...market,
      asset,
      direction: 'UP', // Will be determined by signal
      expiryTime,
      upTokenId,
      downTokenId,
    };
  }

  /**
   * Parse a Gamma API market to CryptoMarket
   */
  private parseGammaMarket(gm: GammaMarket): CryptoMarket | null {
    // Must be active
    if (!gm.active || gm.closed || gm.archived || !gm.acceptingOrders) {
      return null;
    }

    // Check for crypto asset
    const text = `${gm.question || ''} ${gm.description || ''} ${gm.slug || ''} ${(gm.tags || []).join(' ')}`.toLowerCase();

    const asset = this.detectAsset(text);
    if (!asset) return null;

    const has15Min = this.hasTimeframe(text);
    if (!has15Min) return null;

    // Parse tokens
    const tokens: Token[] = (gm.outcomes || []).map((outcome, idx) => ({
      tokenId: gm.clobTokenIds?.[idx] || '',
      outcome,
      winner: false,
      price: parseFloat(gm.outcomePrices?.[idx] || '0.5'),
    }));

    const { upTokenId, downTokenId } = this.parseTokens(tokens, text);
    if (!upTokenId || !downTokenId) return null;

    // Parse expiry
    const expiryTime = new Date(gm.endDate);
    if (!this.isValidExpiry(expiryTime)) return null;

    return {
      conditionId: gm.conditionId,
      questionId: gm.questionId || gm.id,
      tokens,
      minIncentiveSize: gm.minimum_order_size || '0',
      maxIncentiveSize: '0',
      active: gm.active,
      closed: gm.closed,
      makerBase: 0,
      takerBase: 0,
      description: gm.description || gm.question,
      endDate: gm.endDate,
      question: gm.question,
      marketSlug: gm.slug,
      fpmm: '',
      category: 'crypto',
      enableOrderBook: gm.enableOrderBook,
      asset,
      direction: 'UP',
      expiryTime,
      upTokenId,
      downTokenId,
    };
  }

  /**
   * Parse a Strapi market to CryptoMarket
   */
  private parseStrapiMarket(sm: StrapiMarket, event: StrapiEvent): CryptoMarket | null {
    if (!sm.active || sm.closed || !sm.acceptingOrders) {
      return null;
    }

    const text = `${sm.question || ''} ${event.title || ''} ${event.description || ''}`.toLowerCase();

    const asset = this.detectAsset(text);
    if (!asset) return null;

    const has15Min = this.hasTimeframe(text);
    if (!has15Min) return null;

    // Parse tokens from JSON strings
    let outcomes: string[] = [];
    let prices: string[] = [];
    let tokenIds: string[] = [];

    try {
      outcomes = JSON.parse(sm.outcomes || '[]');
      prices = JSON.parse(sm.outcomePrices || '[]');
      tokenIds = JSON.parse(sm.clobTokenIds || '[]');
    } catch {
      return null;
    }

    const tokens: Token[] = outcomes.map((outcome, idx) => ({
      tokenId: tokenIds[idx] || '',
      outcome,
      winner: false,
      price: parseFloat(prices[idx] || '0.5'),
    }));

    const { upTokenId, downTokenId } = this.parseTokens(tokens, text);
    if (!upTokenId || !downTokenId) return null;

    const expiryTime = new Date(event.endDate);
    if (!this.isValidExpiry(expiryTime)) return null;

    return {
      conditionId: sm.conditionId,
      questionId: sm.id,
      tokens,
      minIncentiveSize: '0',
      maxIncentiveSize: '0',
      active: sm.active,
      closed: sm.closed,
      makerBase: 0,
      takerBase: 0,
      description: event.description,
      endDate: event.endDate,
      question: sm.question,
      marketSlug: sm.slug,
      fpmm: '',
      category: 'crypto',
      enableOrderBook: true,
      asset,
      direction: 'UP',
      expiryTime,
      upTokenId,
      downTokenId,
    };
  }

  /**
   * Detect crypto asset from text
   */
  private detectAsset(text: string): CryptoAsset | null {
    for (const [asset, keywords] of Object.entries(CRYPTO_KEYWORDS.assets)) {
      if (keywords.some(k => text.includes(k))) {
        return asset as CryptoAsset;
      }
    }
    return null;
  }

  /**
   * Check if text contains 15-minute timeframe indicator
   */
  private hasTimeframe(text: string): boolean {
    return CRYPTO_KEYWORDS.timeframes.some(t => text.includes(t));
  }

  /**
   * Check if text matches any crypto patterns
   */
  private textMatchesCrypto(text: string): boolean {
    const lower = text.toLowerCase();
    return Object.values(CRYPTO_KEYWORDS.assets).flat().some(k => lower.includes(k));
  }

  /**
   * Parse tokens to find up/down token IDs
   */
  private parseTokens(tokens: Token[], marketText: string): { upTokenId: string; downTokenId: string } {
    let upTokenId = '';
    let downTokenId = '';

    for (const token of tokens) {
      const outcome = token.outcome.toLowerCase();

      // Check for "up" indicators
      if (CRYPTO_KEYWORDS.directions.up.some(d => outcome.includes(d))) {
        upTokenId = token.tokenId;
      }
      // Check for "down" indicators
      else if (CRYPTO_KEYWORDS.directions.down.some(d => outcome.includes(d))) {
        downTokenId = token.tokenId;
      }
    }

    // If only 2 tokens and one is "Yes", treat it as binary up/down
    if (tokens.length === 2 && (!upTokenId || !downTokenId)) {
      // Determine from market question if "up" or "down" market
      const isUpMarket = CRYPTO_KEYWORDS.directions.up.some(d => marketText.includes(d));

      for (const token of tokens) {
        const outcome = token.outcome.toLowerCase();
        if (outcome === 'yes') {
          if (isUpMarket) {
            upTokenId = token.tokenId;
          } else {
            downTokenId = token.tokenId;
          }
        } else if (outcome === 'no') {
          if (isUpMarket) {
            downTokenId = token.tokenId;
          } else {
            upTokenId = token.tokenId;
          }
        }
      }
    }

    return { upTokenId, downTokenId };
  }

  /**
   * Check if expiry time is valid (5-20 minutes from now)
   */
  private isValidExpiry(expiryTime: Date): boolean {
    const now = Date.now();
    const timeToExpiry = expiryTime.getTime() - now;

    // Must expire in 5-20 minutes
    return timeToExpiry >= 5 * 60 * 1000 && timeToExpiry <= 20 * 60 * 1000;
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
}

export default MarketDiscoveryClient;

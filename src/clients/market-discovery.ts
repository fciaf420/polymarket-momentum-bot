/**
 * Market Discovery Client
 * Fetches and filters active 15-minute crypto prediction markets using Polymarket REST API
 *
 * API Documentation: https://docs.polymarket.com/#get-markets
 *
 * This client uses the CLOB API to discover markets:
 * - GET /markets - List all markets with pagination
 * - GET /markets/:condition_id - Get specific market details
 * - GET /prices-history - Get historical prices for backtesting
 *
 * For Gamma/crypto markets, we also check:
 * - Polymarket Gamma API for crypto-specific markets
 */

import axios, { AxiosInstance } from 'axios';
import { CronJob } from 'cron';
import type { Market, CryptoMarket, CryptoAsset } from '../types/index.js';
import logger, { logMarket } from '../utils/logger.js';
import { parseCryptoMarket, isMarketTradeable, retryWithBackoff } from '../utils/helpers.js';
import { MARKET_PATTERNS } from '../config.js';

// API response types
interface MarketResponse {
  data: Market[];
  next_cursor?: string;
}

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  resolutionSource: string;
  endDate: string;
  liquidity: string;
  volume: string;
  outcomes: string[];
  outcomePrices: string[];
  clob_token_ids: string[];
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
}

interface GammaMarketsResponse {
  data: GammaMarket[];
  count: number;
}

export class MarketDiscoveryClient {
  private apiClient: AxiosInstance;
  private gammaClient: AxiosInstance;
  private activeMarkets: Map<string, CryptoMarket> = new Map();
  private refreshJob: CronJob | null = null;
  private onMarketsUpdate: ((markets: CryptoMarket[]) => void) | null = null;
  private host: string;

  // Gamma API base URL for crypto-specific markets
  private static readonly GAMMA_API_URL = 'https://gamma-api.polymarket.com';

  constructor(host: string) {
    this.host = host;

    // Main CLOB API client
    this.apiClient = axios.create({
      baseURL: host,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Gamma API client for crypto markets
    this.gammaClient = axios.create({
      baseURL: MarketDiscoveryClient.GAMMA_API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    logger.info('Market discovery client initialized', {
      clobApi: host,
      gammaApi: MarketDiscoveryClient.GAMMA_API_URL,
    });
  }

  /**
   * Start market discovery with periodic refresh
   */
  public async start(onUpdate?: (markets: CryptoMarket[]) => void): Promise<void> {
    this.onMarketsUpdate = onUpdate || null;

    // Initial fetch
    await this.refreshMarkets();

    // Start cron job for periodic refresh (every 5 minutes)
    this.refreshJob = new CronJob('*/5 * * * *', async () => {
      await this.refreshMarkets();
    });

    this.refreshJob.start();
    logger.info('Market discovery started with 5-minute refresh');
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
   * Refresh active markets from both CLOB and Gamma APIs
   */
  public async refreshMarkets(): Promise<void> {
    try {
      logger.debug('Refreshing markets from APIs...');

      // Fetch markets from both sources in parallel
      const [clobMarkets, gammaMarkets] = await Promise.all([
        this.fetchAllMarkets().catch(err => {
          logger.warn('CLOB API fetch failed', { error: err.message });
          return [] as Market[];
        }),
        this.fetchGammaMarkets().catch(err => {
          logger.warn('Gamma API fetch failed', { error: err.message });
          return [] as Market[];
        }),
      ]);

      // Combine markets, preferring Gamma data for crypto markets
      const allMarkets = this.mergeMarkets(clobMarkets, gammaMarkets);

      // Filter for 15-minute crypto markets
      const cryptoMarkets = this.filterCryptoMarkets(allMarkets);

      // Update active markets map
      const previousCount = this.activeMarkets.size;
      this.activeMarkets.clear();

      for (const market of cryptoMarkets) {
        if (isMarketTradeable(market)) {
          this.activeMarkets.set(market.conditionId, market);
        }
      }

      logger.info('Markets refreshed from API', {
        clobTotal: clobMarkets.length,
        gammaTotal: gammaMarkets.length,
        cryptoMarkets: cryptoMarkets.length,
        active: this.activeMarkets.size,
        source: 'REST API',
      });

      // Log new and expired markets
      if (this.activeMarkets.size !== previousCount) {
        logger.info(`Active markets changed: ${previousCount} -> ${this.activeMarkets.size}`);
      }

      // Notify callback
      if (this.onMarketsUpdate) {
        this.onMarketsUpdate(Array.from(this.activeMarkets.values()));
      }

    } catch (error) {
      logger.error('Failed to refresh markets', { error: (error as Error).message });
    }
  }

  /**
   * Fetch crypto markets from Gamma API
   * The Gamma API is specifically designed for crypto price markets
   */
  private async fetchGammaMarkets(): Promise<Market[]> {
    const markets: Market[] = [];

    // Search for crypto-related markets
    const searchTerms = ['BTC', 'ETH', 'SOL', 'XRP', 'Bitcoin', 'Ethereum', 'Solana'];

    for (const term of searchTerms) {
      try {
        const response = await retryWithBackoff<GammaMarketsResponse>(
          async () => {
            const result = await this.gammaClient.get('/markets', {
              params: {
                active: true,
                closed: false,
                limit: 100,
                tag: 'crypto', // Filter by crypto tag if available
              },
            });
            return result.data;
          },
          { maxRetries: 2 }
        );

        if (response.data) {
          for (const gm of response.data) {
            // Convert Gamma market to our Market format
            const market = this.convertGammaMarket(gm);
            if (market && !markets.find(m => m.conditionId === market.conditionId)) {
              markets.push(market);
            }
          }
        }
      } catch (error) {
        logger.debug(`Gamma search for ${term} failed`, { error: (error as Error).message });
      }
    }

    return markets;
  }

  /**
   * Convert Gamma market format to our Market format
   */
  private convertGammaMarket(gm: GammaMarket): Market | null {
    if (!gm.conditionId || !gm.clob_token_ids || gm.clob_token_ids.length < 2) {
      return null;
    }

    return {
      conditionId: gm.conditionId,
      questionId: gm.id,
      tokens: gm.outcomes.map((outcome, idx) => ({
        tokenId: gm.clob_token_ids[idx] || '',
        outcome,
        winner: false,
        price: parseFloat(gm.outcomePrices?.[idx] || '0.5'),
      })),
      minIncentiveSize: '0',
      maxIncentiveSize: '0',
      active: gm.active && gm.acceptingOrders,
      closed: gm.closed || gm.archived,
      makerBase: 0,
      takerBase: 0,
      description: gm.question,
      endDate: gm.endDate,
      question: gm.question,
      marketSlug: gm.slug,
      fpmm: '',
      category: 'crypto',
      enableOrderBook: gm.enableOrderBook,
    };
  }

  /**
   * Merge markets from CLOB and Gamma APIs
   */
  private mergeMarkets(clobMarkets: Market[], gammaMarkets: Market[]): Market[] {
    const merged = new Map<string, Market>();

    // Add CLOB markets first
    for (const market of clobMarkets) {
      merged.set(market.conditionId, market);
    }

    // Overlay Gamma markets (may have better/more recent data)
    for (const market of gammaMarkets) {
      if (!merged.has(market.conditionId)) {
        merged.set(market.conditionId, market);
      }
    }

    return Array.from(merged.values());
  }

  /**
   * Fetch all markets from the API with pagination
   */
  private async fetchAllMarkets(): Promise<Market[]> {
    const allMarkets: Market[] = [];
    let cursor: string | undefined;

    do {
      const response = await retryWithBackoff<MarketResponse>(
        async () => {
          const params: Record<string, string> = {};
          if (cursor) {
            params.next_cursor = cursor;
          }

          const result = await this.apiClient.get<MarketResponse>('/markets', { params });
          return result.data;
        },
        { maxRetries: 3 }
      );

      allMarkets.push(...response.data);
      cursor = response.next_cursor;

    } while (cursor);

    return allMarkets;
  }

  /**
   * Filter markets for 15-minute crypto up/down markets
   */
  private filterCryptoMarkets(markets: Market[]): CryptoMarket[] {
    const cryptoMarkets: CryptoMarket[] = [];

    for (const market of markets) {
      // Skip closed or inactive markets
      if (market.closed || !market.active) {
        continue;
      }

      // Skip markets without order book
      if (!market.enableOrderBook) {
        continue;
      }

      // Try to parse as crypto market
      const cryptoMarket = parseCryptoMarket(market);
      if (cryptoMarket) {
        // Check if market expires within 15-20 minutes
        const now = Date.now();
        const expiryTime = cryptoMarket.expiryTime.getTime();
        const timeToExpiry = expiryTime - now;

        // Only include markets that expire in 5-20 minutes
        // (need time to enter and exit)
        if (timeToExpiry >= 5 * 60 * 1000 && timeToExpiry <= 20 * 60 * 1000) {
          cryptoMarkets.push(cryptoMarket);
          logMarket('discovered', `${cryptoMarket.asset} 15m`, `expires in ${Math.floor(timeToExpiry / 60000)}m`);
        }
      }
    }

    return cryptoMarkets;
  }

  /**
   * Get all active markets
   */
  public getActiveMarkets(): CryptoMarket[] {
    // Filter out expired markets
    const now = Date.now();
    const active: CryptoMarket[] = [];

    for (const [conditionId, market] of this.activeMarkets) {
      if (isMarketTradeable(market)) {
        active.push(market);
      } else {
        this.activeMarkets.delete(conditionId);
        logMarket('expired', `${market.asset} 15m`);
      }
    }

    return active;
  }

  /**
   * Get markets for a specific asset
   */
  public getMarketsForAsset(asset: CryptoAsset): CryptoMarket[] {
    return this.getActiveMarkets().filter(m => m.asset === asset);
  }

  /**
   * Get a specific market by condition ID
   */
  public getMarket(conditionId: string): CryptoMarket | undefined {
    const market = this.activeMarkets.get(conditionId);
    if (market && isMarketTradeable(market)) {
      return market;
    }
    return undefined;
  }

  /**
   * Search for markets by keyword
   */
  public searchMarkets(keyword: string): CryptoMarket[] {
    const lowerKeyword = keyword.toLowerCase();
    return this.getActiveMarkets().filter(m => {
      const searchText = `${m.description} ${m.question} ${m.marketSlug}`.toLowerCase();
      return searchText.includes(lowerKeyword);
    });
  }

  /**
   * Get historical prices for a market token
   */
  public async getHistoricalPrices(
    tokenId: string,
    startTime?: number,
    endTime?: number
  ): Promise<Array<{ timestamp: number; price: number }>> {
    try {
      const params: Record<string, unknown> = {
        asset_id: tokenId,
      };

      if (startTime) {
        params.start_ts = Math.floor(startTime / 1000);
      }
      if (endTime) {
        params.end_ts = Math.floor(endTime / 1000);
      }

      const response = await this.apiClient.get('/prices-history', { params });

      return (response.data.history || []).map((p: { t: number; p: string }) => ({
        timestamp: p.t * 1000,
        price: parseFloat(p.p),
      }));

    } catch (error) {
      logger.error('Failed to get historical prices', {
        tokenId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Get market info with current prices
   */
  public async getMarketInfo(conditionId: string): Promise<{
    market: CryptoMarket | null;
    upPrice: number;
    downPrice: number;
  } | null> {
    try {
      const response = await this.apiClient.get(`/markets/${conditionId}`);
      const market = parseCryptoMarket(response.data);

      if (!market) {
        return null;
      }

      const upToken = market.tokens.find(t => t.outcome.toLowerCase().includes('yes') || t.outcome.toLowerCase().includes('up'));
      const downToken = market.tokens.find(t => t.outcome.toLowerCase().includes('no') || t.outcome.toLowerCase().includes('down'));

      return {
        market,
        upPrice: upToken?.price || 0,
        downPrice: downToken?.price || 0,
      };

    } catch (error) {
      logger.error('Failed to get market info', {
        conditionId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get market count by asset
   */
  public getMarketCountByAsset(): Record<CryptoAsset, number> {
    const counts: Record<CryptoAsset, number> = {
      BTC: 0,
      ETH: 0,
      SOL: 0,
      XRP: 0,
    };

    for (const market of this.getActiveMarkets()) {
      counts[market.asset]++;
    }

    return counts;
  }
}

export default MarketDiscoveryClient;

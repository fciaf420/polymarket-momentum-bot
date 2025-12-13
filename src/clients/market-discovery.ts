/**
 * Market Discovery Client
 * Fetches and filters active 15-minute crypto prediction markets
 */

import axios, { AxiosInstance } from 'axios';
import { CronJob } from 'cron';
import type { Market, CryptoMarket, CryptoAsset } from '../types/index.js';
import logger, { logMarket } from '../utils/logger.js';
import { parseCryptoMarket, isMarketTradeable, retryWithBackoff } from '../utils/helpers.js';
import { MARKET_PATTERNS } from '../config.js';

interface MarketResponse {
  data: Market[];
  next_cursor?: string;
}

export class MarketDiscoveryClient {
  private apiClient: AxiosInstance;
  private activeMarkets: Map<string, CryptoMarket> = new Map();
  private refreshJob: CronJob | null = null;
  private onMarketsUpdate: ((markets: CryptoMarket[]) => void) | null = null;

  constructor(host: string) {
    this.apiClient = axios.create({
      baseURL: host,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
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
   * Refresh active markets
   */
  public async refreshMarkets(): Promise<void> {
    try {
      logger.debug('Refreshing markets...');

      // Fetch all active markets
      const markets = await this.fetchAllMarkets();

      // Filter for 15-minute crypto markets
      const cryptoMarkets = this.filterCryptoMarkets(markets);

      // Update active markets map
      const previousCount = this.activeMarkets.size;
      this.activeMarkets.clear();

      for (const market of cryptoMarkets) {
        if (isMarketTradeable(market)) {
          this.activeMarkets.set(market.conditionId, market);
        }
      }

      logger.info('Markets refreshed', {
        total: markets.length,
        cryptoMarkets: cryptoMarkets.length,
        active: this.activeMarkets.size,
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

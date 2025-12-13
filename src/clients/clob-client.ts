/**
 * Polymarket CLOB Client Wrapper
 * Handles authentication, order management, and position tracking
 */

import { ClobClient, ApiKeyCreds, Chain } from '@polymarket/clob-client';
import { ethers, Wallet } from 'ethers';
import type {
  Config,
  Order,
  OrderSide,
  OrderStatus,
  CryptoMarket,
  Position,
  AccountBalance,
} from '../types/index.js';
import logger from '../utils/logger.js';
import { retryWithBackoff, generateId } from '../utils/helpers.js';

// Order types from CLOB client
interface OrderArgs {
  tokenId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  feeRateBps?: number;
  nonce?: number;
  expiration?: number;
}

interface SignedOrder {
  order: OrderArgs;
  signature: string;
  orderType: string;
}

interface OrderResponse {
  success: boolean;
  orderId?: string;
  errorMsg?: string;
  transactionHash?: string;
}

interface PositionResponse {
  asset_id: string;
  size: string;
  avg_entry_price: string;
}

interface BalanceResponse {
  balance: string;
}

export class PolymarketClobClient {
  private client: ClobClient | null = null;
  private wallet: Wallet;
  private config: Config;
  private apiCreds: ApiKeyCreds | null = null;
  private isInitialized: boolean = false;
  private dryRun: boolean;

  // Simulated balance for dry run mode
  private simulatedBalance: number = 10000;
  private simulatedPositions: Map<string, { size: number; avgPrice: number }> = new Map();

  constructor(config: Config) {
    this.config = config;
    this.dryRun = config.dryRun;

    // Create wallet from private key
    this.wallet = new Wallet(config.privateKey);
  }

  /**
   * Initialize the CLOB client with authentication
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      logger.info('Initializing CLOB client', {
        host: this.config.host,
        chainId: this.config.chainId,
        address: this.wallet.address,
        dryRun: this.dryRun,
      });

      // Check if we have stored API credentials
      if (this.config.apiKey && this.config.apiSecret && this.config.apiPassphrase) {
        this.apiCreds = {
          key: this.config.apiKey,
          secret: this.config.apiSecret,
          passphrase: this.config.apiPassphrase,
        };

        logger.info('Using stored API credentials');
      } else {
        // Derive or create API credentials
        this.apiCreds = await this.deriveApiCredentials();
      }

      // Initialize CLOB client
      const chain = this.config.chainId === 137 ? Chain.POLYGON : Chain.AMOY;

      this.client = new ClobClient(
        this.config.host,
        chain,
        this.wallet,
        this.apiCreds
      );

      this.isInitialized = true;
      logger.info('CLOB client initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize CLOB client', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Derive API credentials from wallet
   */
  private async deriveApiCredentials(): Promise<ApiKeyCreds> {
    if (!this.client) {
      // Temporarily create client without creds to derive them
      const chain = this.config.chainId === 137 ? Chain.POLYGON : Chain.AMOY;
      const tempClient = new ClobClient(this.config.host, chain, this.wallet);

      // Check for existing API keys
      try {
        const existingKeys = await tempClient.getApiKeys();
        if (existingKeys && existingKeys.length > 0) {
          logger.info('Found existing API key');
          // We need to derive creds since we don't have the secret
        }
      } catch (error) {
        logger.debug('No existing API keys found');
      }

      // Derive new credentials
      const creds = await tempClient.deriveApiKey();

      logger.info('Derived new API credentials', {
        key: creds.key,
        // Don't log secret or passphrase
      });

      return creds;
    }

    return this.client.deriveApiKey();
  }

  /**
   * Get account balance
   */
  public async getBalance(): Promise<number> {
    if (this.dryRun) {
      return this.simulatedBalance;
    }

    await this.ensureInitialized();

    try {
      const balance = await retryWithBackoff(
        () => this.client!.getBalanceAllowance({ asset_type: 'USDC' }),
        { maxRetries: 3 }
      );

      // Balance is in USDC with 6 decimals
      return parseFloat(balance.balance) / 1e6;
    } catch (error) {
      logger.error('Failed to get balance', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Get open positions
   */
  public async getPositions(): Promise<PositionResponse[]> {
    if (this.dryRun) {
      return Array.from(this.simulatedPositions.entries()).map(([assetId, pos]) => ({
        asset_id: assetId,
        size: pos.size.toString(),
        avg_entry_price: pos.avgPrice.toString(),
      }));
    }

    await this.ensureInitialized();

    try {
      // Get all positions for the user
      const positions = await retryWithBackoff(
        () => this.client!.getPositions(),
        { maxRetries: 3 }
      );

      return positions.map((p: { asset_id: string; size: string; avg_entry_price: string }) => ({
        asset_id: p.asset_id,
        size: p.size,
        avg_entry_price: p.avg_entry_price,
      }));
    } catch (error) {
      logger.error('Failed to get positions', { error: (error as Error).message });
      return [];
    }
  }

  /**
   * Place a market buy order
   */
  public async marketBuy(
    tokenId: string,
    amount: number, // Amount in USDC to spend
    market: CryptoMarket
  ): Promise<Order> {
    const orderId = generateId();

    logger.info('Placing market buy order', {
      orderId,
      tokenId,
      amount,
      market: market.marketSlug,
      dryRun: this.dryRun,
    });

    if (this.dryRun) {
      return this.simulateMarketBuy(orderId, tokenId, amount);
    }

    await this.ensureInitialized();

    try {
      // Get current best ask price
      const orderBook = await this.client!.getOrderBook(tokenId);
      if (!orderBook.asks || orderBook.asks.length === 0) {
        throw new Error('No asks available in order book');
      }

      // Sort asks by price ascending
      const sortedAsks = orderBook.asks.sort(
        (a: { price: string }, b: { price: string }) => parseFloat(a.price) - parseFloat(b.price)
      );

      // Calculate how many shares we can buy with our amount
      let remainingAmount = amount;
      let totalShares = 0;
      let avgPrice = 0;

      for (const ask of sortedAsks) {
        const askPrice = parseFloat(ask.price);
        const askSize = parseFloat(ask.size);
        const askValue = askPrice * askSize;

        if (remainingAmount >= askValue) {
          totalShares += askSize;
          avgPrice = (avgPrice * (totalShares - askSize) + askPrice * askSize) / totalShares;
          remainingAmount -= askValue;
        } else {
          const partialShares = remainingAmount / askPrice;
          totalShares += partialShares;
          avgPrice = (avgPrice * (totalShares - partialShares) + askPrice * partialShares) / totalShares;
          break;
        }
      }

      if (totalShares === 0) {
        throw new Error('Unable to calculate order size');
      }

      // Create and sign order
      const orderArgs: OrderArgs = {
        tokenId,
        price: sortedAsks[0].price, // Use best ask price
        size: totalShares,
        side: 'BUY',
      };

      const signedOrder = await this.client!.createOrder(orderArgs);
      const result = await this.client!.postOrder(signedOrder);

      if (!result.success) {
        throw new Error(result.errorMsg || 'Order failed');
      }

      return {
        id: result.orderId || orderId,
        marketId: market.conditionId,
        tokenId,
        side: 'BUY',
        type: 'market',
        size: totalShares,
        status: 'filled',
        filledSize: totalShares,
        avgFillPrice: avgPrice,
        timestamp: Date.now(),
      };

    } catch (error) {
      logger.error('Market buy order failed', { error: (error as Error).message });

      return {
        id: orderId,
        marketId: market.conditionId,
        tokenId,
        side: 'BUY',
        type: 'market',
        size: 0,
        status: 'failed',
        filledSize: 0,
        avgFillPrice: 0,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Place a market sell order
   */
  public async marketSell(
    tokenId: string,
    size: number, // Number of shares to sell
    market: CryptoMarket
  ): Promise<Order> {
    const orderId = generateId();

    logger.info('Placing market sell order', {
      orderId,
      tokenId,
      size,
      market: market.marketSlug,
      dryRun: this.dryRun,
    });

    if (this.dryRun) {
      return this.simulateMarketSell(orderId, tokenId, size);
    }

    await this.ensureInitialized();

    try {
      // Get current best bid price
      const orderBook = await this.client!.getOrderBook(tokenId);
      if (!orderBook.bids || orderBook.bids.length === 0) {
        throw new Error('No bids available in order book');
      }

      // Sort bids by price descending
      const sortedBids = orderBook.bids.sort(
        (a: { price: string }, b: { price: string }) => parseFloat(b.price) - parseFloat(a.price)
      );

      const bestBid = parseFloat(sortedBids[0].price);

      // Create and sign order
      const orderArgs: OrderArgs = {
        tokenId,
        price: bestBid,
        size,
        side: 'SELL',
      };

      const signedOrder = await this.client!.createOrder(orderArgs);
      const result = await this.client!.postOrder(signedOrder);

      if (!result.success) {
        throw new Error(result.errorMsg || 'Order failed');
      }

      return {
        id: result.orderId || orderId,
        marketId: market.conditionId,
        tokenId,
        side: 'SELL',
        type: 'market',
        size,
        status: 'filled',
        filledSize: size,
        avgFillPrice: bestBid,
        timestamp: Date.now(),
      };

    } catch (error) {
      logger.error('Market sell order failed', { error: (error as Error).message });

      return {
        id: orderId,
        marketId: market.conditionId,
        tokenId,
        side: 'SELL',
        type: 'market',
        size,
        status: 'failed',
        filledSize: 0,
        avgFillPrice: 0,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Cancel an open order
   */
  public async cancelOrder(orderId: string): Promise<boolean> {
    if (this.dryRun) {
      logger.info('Simulated order cancellation', { orderId });
      return true;
    }

    await this.ensureInitialized();

    try {
      await this.client!.cancelOrder(orderId);
      logger.info('Order cancelled', { orderId });
      return true;
    } catch (error) {
      logger.error('Failed to cancel order', { orderId, error: (error as Error).message });
      return false;
    }
  }

  /**
   * Cancel all open orders
   */
  public async cancelAllOrders(): Promise<void> {
    if (this.dryRun) {
      logger.info('Simulated cancel all orders');
      return;
    }

    await this.ensureInitialized();

    try {
      await this.client!.cancelAll();
      logger.info('All orders cancelled');
    } catch (error) {
      logger.error('Failed to cancel all orders', { error: (error as Error).message });
    }
  }

  /**
   * Simulate market buy for dry run mode
   */
  private simulateMarketBuy(orderId: string, tokenId: string, amount: number): Order {
    // Simulate price based on typical spread
    const simulatedPrice = 0.50 + Math.random() * 0.10; // 50-60 cents
    const shares = amount / simulatedPrice;

    // Update simulated balance and positions
    this.simulatedBalance -= amount;

    const existing = this.simulatedPositions.get(tokenId);
    if (existing) {
      const newSize = existing.size + shares;
      existing.avgPrice = (existing.avgPrice * existing.size + simulatedPrice * shares) / newSize;
      existing.size = newSize;
    } else {
      this.simulatedPositions.set(tokenId, { size: shares, avgPrice: simulatedPrice });
    }

    logger.info('Simulated market buy executed', {
      orderId,
      tokenId,
      amount,
      shares: shares.toFixed(4),
      price: simulatedPrice.toFixed(4),
    });

    return {
      id: orderId,
      marketId: '',
      tokenId,
      side: 'BUY',
      type: 'market',
      size: shares,
      status: 'filled',
      filledSize: shares,
      avgFillPrice: simulatedPrice,
      timestamp: Date.now(),
    };
  }

  /**
   * Simulate market sell for dry run mode
   */
  private simulateMarketSell(orderId: string, tokenId: string, size: number): Order {
    const position = this.simulatedPositions.get(tokenId);
    if (!position || position.size < size) {
      logger.warn('Simulated sell failed: insufficient position', {
        tokenId,
        requestedSize: size,
        availableSize: position?.size || 0,
      });

      return {
        id: orderId,
        marketId: '',
        tokenId,
        side: 'SELL',
        type: 'market',
        size,
        status: 'failed',
        filledSize: 0,
        avgFillPrice: 0,
        timestamp: Date.now(),
      };
    }

    // Simulate exit price (typically higher due to market catching up)
    const exitPrice = position.avgPrice * (1 + Math.random() * 0.5); // 0-50% profit
    const proceeds = size * exitPrice;

    // Update simulated balance and positions
    this.simulatedBalance += proceeds;
    position.size -= size;

    if (position.size <= 0) {
      this.simulatedPositions.delete(tokenId);
    }

    logger.info('Simulated market sell executed', {
      orderId,
      tokenId,
      size: size.toFixed(4),
      price: exitPrice.toFixed(4),
      proceeds: proceeds.toFixed(2),
    });

    return {
      id: orderId,
      marketId: '',
      tokenId,
      side: 'SELL',
      type: 'market',
      size,
      status: 'filled',
      filledSize: size,
      avgFillPrice: exitPrice,
      timestamp: Date.now(),
    };
  }

  /**
   * Get order book for a token
   */
  public async getOrderBook(tokenId: string): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  }> {
    await this.ensureInitialized();

    try {
      const book = await this.client!.getOrderBook(tokenId);

      return {
        bids: (book.bids || []).map((b: { price: string; size: string }) => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })),
        asks: (book.asks || []).map((a: { price: string; size: string }) => ({
          price: parseFloat(a.price),
          size: parseFloat(a.size),
        })),
      };
    } catch (error) {
      logger.error('Failed to get order book', { tokenId, error: (error as Error).message });
      return { bids: [], asks: [] };
    }
  }

  /**
   * Get current price for a token
   */
  public async getTokenPrice(tokenId: string): Promise<number> {
    const book = await this.getOrderBook(tokenId);

    if (book.bids.length > 0 && book.asks.length > 0) {
      // Mid price
      return (book.bids[0].price + book.asks[0].price) / 2;
    } else if (book.bids.length > 0) {
      return book.bids[0].price;
    } else if (book.asks.length > 0) {
      return book.asks[0].price;
    }

    return 0;
  }

  /**
   * Get available liquidity for a token
   */
  public async getLiquidity(tokenId: string): Promise<number> {
    const book = await this.getOrderBook(tokenId);

    const bidLiquidity = book.bids.reduce((sum, b) => sum + b.price * b.size, 0);
    const askLiquidity = book.asks.reduce((sum, a) => sum + a.price * a.size, 0);

    return bidLiquidity + askLiquidity;
  }

  /**
   * Ensure client is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * Get wallet address
   */
  public getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Check if running in dry run mode
   */
  public isDryRun(): boolean {
    return this.dryRun;
  }
}

export default PolymarketClobClient;

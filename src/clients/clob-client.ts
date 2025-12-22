/**
 * Polymarket CLOB Client Wrapper
 * Handles authentication, order management, and position tracking
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Wallet, ethers, Contract } from 'ethers';
import type { Config, Order, CryptoMarket } from '../types/index.js';
import logger from '../utils/logger.js';
import { retryWithBackoff, generateId } from '../utils/helpers.js';

// ERC20 ABI for balance checking
const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];

// USDC contract addresses on Polygon
const USDC_CONTRACTS = {
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  USDC_NATIVE: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

/**
 * Wraps an ethers v6 wallet to be compatible with ethers v5 API
 * that the @polymarket/clob-client expects
 */
function wrapWalletForClobClient(wallet: Wallet): Wallet & { _signTypedData: typeof wallet.signTypedData } {
  // Add _signTypedData method that ethers v5 used (now signTypedData in v6)
  const wrappedWallet = wallet as Wallet & { _signTypedData: typeof wallet.signTypedData };
  wrappedWallet._signTypedData = wallet.signTypedData.bind(wallet);
  return wrappedWallet;
}

// Dynamic import for ClobClient since it may not have proper types
let ClobClient: any;
let Chain: any;

async function loadClobClient() {
  try {
    // @ts-ignore - @polymarket/clob-client may not have type declarations
    const module = await import('@polymarket/clob-client');
    ClobClient = module.ClobClient;
    Chain = module.Chain;
  } catch (error) {
    logger.error('Failed to load @polymarket/clob-client', { error: (error as Error).message });
    throw error;
  }
}

interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export class PolymarketClobClient {
  private client: any = null;
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
      // Load the CLOB client module
      await loadClobClient();

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
      }

      // Initialize CLOB client
      const chain = this.config.chainId === 137 ? Chain.POLYGON : Chain.AMOY;

      // Wrap wallet for ethers v5 compatibility
      const wrappedWallet = wrapWalletForClobClient(this.wallet);

      if (this.apiCreds) {
        this.client = new ClobClient(
          this.config.host,
          chain,
          wrappedWallet,
          this.apiCreds
        );
      } else {
        this.client = new ClobClient(
          this.config.host,
          chain,
          wrappedWallet
        );

        // Derive API credentials
        try {
          this.apiCreds = await this.client.deriveApiKey();
          logger.info('Derived new API credentials');

          // Recreate client with the derived credentials
          this.client = new ClobClient(
            this.config.host,
            chain,
            wrappedWallet,
            this.apiCreds
          );
          logger.info('CLOB client recreated with API credentials');
        } catch (error) {
          logger.warn('Could not derive API credentials', { error: (error as Error).message });
        }
      }

      this.isInitialized = true;
      logger.info('CLOB client initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize CLOB client', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Get account balance
   * Uses on-chain balance check (supports proxy wallets) with API fallback
   */
  public async getBalance(): Promise<number> {
    if (this.dryRun) {
      return this.simulatedBalance;
    }

    await this.ensureInitialized();

    // Use on-chain balance check (works with proxy wallets)
    const balanceAddress = this.config.polymarketWallet || this.wallet.address;

    try {
      const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');

      // Try USDC.e first (more common on Polymarket)
      let contract = new Contract(USDC_CONTRACTS.USDC_E, ERC20_BALANCE_ABI, provider);
      let balance = await contract.balanceOf(balanceAddress);

      if (balance > 0n) {
        return Number(balance) / 1e6;
      }

      // Try native USDC
      contract = new Contract(USDC_CONTRACTS.USDC_NATIVE, ERC20_BALANCE_ABI, provider);
      balance = await contract.balanceOf(balanceAddress);

      return Number(balance) / 1e6;
    } catch (error) {
      logger.warn('On-chain balance check failed, trying API', { error: (error as Error).message });

      // Fallback to API (may not work with proxy wallets)
      try {
        const balance = await retryWithBackoff(
          () => this.client.getBalanceAllowance({ asset_type: 'USDC' }) as Promise<{ balance?: string }>,
          { maxRetries: 2 }
        );
        return parseFloat(balance?.balance || '0') / 1e6;
      } catch (apiError) {
        logger.error('Failed to get balance from both on-chain and API', { error: (apiError as Error).message });
        return 0;
      }
    }
  }

  /**
   * Get open positions
   */
  public async getPositions(): Promise<Array<{ asset_id: string; size: string; avg_entry_price: string }>> {
    if (this.dryRun) {
      return Array.from(this.simulatedPositions.entries()).map(([assetId, pos]) => ({
        asset_id: assetId,
        size: pos.size.toString(),
        avg_entry_price: pos.avgPrice.toString(),
      }));
    }

    await this.ensureInitialized();

    try {
      const positions = await retryWithBackoff(
        () => this.client.getPositions() as Promise<any[]>,
        { maxRetries: 3 }
      );

      return (positions || []).map((p: any) => ({
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
    amount: number,
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
      return this.simulateMarketBuy(orderId, tokenId, amount, market);
    }

    await this.ensureInitialized();

    try {
      // Get current best ask price
      const orderBook = await this.client.getOrderBook(tokenId);
      if (!orderBook?.asks || orderBook.asks.length === 0) {
        throw new Error('No asks available in order book');
      }

      // Sort asks by price ascending
      const sortedAsks = orderBook.asks.sort(
        (a: any, b: any) => parseFloat(a.price) - parseFloat(b.price)
      );

      // Calculate how many shares we can buy
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

      // Create and post order
      const orderArgs = {
        tokenId,
        price: parseFloat(sortedAsks[0].price),
        size: totalShares,
        side: 'BUY',
      };

      const signedOrder = await this.client.createOrder(orderArgs);
      const result = await this.client.postOrder(signedOrder);

      if (!result?.success) {
        throw new Error(result?.errorMsg || 'Order failed');
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
    size: number,
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
      return this.simulateMarketSell(orderId, tokenId, size, market);
    }

    await this.ensureInitialized();

    try {
      const orderBook = await this.client.getOrderBook(tokenId);
      if (!orderBook?.bids || orderBook.bids.length === 0) {
        throw new Error('No bids available in order book');
      }

      const sortedBids = orderBook.bids.sort(
        (a: any, b: any) => parseFloat(b.price) - parseFloat(a.price)
      );

      const bestBid = parseFloat(sortedBids[0].price);

      const orderArgs = {
        tokenId,
        price: bestBid,
        size,
        side: 'SELL',
      };

      const signedOrder = await this.client.createOrder(orderArgs);
      const result = await this.client.postOrder(signedOrder);

      if (!result?.success) {
        throw new Error(result?.errorMsg || 'Order failed');
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
   * Simulate market buy for dry run mode
   */
  private simulateMarketBuy(orderId: string, tokenId: string, amount: number, market: CryptoMarket): Order {
    const simulatedPrice = 0.50 + Math.random() * 0.10;
    const shares = amount / simulatedPrice;

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
      marketId: market.conditionId,
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
  private simulateMarketSell(orderId: string, tokenId: string, size: number, market: CryptoMarket): Order {
    const position = this.simulatedPositions.get(tokenId);
    if (!position || position.size < size) {
      logger.warn('Simulated sell failed: insufficient position');
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

    const exitPrice = position.avgPrice * (1 + Math.random() * 0.5);
    const proceeds = size * exitPrice;

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
      marketId: market.conditionId,
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
      const book = await this.client.getOrderBook(tokenId);

      return {
        bids: (book?.bids || []).map((b: any) => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })),
        asks: (book?.asks || []).map((a: any) => ({
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

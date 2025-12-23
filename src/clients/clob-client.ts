/**
 * Polymarket CLOB Client Wrapper
 * Handles authentication, order management, and position tracking
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Wallet, ethers, Contract } from 'ethers';
import axios from 'axios';
import type { Config, Order, CryptoMarket } from '../types/index.js';
import logger from '../utils/logger.js';
import { retryWithBackoff, generateId } from '../utils/helpers.js';
import { UsdcApprovalManager } from './usdc-approval.js';

// CLOB API base URL
const CLOB_API = 'https://clob.polymarket.com';

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
  private approvalManager: UsdcApprovalManager | null = null;
  private ctfApprovalChecked: boolean = false;

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

      // Signature type: 0 = EOA, 1 = POLY_PROXY (Magic Link), 2 = GNOSIS_SAFE (Polymarket proxy)
      // If using a proxy wallet, use signatureType 2
      const signatureType = this.config.polymarketWallet ? 2 : 0;

      // Funder address: use proxy wallet if provided, otherwise EOA
      const funder = this.config.polymarketWallet || this.wallet.address;

      logger.info('CLOB client config', {
        signatureType,
        funder,
        hasProxyWallet: !!this.config.polymarketWallet,
      });

      if (this.apiCreds) {
        this.client = new ClobClient(
          this.config.host,
          chain,
          wrappedWallet,
          this.apiCreds,
          signatureType,
          funder
        );
      } else {
        // First create client to derive API credentials
        this.client = new ClobClient(
          this.config.host,
          chain,
          wrappedWallet,
          undefined, // no creds yet
          signatureType,
          funder
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
            this.apiCreds,
            signatureType,
            funder
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
   * Get open positions from Polymarket Data API
   * Uses the data-api endpoint which provides user position data
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

    // Use the proxy wallet if configured, otherwise EOA
    const walletAddress = this.config.polymarketWallet || this.wallet.address;

    try {
      // Fetch positions from Polymarket Data API
      logger.debug('Fetching positions from Data API', { wallet: walletAddress });

      const response = await axios.get('https://data-api.polymarket.com/positions', {
        params: {
          user: walletAddress.toLowerCase(),
          sizeThreshold: 0, // Include all positions
        },
        timeout: 10000,
      });

      const rawPositions = response.data || [];

      logger.debug('Raw positions response', {
        count: rawPositions.length,
        sample: rawPositions.length > 0 ? JSON.stringify(rawPositions[0]).substring(0, 200) : 'empty',
      });

      // Filter out resolved positions (currentValue === 0, curPrice === 0)
      const activePositions = rawPositions.filter((p: any) => {
        const currentValue = parseFloat(p.currentValue || '0');
        const curPrice = parseFloat(p.curPrice || '0');
        const size = parseFloat(p.size || '0');
        // Only include positions with value (active markets)
        return size > 0 && (currentValue > 0 || curPrice > 0);
      });

      const positions = activePositions.map((p: any) => ({
        asset_id: p.asset || p.token_id || p.assetId || p.tokenId,
        size: String(p.size || p.amount || p.shares || 0),
        avg_entry_price: String(p.avgPrice || p.avg_price || p.averagePrice || p.price || 0.5),
      }));

      logger.info('Positions from Data API', {
        wallet: walletAddress.substring(0, 10) + '...',
        rawCount: rawPositions.length,
        activeCount: positions.length,
        expiredCount: rawPositions.length - positions.length,
      });

      return positions;

    } catch (error) {
      logger.warn('Failed to get positions from Data API', {
        error: (error as Error).message,
        wallet: walletAddress.substring(0, 10) + '...',
      });
      return [];
    }
  }

  /**
   * Fetch tick size for a token from CLOB API
   * The tick size determines minimum price increments
   */
  private async getTickSize(tokenId: string): Promise<number> {
    try {
      const response = await axios.get(`${CLOB_API}/tick-size`, {
        params: { token_id: tokenId },
        timeout: 10000,
      });
      const tickSize = response.data?.minimum_tick_size || 0.01;
      logger.debug('Fetched tick size', { tokenId: tokenId.substring(0, 20), tickSize });
      return tickSize;
    } catch (error) {
      logger.warn('Failed to fetch tick size, using default 0.01', {
        error: (error as Error).message,
      });
      return 0.01; // Default tick size
    }
  }

  /**
   * Check if a market uses neg risk (for CTF exchange)
   * The 15-minute crypto markets do NOT use neg risk
   */
  private isNegRiskMarket(_market: CryptoMarket): boolean {
    // 15-minute crypto up/down markets use standard CTF, not neg risk
    return false;
  }

  /**
   * Ensure CTF tokens are approved for selling
   * Only checks once per session to avoid repeated on-chain calls
   */
  private async ensureCTFApproval(): Promise<boolean> {
    if (this.dryRun) {
      return true;
    }

    // Only check once per session
    if (this.ctfApprovalChecked) {
      return true;
    }

    try {
      if (!this.approvalManager) {
        this.approvalManager = new UsdcApprovalManager(this.config);
        await this.approvalManager.initialize();
      }

      const approved = await this.approvalManager.ensureCTFApproval();
      this.ctfApprovalChecked = approved;

      if (approved) {
        logger.info('CTF tokens approved for selling');
      } else {
        logger.error('Failed to approve CTF tokens - selling may fail');
      }

      return approved;
    } catch (error) {
      logger.error('Error ensuring CTF approval', { error: (error as Error).message });
      return false;
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

      // Fetch tick size and neg risk config for the market
      const tickSize = await this.getTickSize(tokenId);
      const negRisk = this.isNegRiskMarket(market);

      // Round price to tick size
      const rawPrice = parseFloat(sortedAsks[0].price);
      const roundedPrice = Math.round(rawPrice / tickSize) * tickSize;

      logger.debug('Creating order with market config', {
        tickSize,
        negRisk,
        rawPrice,
        roundedPrice,
        size: totalShares,
      });

      // Create and post order with full market config
      const orderArgs = {
        tokenID: tokenId,  // Library uses tokenID not tokenId
        price: roundedPrice,
        size: totalShares,
        side: 'BUY' as const,
      };

      // Use createOrder with proper tick size
      const signedOrder = await this.client.createOrder(orderArgs, { tickSize, negRisk });
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

    // Ensure CTF tokens are approved for selling (one-time check per session)
    await this.ensureCTFApproval();

    try {
      const orderBook = await this.client.getOrderBook(tokenId);
      if (!orderBook?.bids || orderBook.bids.length === 0) {
        throw new Error('No bids available in order book');
      }

      const sortedBids = orderBook.bids.sort(
        (a: any, b: any) => parseFloat(b.price) - parseFloat(a.price)
      );

      const bestBid = parseFloat(sortedBids[0].price);

      // Fetch tick size and neg risk config for the market
      const tickSize = await this.getTickSize(tokenId);
      const negRisk = this.isNegRiskMarket(market);

      // Round price to tick size
      const roundedPrice = Math.round(bestBid / tickSize) * tickSize;

      logger.debug('Creating sell order with market config', {
        tickSize,
        negRisk,
        rawPrice: bestBid,
        roundedPrice,
        size,
      });

      const orderArgs = {
        tokenID: tokenId,  // Library uses tokenID not tokenId
        price: roundedPrice,
        size,
        side: 'SELL' as const,
      };

      const signedOrder = await this.client.createOrder(orderArgs, { tickSize, negRisk });
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
      const errorMessage = (error as Error).message || 'Unknown error';

      // Check for specific error types
      const isBalanceError = errorMessage.includes('not enough balance') ||
                             errorMessage.includes('allowance');
      const isMarketClosed = errorMessage.includes('market is closed') ||
                             errorMessage.includes('trading is disabled');
      const isNoLiquidity = errorMessage.includes('No bids available') ||
                            errorMessage.includes('no liquidity');

      // Determine the failure reason
      let failureReason: 'order_failed' | 'no_balance_tokens_resolved' | 'market_closed' | 'no_liquidity' = 'order_failed';
      if (isBalanceError) {
        failureReason = 'no_balance_tokens_resolved';
        logger.warn('Sell failed - tokens likely resolved/redeemed', {
          market: market.marketSlug,
          tokenId: tokenId.substring(0, 20),
          error: errorMessage,
        });
      } else if (isMarketClosed) {
        failureReason = 'market_closed';
        logger.warn('Sell failed - market is closed', {
          market: market.marketSlug,
          error: errorMessage,
        });
      } else if (isNoLiquidity) {
        failureReason = 'no_liquidity';
        logger.warn('Sell failed - no bids in order book, will let market resolve', {
          market: market.marketSlug,
          tokenId: tokenId.substring(0, 20),
        });
      } else {
        logger.error('Market sell order failed', {
          market: market.marketSlug,
          tokenId: tokenId.substring(0, 20),
          size,
          error: errorMessage,
        });
      }

      return {
        id: orderId,
        marketId: market.conditionId,
        tokenId,
        side: 'SELL',
        type: 'market',
        size,
        status: 'failed',
        failureReason,
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

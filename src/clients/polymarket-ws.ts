/**
 * Polymarket WebSocket Client
 * Handles real-time market data, order book updates, and user events
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type {
  OrderBook,
} from '../types/index.js';
import logger, { logWsEvent } from '../utils/logger.js';
import { sleep, normalizeSharePrice } from '../utils/helpers.js';

// Polymarket WebSocket message types (actual format from API)
interface PolymarketWSMessage {
  type?: string;          // Only present in some messages
  channel?: string;
  market?: string;
  asset_id?: string;
  data?: unknown;
  // Actual price update format
  price_changes?: Array<{ asset_id: string; price: string }>;
  // Book snapshot format
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  timestamp?: string | number;
}

interface PriceChangeMessage {
  asset_id: string;
  price: string;
  timestamp: number;
}

interface OrderBookSnapshot {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
  hash: string;
}

export class PolymarketWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private subscriptions: Map<string, Set<string>> = new Map();

  // Market data storage
  private orderBooks: Map<string, OrderBook> = new Map();

  // Authentication for user channel
  private authToken?: string;

  constructor(wsUrl: string) {
    super();
    this.wsUrl = wsUrl;
  }

  /**
   * Set authentication token for user subscriptions
   */
  public setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Connect to Polymarket WebSocket
   */
  public async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          logWsEvent('connected', 'Polymarket');
          this.startPingInterval();
          this.resubscribeAll();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error: Error) => {
          logger.error('Polymarket WebSocket error', { error: error.message });
          this.emit('error', error);
          if (this.isConnecting) {
            reject(error);
          }
        });

        this.ws.on('close', (code: number, _reason: Buffer) => {
          this.isConnecting = false;
          logWsEvent('disconnected', 'Polymarket', `Code: ${code}`);
          this.stopPingInterval();
          this.emit('disconnected');

          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('ping', () => {
          this.ws?.pong();
        });

        this.ws.on('pong', () => {
          // Connection alive
        });

      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   * Polymarket sends various formats:
   * - Array of messages: [{...}, {...}]
   * - Price updates: {"market": "...", "price_changes": [...]}
   * - Order book: {"market": "...", "asset_id": "...", "bids": [...], "asks": [...]}
   */
  private handleMessage(data: WebSocket.Data): void {
    const dataStr = data.toString();

    // Handle text messages (not JSON)
    if (dataStr === 'PONG') {
      return;
    }

    // Handle error responses like "INVALID OPERATION"
    if (dataStr.startsWith('INVALID') || !dataStr.startsWith('{') && !dataStr.startsWith('[')) {
      logger.debug('Non-JSON WebSocket message', { message: dataStr.substring(0, 50) });
      return;
    }

    try {
      const parsed = JSON.parse(dataStr);

      // Handle array of messages
      if (Array.isArray(parsed)) {
        for (const msg of parsed) {
          this.processMessage(msg);
        }
        return;
      }

      // Handle single message
      this.processMessage(parsed as PolymarketWSMessage);
    } catch (error) {
      logger.debug('Failed to parse WebSocket message', { preview: dataStr.substring(0, 50) });
    }
  }

  /**
   * Process a single Polymarket message based on its structure
   */
  private processMessage(message: PolymarketWSMessage): void {
    const timestamp = typeof message.timestamp === 'string'
      ? parseInt(message.timestamp, 10)
      : (message.timestamp || Date.now());

    // Handle price_changes format (most common for market subscriptions)
    if (message.price_changes && Array.isArray(message.price_changes)) {
      for (const pc of message.price_changes) {
        const price = normalizeSharePrice(pc.price);
        logger.debug('Price update', { assetId: pc.asset_id.substring(0, 20), price });
        this.emit('priceChange', pc.asset_id, price, timestamp);
      }
      return;
    }

    // Handle order book snapshot (has bids/asks at top level)
    if (message.bids && message.asks && message.asset_id) {
      this.handleOrderBookSnapshot({
        market: message.market || '',
        asset_id: message.asset_id,
        bids: message.bids,
        asks: message.asks,
        timestamp,
        hash: '',
      });
      return;
    }

    // Handle legacy type-based messages
    if (message.type) {
      switch (message.type) {
        case 'price_change':
          this.handlePriceChange(message.data as PriceChangeMessage);
          break;
        case 'book':
          this.handleOrderBookSnapshot(message.data as OrderBookSnapshot);
          break;
        case 'error':
          logger.error('Polymarket WS error', { data: message.data });
          break;
        default:
          // Ignore other message types
          break;
      }
    }
  }

  /**
   * Handle price change message
   */
  private handlePriceChange(data: PriceChangeMessage): void {
    const price = normalizeSharePrice(data.price);
    const assetId = data.asset_id;

    this.emit('priceChange', assetId, price, data.timestamp);
  }

  /**
   * Handle order book snapshot
   */
  private handleOrderBookSnapshot(data: OrderBookSnapshot): void {
    const orderBook: OrderBook = {
      tokenId: data.asset_id,
      bids: data.bids.map(b => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size),
      })),
      asks: data.asks.map(a => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size),
      })),
      timestamp: data.timestamp,
      totalLiquidity: this.calculateLiquidity(data.bids, data.asks),
    };

    this.orderBooks.set(data.asset_id, orderBook);
    this.emit('orderBook', data.asset_id, orderBook);
  }

  /**
   * Calculate total liquidity from raw bid/ask arrays
   */
  private calculateLiquidity(
    bids: Array<{ price: string; size: string }>,
    asks: Array<{ price: string; size: string }>
  ): number {
    const bidLiquidity = bids.reduce((sum, b) => sum + parseFloat(b.price) * parseFloat(b.size), 0);
    const askLiquidity = asks.reduce((sum, a) => sum + parseFloat(a.price) * parseFloat(a.size), 0);
    return bidLiquidity + askLiquidity;
  }

  /**
   * Subscribe to market price channel
   * Note: Polymarket WebSocket uses assets_ids array format
   */
  public subscribeToMarket(_conditionId: string, tokenIds: string[]): void {
    // Store subscriptions for resubscribe
    const subs = this.subscriptions.get('market') || new Set();
    tokenIds.forEach(id => subs.add(id));
    this.subscriptions.set('market', subs);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Polymarket expects assets_ids array format
    const message = {
      assets_ids: tokenIds,
      type: 'market',
    };

    this.ws.send(JSON.stringify(message));
    logger.debug('Subscribed to market', { tokenCount: tokenIds.length, tokenIds: tokenIds.slice(0, 2) });
  }

  /**
   * Subscribe to order book for a token
   * Note: Order book updates come through the same market channel
   */
  public subscribeToOrderBook(_conditionId: string, tokenId: string): void {
    // Store for tracking, but market subscription handles this
    const subs = this.subscriptions.get('book') || new Set();
    subs.add(tokenId);
    this.subscriptions.set('book', subs);

    // Order book data comes through market channel subscription
    // Just ensure we're subscribed to the token
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const marketSubs = this.subscriptions.get('market') || new Set();
      if (!marketSubs.has(tokenId)) {
        this.subscribeToMarket(_conditionId, [tokenId]);
      }
    }
  }

  /**
   * Subscribe to user channel (requires auth)
   */
  public subscribeToUser(): void {
    if (!this.authToken) {
      logger.warn('Cannot subscribe to user channel without auth token');
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.subscriptions.set('user', new Set(['user']));
      return;
    }

    const message = {
      type: 'subscribe',
      channel: 'user',
      auth: this.authToken,
    };

    this.ws.send(JSON.stringify(message));
    logger.debug('Subscribed to user channel');
  }

  /**
   * Unsubscribe from a market
   */
  public unsubscribeFromMarket(conditionId: string, tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const tokenId of tokenIds) {
      const message = {
        type: 'unsubscribe',
        channel: 'market',
        market: conditionId,
        asset_id: tokenId,
      };

      this.ws.send(JSON.stringify(message));

      const subs = this.subscriptions.get('market');
      subs?.delete(`${conditionId}:${tokenId}`);
    }
  }

  /**
   * Resubscribe to all channels after reconnection
   */
  private resubscribeAll(): void {
    // Collect all market token IDs
    const marketTokens = this.subscriptions.get('market');
    if (marketTokens && marketTokens.size > 0) {
      const tokenIds = Array.from(marketTokens);
      // Send one subscription message with all tokens
      const message = {
        assets_ids: tokenIds,
        type: 'market',
      };
      this.ws?.send(JSON.stringify(message));
      logger.debug('Resubscribed to markets', { tokenCount: tokenIds.length });
    }

    // Handle user channel
    const userSubs = this.subscriptions.get('user');
    if (userSubs && userSubs.size > 0) {
      this.subscribeToUser();
    }
  }

  /**
   * Get order book for a token
   */
  public getOrderBook(tokenId: string): OrderBook | undefined {
    return this.orderBooks.get(tokenId);
  }

  /**
   * Get best bid/ask for a token
   */
  public getBestBidAsk(tokenId: string): { bid: number; ask: number } | undefined {
    const book = this.orderBooks.get(tokenId);
    if (!book || book.bids.length === 0 || book.asks.length === 0) {
      return undefined;
    }

    return {
      bid: book.bids[0].price,
      ask: book.asks[0].price,
    };
  }

  /**
   * Get available liquidity for a token
   */
  public getLiquidity(tokenId: string): number {
    return this.orderBooks.get(tokenId)?.totalLiquidity || 0;
  }

  /**
   * Start ping interval
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Schedule reconnection
   */
  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max Polymarket reconnection attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const cappedDelay = Math.min(delay, 30000);

    logWsEvent('reconnecting', 'Polymarket', `Attempt ${this.reconnectAttempts} in ${cappedDelay}ms`);

    await sleep(cappedDelay);

    if (this.shouldReconnect) {
      try {
        await this.connect();
      } catch (error) {
        logger.error('Polymarket reconnection failed', { error: (error as Error).message });
      }
    }
  }

  /**
   * Check if connected
   */
  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Disconnect from WebSocket
   */
  public disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingInterval();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logWsEvent('disconnected', 'Polymarket', 'Manual disconnect');
  }
}

export default PolymarketWebSocketClient;

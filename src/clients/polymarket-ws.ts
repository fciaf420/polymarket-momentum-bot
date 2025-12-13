/**
 * Polymarket WebSocket Client
 * Handles real-time market data, order book updates, and user events
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type {
  CryptoMarket,
  MarketPriceData,
  OrderBook,
  OrderBookEntry,
  WSMessage,
  CryptoAsset,
} from '../types/index.js';
import logger, { logWsEvent } from '../utils/logger.js';
import { sleep, normalizeSharePrice } from '../utils/helpers.js';

// Polymarket WebSocket message types
interface PolymarketWSMessage {
  type: string;
  channel?: string;
  market?: string;
  asset_id?: string;
  data?: unknown;
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

interface OrderBookDelta {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
}

interface TradeMessage {
  asset_id: string;
  price: string;
  size: string;
  side: 'buy' | 'sell';
  timestamp: number;
}

interface UserOrderMessage {
  id: string;
  asset_id: string;
  side: string;
  size: string;
  filled_size: string;
  price: string;
  status: string;
  timestamp: number;
}

export class PolymarketWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;
  private pingInterval: NodeJS.Timeout | null = null;
  private subscriptions: Map<string, Set<string>> = new Map();

  // Market data storage
  private marketPrices: Map<string, MarketPriceData> = new Map();
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
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as PolymarketWSMessage;

      switch (message.type) {
        case 'price_change':
          this.handlePriceChange(message.data as PriceChangeMessage);
          break;

        case 'book':
          this.handleOrderBookSnapshot(message.data as OrderBookSnapshot);
          break;

        case 'book_delta':
          this.handleOrderBookDelta(message.data as OrderBookDelta);
          break;

        case 'trade':
          this.handleTrade(message.data as TradeMessage);
          break;

        case 'order':
          this.handleUserOrder(message.data as UserOrderMessage);
          break;

        case 'subscribed':
          logger.debug('Subscribed to channel', {
            channel: message.channel,
            market: message.market,
          });
          break;

        case 'unsubscribed':
          logger.debug('Unsubscribed from channel', {
            channel: message.channel,
            market: message.market,
          });
          break;

        case 'error':
          logger.error('Polymarket WS error message', { data: message.data });
          break;

        default:
          logger.debug('Unknown Polymarket message type', { type: message.type });
      }
    } catch (error) {
      logger.error('Error parsing Polymarket message', { error: (error as Error).message });
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
   * Handle order book delta (incremental update)
   */
  private handleOrderBookDelta(data: OrderBookDelta): void {
    const existing = this.orderBooks.get(data.asset_id);
    if (!existing) {
      // Request full snapshot
      this.subscribeToOrderBook(data.market, data.asset_id);
      return;
    }

    // Apply delta
    for (const bid of data.bids) {
      this.updateOrderBookSide(existing.bids, parseFloat(bid.price), parseFloat(bid.size), 'bid');
    }

    for (const ask of data.asks) {
      this.updateOrderBookSide(existing.asks, parseFloat(ask.price), parseFloat(ask.size), 'ask');
    }

    existing.timestamp = data.timestamp;
    existing.totalLiquidity = this.calculateLiquidityFromBook(existing);

    this.emit('orderBook', data.asset_id, existing);
  }

  /**
   * Update order book side with delta
   */
  private updateOrderBookSide(
    side: OrderBookEntry[],
    price: number,
    size: number,
    type: 'bid' | 'ask'
  ): void {
    const index = side.findIndex(e => e.price === price);

    if (size === 0) {
      // Remove price level
      if (index !== -1) {
        side.splice(index, 1);
      }
    } else if (index !== -1) {
      // Update existing level
      side[index].size = size;
    } else {
      // Insert new level
      side.push({ price, size });
      // Sort: bids descending, asks ascending
      side.sort((a, b) => type === 'bid' ? b.price - a.price : a.price - b.price);
    }
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
   * Calculate liquidity from order book
   */
  private calculateLiquidityFromBook(book: OrderBook): number {
    const bidLiquidity = book.bids.reduce((sum, b) => sum + b.price * b.size, 0);
    const askLiquidity = book.asks.reduce((sum, a) => sum + a.price * a.size, 0);
    return bidLiquidity + askLiquidity;
  }

  /**
   * Handle trade message
   */
  private handleTrade(data: TradeMessage): void {
    this.emit('trade', {
      assetId: data.asset_id,
      price: parseFloat(data.price),
      size: parseFloat(data.size),
      side: data.side,
      timestamp: data.timestamp,
    });
  }

  /**
   * Handle user order update
   */
  private handleUserOrder(data: UserOrderMessage): void {
    this.emit('userOrder', {
      id: data.id,
      assetId: data.asset_id,
      side: data.side,
      size: parseFloat(data.size),
      filledSize: parseFloat(data.filled_size),
      price: parseFloat(data.price),
      status: data.status,
      timestamp: data.timestamp,
    });
  }

  /**
   * Subscribe to market price channel
   */
  public subscribeToMarket(conditionId: string, tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue subscription for when connected
      const subs = this.subscriptions.get('market') || new Set();
      tokenIds.forEach(id => subs.add(`${conditionId}:${id}`));
      this.subscriptions.set('market', subs);
      return;
    }

    for (const tokenId of tokenIds) {
      const message = {
        type: 'subscribe',
        channel: 'market',
        market: conditionId,
        asset_id: tokenId,
      };

      this.ws.send(JSON.stringify(message));
      logger.debug('Subscribed to market', { conditionId, tokenId });

      const subs = this.subscriptions.get('market') || new Set();
      subs.add(`${conditionId}:${tokenId}`);
      this.subscriptions.set('market', subs);
    }
  }

  /**
   * Subscribe to order book for a token
   */
  public subscribeToOrderBook(conditionId: string, tokenId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const subs = this.subscriptions.get('book') || new Set();
      subs.add(`${conditionId}:${tokenId}`);
      this.subscriptions.set('book', subs);
      return;
    }

    const message = {
      type: 'subscribe',
      channel: 'book',
      market: conditionId,
      asset_id: tokenId,
    };

    this.ws.send(JSON.stringify(message));
    logger.debug('Subscribed to order book', { conditionId, tokenId });

    const subs = this.subscriptions.get('book') || new Set();
    subs.add(`${conditionId}:${tokenId}`);
    this.subscriptions.set('book', subs);
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
    for (const [channel, subs] of this.subscriptions) {
      for (const sub of subs) {
        if (channel === 'market' || channel === 'book') {
          const [conditionId, tokenId] = sub.split(':');
          if (channel === 'market') {
            this.subscribeToMarket(conditionId, [tokenId]);
          } else {
            this.subscribeToOrderBook(conditionId, tokenId);
          }
        } else if (channel === 'user') {
          this.subscribeToUser();
        }
      }
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

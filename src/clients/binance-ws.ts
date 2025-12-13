/**
 * Binance WebSocket Client
 * Fallback price feed for real-time crypto prices
 *
 * Supports proxy connections for geo-restricted regions:
 * - HTTP/HTTPS proxies: http://host:port, https://host:port
 * - SOCKS proxies: socks4://host:port, socks5://user:pass@host:port
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { CryptoAsset, PricePoint, CryptoPriceData } from '../types/index.js';
import logger, { logWsEvent, logPrice } from '../utils/logger.js';
import { BINANCE_SYMBOLS } from '../config.js';
import { sleep } from '../utils/helpers.js';

interface BinanceAggTrade {
  e: string;      // Event type
  E: number;      // Event time
  s: string;      // Symbol
  a: number;      // Aggregate trade ID
  p: string;      // Price
  q: string;      // Quantity
  f: number;      // First trade ID
  l: number;      // Last trade ID
  T: number;      // Trade time
  m: boolean;     // Is buyer market maker
}

export class BinanceWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private proxyUrl: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;
  private pingInterval: NodeJS.Timeout | null = null;

  // Price data storage - last 60 seconds of prices per asset
  private priceData: Map<CryptoAsset, CryptoPriceData> = new Map();
  private maxHistoryLength: number = 600; // 10 minutes of 1-second data

  constructor(baseUrl: string = 'wss://stream.binance.com:9443/ws', proxyUrl?: string) {
    super();
    this.baseUrl = baseUrl;
    this.proxyUrl = proxyUrl;
    this.initializePriceData();

    if (proxyUrl) {
      logger.info('Binance WebSocket proxy configured', { proxyUrl: proxyUrl.replace(/:[^:@]+@/, ':***@') });
    }
  }

  /**
   * Create proxy agent based on proxy URL scheme
   */
  private createProxyAgent(): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
    if (!this.proxyUrl) return undefined;

    const proxyLower = this.proxyUrl.toLowerCase();

    if (proxyLower.startsWith('socks4://') || proxyLower.startsWith('socks5://') || proxyLower.startsWith('socks://')) {
      logger.debug('Using SOCKS proxy agent');
      return new SocksProxyAgent(this.proxyUrl);
    } else if (proxyLower.startsWith('http://') || proxyLower.startsWith('https://')) {
      logger.debug('Using HTTPS proxy agent');
      return new HttpsProxyAgent(this.proxyUrl);
    } else {
      logger.warn('Unknown proxy scheme, attempting as HTTP proxy', { proxyUrl: this.proxyUrl });
      return new HttpsProxyAgent(this.proxyUrl);
    }
  }

  /**
   * Initialize price data structures for all supported assets
   */
  private initializePriceData(): void {
    const assets: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP'];
    for (const asset of assets) {
      this.priceData.set(asset, {
        asset,
        price: 0,
        timestamp: 0,
        source: 'binance',
        priceHistory: [],
      });
    }
  }

  /**
   * Connect to Binance WebSocket
   */
  public async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    // Build combined stream URL
    const streams = Object.values(BINANCE_SYMBOLS).map(s => `${s}@aggTrade`).join('/');
    const url = `${this.baseUrl}/${streams}`;

    return new Promise((resolve, reject) => {
      try {
        // Create proxy agent if configured
        const agent = this.createProxyAgent();
        const wsOptions = agent ? { agent } : undefined;

        logger.debug('Connecting to Binance WebSocket', {
          url,
          usingProxy: !!agent,
        });

        this.ws = new WebSocket(url, wsOptions);

        this.ws.on('open', () => {
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          logWsEvent('connected', 'Binance');
          this.startPingInterval();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error: Error) => {
          logger.error('Binance WebSocket error', { error: error.message });
          this.emit('error', error);
          if (this.isConnecting) {
            reject(error);
          }
        });

        this.ws.on('close', (code: number) => {
          this.isConnecting = false;
          logWsEvent('disconnected', 'Binance', `Code: ${code}`);
          this.stopPingInterval();
          this.emit('disconnected');

          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('ping', () => {
          this.ws?.pong();
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
      const message = JSON.parse(data.toString()) as BinanceAggTrade;

      if (message.e === 'aggTrade') {
        this.handleTrade(message);
      }
    } catch (error) {
      logger.error('Error parsing Binance message', { error: (error as Error).message });
    }
  }

  /**
   * Handle trade update
   */
  private handleTrade(trade: BinanceAggTrade): void {
    const asset = this.symbolToAsset(trade.s);
    if (!asset) return;

    const price = parseFloat(trade.p);
    const timestamp = trade.T || trade.E;

    const pricePoint: PricePoint = {
      price,
      timestamp,
    };

    const data = this.priceData.get(asset)!;
    data.price = price;
    data.timestamp = timestamp;
    data.priceHistory.push(pricePoint);

    // Trim history to max length
    if (data.priceHistory.length > this.maxHistoryLength) {
      data.priceHistory = data.priceHistory.slice(-this.maxHistoryLength);
    }

    // Emit price update event
    this.emit('price', asset, price, timestamp);
    logPrice(asset, price, 'binance');
  }

  /**
   * Convert Binance symbol to asset
   */
  private symbolToAsset(symbol: string): CryptoAsset | null {
    const upperSymbol = symbol.toUpperCase();
    if (upperSymbol.startsWith('BTC')) return 'BTC';
    if (upperSymbol.startsWith('ETH')) return 'ETH';
    if (upperSymbol.startsWith('SOL')) return 'SOL';
    if (upperSymbol.startsWith('XRP')) return 'XRP';
    return null;
  }

  /**
   * Get current price for an asset
   */
  public getPrice(asset: CryptoAsset): number {
    return this.priceData.get(asset)?.price || 0;
  }

  /**
   * Get price data for an asset
   */
  public getPriceData(asset: CryptoAsset): CryptoPriceData | undefined {
    return this.priceData.get(asset);
  }

  /**
   * Get price history for an asset
   */
  public getPriceHistory(asset: CryptoAsset): PricePoint[] {
    return this.priceData.get(asset)?.priceHistory || [];
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000); // Ping every 30 seconds
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
   * Schedule a reconnection attempt
   */
  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max Binance reconnection attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const cappedDelay = Math.min(delay, 30000); // Cap at 30 seconds

    logWsEvent('reconnecting', 'Binance', `Attempt ${this.reconnectAttempts} in ${cappedDelay}ms`);

    await sleep(cappedDelay);

    if (this.shouldReconnect) {
      try {
        await this.connect();
      } catch (error) {
        logger.error('Binance reconnection failed', { error: (error as Error).message });
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

    logWsEvent('disconnected', 'Binance', 'Manual disconnect');
  }
}

export default BinanceWebSocketClient;

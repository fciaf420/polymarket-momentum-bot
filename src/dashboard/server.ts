/**
 * Dashboard Server
 * Express + WebSocket server for real-time dashboard
 */

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { createServer, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import type { Config } from '../types/index.js';
import type { MomentumLagStrategy } from '../strategy.js';
import type { RiskManager } from '../risk-manager.js';
import { DashboardStateAggregator } from './state.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WSMessage {
  type: string;
  data?: unknown;
  timestamp: number;
}

export class DashboardServer {
  private app: Express;
  private httpServer: HttpServer;
  private wss: WebSocketServer;
  private stateAggregator: DashboardStateAggregator;
  private config: Config;
  private strategy: MomentumLagStrategy;
  private clients: Set<WebSocket> = new Set();
  private priceUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private _orderbookUpdateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    strategy: MomentumLagStrategy,
    riskManager: RiskManager,
    config: Config
  ) {
    this.config = config;
    this.strategy = strategy;
    this.stateAggregator = new DashboardStateAggregator(strategy, riskManager, config);

    // Create Express app
    this.app = express();
    this.app.use(cors());
    this.app.use(express.json());

    // Create HTTP server
    this.httpServer = createServer(this.app);

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

    // Setup routes and WebSocket handlers
    this.setupRoutes();
    this.setupWebSocket();
    this.setupStrategyListeners();
  }

  /**
   * Setup REST API routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // Get bot status
    this.app.get('/api/status', (_req: Request, res: Response) => {
      const state = this.stateAggregator.getState();
      res.json(state.status);
    });

    // Get account info
    this.app.get('/api/account', (_req: Request, res: Response) => {
      const state = this.stateAggregator.getState();
      res.json(state.account);
    });

    // Get positions
    this.app.get('/api/positions', (_req: Request, res: Response) => {
      const positions = this.stateAggregator.getPositions();
      res.json(positions);
    });

    // Get signals
    this.app.get('/api/signals', (req: Request, res: Response) => {
      const limit = parseInt(req.query.limit as string) || 50;
      const signals = this.stateAggregator.getSignals(limit);
      res.json(signals);
    });

    // Get trade history
    this.app.get('/api/trades', (req: Request, res: Response) => {
      const limit = parseInt(req.query.limit as string) || 100;
      const trades = this.stateAggregator.getTradeHistory(limit);
      res.json({ trades, total: trades.length });
    });

    // Get trade summary
    this.app.get('/api/trades/summary', (_req: Request, res: Response) => {
      const state = this.stateAggregator.getState();
      res.json(state.trades.summary);
    });

    // Get risk metrics
    this.app.get('/api/risk/metrics', (_req: Request, res: Response) => {
      const state = this.stateAggregator.getState();
      res.json(state.risk.metrics);
    });

    // Get risk limits
    this.app.get('/api/risk/limits', (_req: Request, res: Response) => {
      const state = this.stateAggregator.getState();
      res.json(state.risk.limits);
    });

    // Get prices
    this.app.get('/api/prices', (_req: Request, res: Response) => {
      const state = this.stateAggregator.getState();
      res.json(state.prices);
    });

    // Get markets
    this.app.get('/api/markets', (_req: Request, res: Response) => {
      const state = this.stateAggregator.getState();
      res.json(state.markets);
    });

    // Get config (sanitized)
    this.app.get('/api/config', (_req: Request, res: Response) => {
      const config = this.stateAggregator.getSanitizedConfig();
      res.json(config);
    });

    // Update config
    this.app.post('/api/config', (req: Request, res: Response) => {
      try {
        const updates = req.body as Partial<{
          positionSizePct: number;
          gapThreshold: number;
          moveThreshold: number;
          maxPositions: number;
          minLiquidity: number;
          maxHoldMinutes: number;
          exitGapThreshold: number;
          maxDrawdown: number;
          maxEntrySlippage: number;
        }>;

        // Validate updates
        const errors: string[] = [];
        if (updates.positionSizePct !== undefined && (updates.positionSizePct <= 0 || updates.positionSizePct > 1)) {
          errors.push('positionSizePct must be between 0 and 1');
        }
        if (updates.gapThreshold !== undefined && (updates.gapThreshold <= 0 || updates.gapThreshold > 1)) {
          errors.push('gapThreshold must be between 0 and 1');
        }
        if (updates.moveThreshold !== undefined && (updates.moveThreshold <= 0 || updates.moveThreshold > 1)) {
          errors.push('moveThreshold must be between 0 and 1');
        }
        if (updates.maxPositions !== undefined && (updates.maxPositions < 1 || updates.maxPositions > 10)) {
          errors.push('maxPositions must be between 1 and 10');
        }
        if (updates.minLiquidity !== undefined && updates.minLiquidity < 0) {
          errors.push('minLiquidity must be positive');
        }
        if (updates.maxHoldMinutes !== undefined && (updates.maxHoldMinutes < 1 || updates.maxHoldMinutes > 14)) {
          errors.push('maxHoldMinutes must be between 1 and 14');
        }
        if (updates.exitGapThreshold !== undefined && (updates.exitGapThreshold <= 0 || updates.exitGapThreshold > 1)) {
          errors.push('exitGapThreshold must be between 0 and 1');
        }
        if (updates.maxDrawdown !== undefined && (updates.maxDrawdown <= 0 || updates.maxDrawdown > 1)) {
          errors.push('maxDrawdown must be between 0 and 1');
        }
        if (updates.maxEntrySlippage !== undefined && (updates.maxEntrySlippage < 0 || updates.maxEntrySlippage > 1)) {
          errors.push('maxEntrySlippage must be between 0 and 1');
        }

        if (errors.length > 0) {
          res.status(400).json({ success: false, errors });
          return;
        }

        // Update runtime config
        if (updates.positionSizePct !== undefined) this.config.positionSizePct = updates.positionSizePct;
        if (updates.gapThreshold !== undefined) this.config.gapThreshold = updates.gapThreshold;
        if (updates.moveThreshold !== undefined) this.config.moveThreshold = updates.moveThreshold;
        if (updates.maxPositions !== undefined) this.config.maxPositions = updates.maxPositions;
        if (updates.minLiquidity !== undefined) this.config.minLiquidity = updates.minLiquidity;
        if (updates.maxHoldMinutes !== undefined) this.config.maxHoldMinutes = updates.maxHoldMinutes;
        if (updates.exitGapThreshold !== undefined) this.config.exitGapThreshold = updates.exitGapThreshold;
        if (updates.maxDrawdown !== undefined) this.config.maxDrawdown = updates.maxDrawdown;
        if (updates.maxEntrySlippage !== undefined) this.config.maxEntrySlippage = updates.maxEntrySlippage;

        // Update .env file
        this.updateEnvFile(updates);

        // Broadcast config update to all clients
        const newConfig = this.stateAggregator.getSanitizedConfig();
        this.broadcast({ type: 'config_updated', data: newConfig, timestamp: Date.now() });

        logger.info('Config updated from dashboard', { updates });
        res.json({ success: true, config: newConfig });
      } catch (error) {
        logger.error('Failed to update config', { error: (error as Error).message });
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });

    // Get full state
    this.app.get('/api/state', (_req: Request, res: Response) => {
      const state = this.stateAggregator.getState();
      res.json(state);
    });

    // Control: Pause
    this.app.post('/api/control/pause', (req: Request, res: Response) => {
      const reason = req.body?.reason as string | undefined;
      this.stateAggregator.pause(reason);
      res.json({ success: true, paused: true });
    });

    // Control: Resume
    this.app.post('/api/control/resume', (_req: Request, res: Response) => {
      this.stateAggregator.resume();
      res.json({ success: true, paused: false });
    });

    // Get on-chain data (balance and positions from blockchain)
    this.app.get('/api/onchain', async (_req: Request, res: Response) => {
      try {
        const onchainData = await this.strategy.getOnChainData();
        res.json(onchainData);
      } catch (error) {
        logger.error('Failed to fetch on-chain data', { error: (error as Error).message });
        res.status(500).json({
          error: (error as Error).message,
          balance: 0,
          positions: [],
          timestamp: Date.now(),
          source: 'error'
        });
      }
    });

    // Get orderbooks for all active markets
    this.app.get('/api/orderbooks', async (_req: Request, res: Response) => {
      try {
        const orderbooks = await this.strategy.getOrderbooks();
        res.json({ orderbooks, timestamp: Date.now() });
      } catch (error) {
        logger.error('Failed to fetch orderbooks', { error: (error as Error).message });
        res.status(500).json({
          error: (error as Error).message,
          orderbooks: [],
          timestamp: Date.now(),
        });
      }
    });

    // Serve static files in production
    const dashboardBuildPath = path.join(__dirname, '../../dashboard/dist');
    this.app.use(express.static(dashboardBuildPath));

    // SPA fallback (Express 5 syntax)
    this.app.get('/{*path}', (_req: Request, res: Response) => {
      res.sendFile(path.join(dashboardBuildPath, 'index.html'));
    });
  }

  /**
   * Setup WebSocket server
   */
  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      logger.info('Dashboard client connected', { clients: this.clients.size });

      // Send initial state
      const state = this.stateAggregator.getState();
      this.sendToClient(ws, { type: 'initial_state', data: state, timestamp: Date.now() });

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as WSMessage;
          this.handleClientMessage(ws, message);
        } catch (error) {
          logger.debug('Invalid WebSocket message', { error: (error as Error).message });
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('Dashboard client disconnected', { clients: this.clients.size });
      });

      ws.on('error', (error) => {
        logger.debug('WebSocket error', { error: error.message });
        this.clients.delete(ws);
      });
    });

    // Start price update broadcasts
    this.startPriceUpdates();
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleClientMessage(ws: WebSocket, message: WSMessage): void {
    switch (message.type) {
      case 'ping':
        this.sendToClient(ws, { type: 'pong', timestamp: Date.now() });
        break;
      case 'get_state':
        const state = this.stateAggregator.getState();
        this.sendToClient(ws, { type: 'state', data: state, timestamp: Date.now() });
        break;
      case 'get_orderbooks':
        this.strategy.getOrderbooks().then(orderbooks => {
          this.sendToClient(ws, { type: 'orderbooks', data: orderbooks, timestamp: Date.now() });
        }).catch(() => {
          this.sendToClient(ws, { type: 'orderbooks', data: [], timestamp: Date.now() });
        });
        break;
      case 'subscribe_orderbooks':
        // Client wants orderbook updates - will receive via broadcast
        this.sendToClient(ws, { type: 'orderbooks_subscribed', timestamp: Date.now() });
        break;
      default:
        break;
    }
  }

  /**
   * Setup strategy event listeners
   */
  private setupStrategyListeners(): void {
    this.strategy.on('positionOpened', (position) => {
      // Transform position to frontend format
      const frontendPosition = this.transformPosition(position);
      this.broadcast({ type: 'position_opened', data: frontendPosition, timestamp: Date.now() });
    });

    this.strategy.on('positionClosed', (position) => {
      // Transform position to frontend format
      const frontendPosition = this.transformPosition(position);
      this.broadcast({ type: 'position_closed', data: frontendPosition, timestamp: Date.now() });
    });

    // Listen for signal events (if strategy emits them)
    this.strategy.on('signalDetected', (signal) => {
      // Transform signal to frontend format
      const frontendSignal = this.transformSignal(signal);
      this.broadcast({ type: 'signal_detected', data: frontendSignal, timestamp: Date.now() });
    });
  }

  /**
   * Transform backend Signal to frontend Signal format
   */
  private transformSignal(signal: any): any {
    return {
      id: signal.id,
      asset: signal.asset,
      direction: signal.suggestedSide?.toLowerCase() || signal.priceMove?.direction || 'up',
      gap: signal.gapPercent || 0,
      cryptoPrice: signal.priceMove?.endPrice || 0,
      impliedPrice: signal.entryPrice || 0,
      confidence: signal.confidence || 0,
      timestamp: signal.timestamp || Date.now(),
      executed: true, // If we're emitting signalDetected, it's being executed
      executionReason: signal.reason,
    };
  }

  /**
   * Transform backend Position to frontend Position format
   */
  private transformPosition(position: any): any {
    return {
      id: position.id,
      signal: {
        asset: position.signal?.asset || position.market?.asset || 'BTC',
        direction: position.signal?.suggestedSide?.toLowerCase() || position.signal?.priceMove?.direction || 'up',
        gap: position.signal?.gapPercent || 0,
        confidence: position.signal?.confidence || 0,
      },
      side: position.side === 'UP' ? 'YES' : position.side === 'DOWN' ? 'NO' : position.side,
      entryPrice: position.entryPrice || 0,
      currentPrice: position.currentPrice || position.entryPrice || 0,
      size: position.size || 0,
      costBasis: position.costBasis || 0,
      currentValue: position.currentValue || position.costBasis || 0,
      unrealizedPnl: position.unrealizedPnl || 0,
      unrealizedPnlPercent: position.unrealizedPnlPercent || 0,
      entryTime: position.entryTimestamp || position.entryTime || Date.now(),
      exitPrice: position.exitPrice,
      realizedPnl: position.realizedPnl,
      exitReason: position.exitReason,
    };
  }

  /**
   * Start periodic price updates
   */
  private startPriceUpdates(): void {
    this.priceUpdateInterval = setInterval(() => {
      if (this.clients.size === 0) return;

      const state = this.stateAggregator.getState();
      this.broadcast({
        type: 'price_update',
        data: {
          status: state.status,
          connections: state.connections,
          crypto: state.prices.crypto,
          markets: state.prices.markets,
          activeMarkets: state.markets, // Include active markets array for UI
          positions: state.positions.map(p => ({
            id: p.id,
            currentPrice: p.currentPrice,
            currentValue: p.currentValue,
            unrealizedPnl: p.unrealizedPnl,
            unrealizedPnlPercent: p.unrealizedPnlPercent,
          })),
          account: {
            balance: state.account.balance,
            totalPnl: state.account.totalPnl,
            drawdown: state.account.currentDrawdown,
          },
          validation: state.validation,
          moveProgress: state.moveProgress,
        },
        timestamp: Date.now(),
      });
    }, 1000); // Update every second

    // Start orderbook updates (every 3 seconds to avoid API overload)
    this.startOrderbookUpdates();
  }

  /**
   * Start periodic orderbook updates
   */
  private startOrderbookUpdates(): void {
    this._orderbookUpdateInterval = setInterval(async () => {
      if (this.clients.size === 0) return;

      try {
        const orderbooks = await this.strategy.getOrderbooks();
        this.broadcast({
          type: 'orderbook_update',
          data: orderbooks,
          timestamp: Date.now(),
        });
      } catch (error) {
        // Silent fail - orderbooks are optional
      }
    }, 3000); // Update every 3 seconds
  }

  /**
   * Send message to specific client
   */
  private sendToClient(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast message to all clients
   */
  private broadcast(message: WSMessage): void {
    const payload = JSON.stringify(message);
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  /**
   * Start the server
   */
  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.dashboardPort, () => {
        logger.info('Dashboard server started', {
          port: this.config.dashboardPort,
          url: `http://localhost:${this.config.dashboardPort}`,
        });
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.priceUpdateInterval) {
        clearInterval(this.priceUpdateInterval);
      }
      if (this._orderbookUpdateInterval) {
        clearInterval(this._orderbookUpdateInterval);
      }

      // Close all WebSocket connections
      this.clients.forEach((client) => {
        client.close();
      });
      this.clients.clear();

      this.wss.close();
      this.httpServer.close(() => {
        logger.info('Dashboard server stopped');
        resolve();
      });
    });
  }

  /**
   * Update .env file with new config values
   */
  private updateEnvFile(updates: Record<string, unknown>): void {
    const envPath = path.join(process.cwd(), '.env');

    if (!fs.existsSync(envPath)) {
      logger.warn('.env file not found, skipping file update');
      return;
    }

    let envContent = fs.readFileSync(envPath, 'utf-8');

    // Map config keys to env variable names
    const keyMap: Record<string, string> = {
      positionSizePct: 'POSITION_SIZE_PCT',
      gapThreshold: 'GAP_THRESHOLD',
      moveThreshold: 'MOVE_THRESHOLD',
      maxPositions: 'MAX_POSITIONS',
      minLiquidity: 'MIN_LIQUIDITY',
      maxHoldMinutes: 'MAX_HOLD_MINUTES',
      exitGapThreshold: 'EXIT_GAP_THRESHOLD',
      maxDrawdown: 'MAX_DRAWDOWN',
      maxEntrySlippage: 'MAX_ENTRY_SLIPPAGE',
    };

    for (const [key, value] of Object.entries(updates)) {
      const envKey = keyMap[key];
      if (!envKey) continue;

      // Regex to match the line with this key
      const regex = new RegExp(`^${envKey}=.*$`, 'm');
      const newLine = `${envKey}=${value}`;

      if (regex.test(envContent)) {
        // Replace existing line
        envContent = envContent.replace(regex, newLine);
      } else {
        // Append new line
        envContent += `\n${newLine}`;
      }
    }

    fs.writeFileSync(envPath, envContent, 'utf-8');
    logger.info('.env file updated', { updates: Object.keys(updates) });
  }
}

export default DashboardServer;

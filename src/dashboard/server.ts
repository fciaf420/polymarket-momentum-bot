/**
 * Dashboard Server
 * Express + WebSocket server for real-time dashboard
 */

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { createServer, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
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
      default:
        break;
    }
  }

  /**
   * Setup strategy event listeners
   */
  private setupStrategyListeners(): void {
    this.strategy.on('positionOpened', (position) => {
      this.broadcast({ type: 'position_opened', data: position, timestamp: Date.now() });
    });

    this.strategy.on('positionClosed', (position) => {
      this.broadcast({ type: 'position_closed', data: position, timestamp: Date.now() });
    });

    // Listen for signal events (if strategy emits them)
    this.strategy.on('signalDetected', (signal) => {
      this.broadcast({ type: 'signal_detected', data: signal, timestamp: Date.now() });
    });
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
        },
        timestamp: Date.now(),
      });
    }, 1000); // Update every second
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
}

export default DashboardServer;

/**
 * Winston Logger Configuration
 * Provides structured logging with multiple transports
 */

import winston from 'winston';
import path from 'path';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  let msg = `${timestamp} [${level}]: ${message}`;

  // Append metadata if present
  if (Object.keys(meta).length > 0) {
    // Handle error stack traces
    if (meta.stack) {
      msg += `\n${meta.stack}`;
    } else {
      msg += ` ${JSON.stringify(meta)}`;
    }
  }

  return msg;
});

// Create the logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    logFormat
  ),
  defaultMeta: { service: 'polymarket-bot' },
  transports: [
    // Console transport with colors
    new winston.transports.Console({
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        logFormat
      ),
    }),
    // File transport for errors
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 10,
    }),
  ],
});

// Create logs directory if it doesn't exist
import fs from 'fs';
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Log a trading signal
 */
export function logSignal(signal: {
  asset: string;
  direction: string;
  gap: number;
  confidence: number;
  market: string;
}): void {
  logger.info('Signal detected', {
    asset: signal.asset,
    direction: signal.direction,
    gap: `${(signal.gap * 100).toFixed(2)}%`,
    confidence: `${(signal.confidence * 100).toFixed(1)}%`,
    market: signal.market,
  });
}

/**
 * Log a trade execution
 */
export function logTrade(trade: {
  action: 'ENTRY' | 'EXIT';
  asset: string;
  side: string;
  price: number;
  size: number;
  pnl?: number;
}): void {
  const emoji = trade.action === 'ENTRY' ? '>>>' : '<<<';
  const pnlStr = trade.pnl !== undefined ? ` | PnL: ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)} USDC` : '';

  logger.info(`${emoji} ${trade.action} ${trade.asset} ${trade.side}`, {
    price: trade.price.toFixed(4),
    size: trade.size.toFixed(2),
    ...(trade.pnl !== undefined && { pnl: trade.pnl.toFixed(2) }),
  });
}

/**
 * Log price update
 */
export function logPrice(asset: string, price: number, source: string): void {
  logger.debug(`Price update: ${asset}`, {
    price: price.toFixed(2),
    source,
  });
}

/**
 * Log position status
 */
export function logPosition(position: {
  asset: string;
  side: string;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  holdTime: number;
}): void {
  logger.info('Position status', {
    asset: position.asset,
    side: position.side,
    entry: position.entryPrice.toFixed(4),
    current: position.currentPrice.toFixed(4),
    pnl: `${position.unrealizedPnl >= 0 ? '+' : ''}${position.unrealizedPnl.toFixed(2)} USDC`,
    holdTime: `${position.holdTime.toFixed(1)} min`,
  });
}

/**
 * Log WebSocket connection events
 */
export function logWsEvent(event: 'connected' | 'disconnected' | 'reconnecting' | 'error', source: string, details?: string): void {
  const level = event === 'error' ? 'error' : 'info';
  logger[level](`WebSocket ${event}: ${source}${details ? ` - ${details}` : ''}`);
}

/**
 * Log risk management events
 */
export function logRisk(event: string, details: Record<string, unknown>): void {
  logger.warn(`Risk: ${event}`, details);
}

/**
 * Log market discovery
 */
export function logMarket(action: 'discovered' | 'expired' | 'filtered', market: string, reason?: string): void {
  logger.info(`Market ${action}: ${market}${reason ? ` (${reason})` : ''}`);
}

export default logger;

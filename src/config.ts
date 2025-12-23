/**
 * Configuration Management
 * Loads and validates environment variables for the trading bot
 */

import dotenv from 'dotenv';
import type { Config } from './types/index.js';

// Load environment variables from .env file
dotenv.config();

/**
 * Get a required environment variable or throw an error
 */
function getRequired(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Get an optional environment variable with a default value
 */
function getOptional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Parse a boolean environment variable
 */
function parseBoolean(value: string): boolean {
  return value.toLowerCase() === 'true';
}

/**
 * Parse a number environment variable
 */
function parseNumber(value: string): number {
  const num = parseFloat(value);
  if (isNaN(num)) {
    throw new Error(`Invalid number value: ${value}`);
  }
  return num;
}

/**
 * Validate configuration values
 */
function validateConfig(config: Config): void {
  // Validate private key format
  if (!/^[a-fA-F0-9]{64}$/.test(config.privateKey.replace('0x', ''))) {
    throw new Error('Invalid private key format. Must be 64 hex characters.');
  }

  // Validate percentages are within bounds
  if (config.positionSizePct <= 0 || config.positionSizePct > 1) {
    throw new Error('POSITION_SIZE_PCT must be between 0 and 1');
  }

  if (config.gapThreshold <= 0 || config.gapThreshold > 1) {
    throw new Error('GAP_THRESHOLD must be between 0 and 1');
  }

  if (config.moveThreshold <= 0 || config.moveThreshold > 1) {
    throw new Error('MOVE_THRESHOLD must be between 0 and 1');
  }

  if (config.maxDrawdown <= 0 || config.maxDrawdown > 1) {
    throw new Error('MAX_DRAWDOWN must be between 0 and 1');
  }

  // Validate positive numbers
  if (config.maxPositions < 1) {
    throw new Error('MAX_POSITIONS must be at least 1');
  }

  if (config.minLiquidity < 0) {
    throw new Error('MIN_LIQUIDITY must be non-negative');
  }

  if (config.maxHoldMinutes < 1) {
    throw new Error('MAX_HOLD_MINUTES must be at least 1');
  }

  // Validate chain ID
  if (config.chainId !== 137 && config.chainId !== 80002) {
    throw new Error('CHAIN_ID must be 137 (Polygon Mainnet) or 80002 (Amoy Testnet)');
  }
}

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  const config: Config = {
    // Wallet - private key without 0x prefix
    privateKey: getRequired('PRIVATE_KEY').replace('0x', ''),
    // Polymarket Safe/proxy wallet (optional - uses EOA if not set)
    polymarketWallet: process.env.POLYMARKET_WALLET || undefined,

    // Polymarket
    host: getOptional('HOST', 'https://clob.polymarket.com'),
    chainId: parseNumber(getOptional('CHAIN_ID', '137')),
    wsRtdsUrl: getOptional('WS_RTDS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),
    wsUserUrl: getOptional('WS_USER_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/user'),

    // Strategy
    positionSizePct: parseNumber(getOptional('POSITION_SIZE_PCT', '0.02')),
    gapThreshold: parseNumber(getOptional('GAP_THRESHOLD', '0.03')),
    moveThreshold: parseNumber(getOptional('MOVE_THRESHOLD', '0.02')),
    maxPositions: parseNumber(getOptional('MAX_POSITIONS', '3')),
    minLiquidity: parseNumber(getOptional('MIN_LIQUIDITY', '1000')),
    maxHoldMinutes: parseNumber(getOptional('MAX_HOLD_MINUTES', '12')),
    exitGapThreshold: parseNumber(getOptional('EXIT_GAP_THRESHOLD', '0.01')),
    maxTradeUsd: parseNumber(getOptional('MAX_TRADE_USD', '1.05')), // $1.05 to avoid precision errors (CLOB min is $1)
    maxEntrySlippage: parseNumber(getOptional('MAX_ENTRY_SLIPPAGE', '0.15')), // 15% max slippage above signal price

    // Risk
    maxDrawdown: parseNumber(getOptional('MAX_DRAWDOWN', '0.10')),
    stopLossPct: parseNumber(getOptional('STOP_LOSS_PCT', '0')),

    // Volatility
    bbPeriod: parseNumber(getOptional('BB_PERIOD', '20')),
    bbStdDev: parseNumber(getOptional('BB_STD_DEV', '2')),
    volatilitySqueezeThreshold: parseNumber(getOptional('VOLATILITY_SQUEEZE_THRESHOLD', '0.005')),

    // Mode
    backtest: parseBoolean(getOptional('BACKTEST', 'true')),
    dryRun: parseBoolean(getOptional('DRY_RUN', 'true')),

    // Logging
    logLevel: getOptional('LOG_LEVEL', 'info'),
    tradeHistoryPath: getOptional('TRADE_HISTORY_PATH', './trades.csv'),

    // Binance
    binanceFallbackEnabled: parseBoolean(getOptional('BINANCE_FALLBACK_ENABLED', 'true')),
    binanceWsUrl: getOptional('BINANCE_WS_URL', 'wss://stream.binance.com:9443/ws'),

    // Proxy (for geo-restricted APIs like Binance)
    // Supports HTTP, HTTPS, SOCKS4, and SOCKS5 proxies
    // Examples: http://host:port, socks5://user:pass@host:port
    proxyUrl: process.env.PROXY_URL || undefined,

    // API credentials (optional, will be derived if not provided)
    apiKey: process.env.API_KEY || undefined,
    apiSecret: process.env.API_SECRET || undefined,
    apiPassphrase: process.env.API_PASSPHRASE || undefined,

    // Dashboard
    dashboardEnabled: parseBoolean(getOptional('DASHBOARD_ENABLED', 'true')),
    dashboardPort: parseNumber(getOptional('DASHBOARD_PORT', '3001')),
  };

  // Validate configuration
  validateConfig(config);

  return config;
}

/**
 * Get assets configuration
 */
export const SUPPORTED_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;

/**
 * Binance symbol mapping
 */
export const BINANCE_SYMBOLS: Record<string, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};

/**
 * Market keyword patterns for filtering 15-minute markets
 */
export const MARKET_PATTERNS = {
  timeframe: ['15min', '15-min', '15 min', '15m', '15 minute'],
  direction: ['up', 'down', 'higher', 'lower'],
  assets: ['BTC', 'Bitcoin', 'ETH', 'Ethereum', 'SOL', 'Solana', 'XRP'],
};

export default loadConfig;

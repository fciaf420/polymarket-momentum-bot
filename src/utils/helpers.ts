/**
 * Helper Utilities
 * Price normalization, retry logic, and general utilities
 */

import { v4 as uuidv4 } from 'uuid';
import type { CryptoMarket, MarketDirection } from '../types/index.js';
import logger from './logger.js';

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return uuidv4();
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    factor?: number;
    onRetry?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    onRetry,
  } = options;

  let lastError: Error;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        break;
      }

      if (onRetry) {
        onRetry(lastError, attempt);
      }

      logger.warn(`Retry attempt ${attempt}/${maxRetries} after ${delay}ms`, {
        error: lastError.message,
      });

      await sleep(delay);
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  throw lastError!;
}

/**
 * Normalize Polymarket share price to probability (0-1)
 * Polymarket prices are in cents (0-100 representing probability)
 */
export function normalizeSharePrice(price: number | string): number {
  const numPrice = typeof price === 'string' ? parseFloat(price) : price;

  // If price is already 0-1, return as is
  if (numPrice <= 1) {
    return numPrice;
  }

  // If price is 0-100 (cents), convert to 0-1
  if (numPrice <= 100) {
    return numPrice / 100;
  }

  // If price is in microdollars (1e6), convert to 0-1
  if (numPrice > 100) {
    return numPrice / 1e6;
  }

  return numPrice;
}

/**
 * Convert probability to implied price
 */
export function probabilityToPrice(probability: number): number {
  // Probability should be 0-1
  return probability;
}

/**
 * Calculate the gap between crypto price direction and market implied probability
 * Returns positive gap if there's a discrepancy worth exploiting
 *
 * The gap represents the mispricing: when crypto moves, the market prices
 * should adjust quickly. If they lag, we can exploit the difference.
 *
 * @param cryptoMovePercent - The percentage move in crypto price (e.g., 0.001 = 0.1%)
 * @param upImpliedProb - Current UP market probability (0-1)
 * @param downImpliedProb - Current DOWN market probability (0-1)
 * @param moveThreshold - Minimum move to consider (from MOVE_THRESHOLD env, e.g., 0.001 = 0.1%)
 */
export function calculatePriceGap(
  cryptoMovePercent: number,
  upImpliedProb: number,
  downImpliedProb: number,
  moveThreshold: number
): { gap: number; direction: MarketDirection; tokenSide: 'up' | 'down' } {
  // If crypto moved up, "Up" shares should be expensive, "Down" cheap
  // If crypto moved down, "Down" shares should be expensive, "Up" cheap

  const absMove = Math.abs(cryptoMovePercent);

  if (cryptoMovePercent > moveThreshold) {
    // Crypto went up significantly - "Up" shares should be expensive (> 0.55)
    // If "Up" is still cheap (near 0.5), there's a lag - buy UP shares
    const expectedUpPrice = Math.min(0.5 + absMove * 5, 0.95);
    const gap = expectedUpPrice - upImpliedProb;

    // Return positive gap (let config.gapThreshold filter in strategy)
    if (gap > 0) {
      return {
        gap,
        direction: 'UP',
        tokenSide: 'up', // Buy "Up" shares which are underpriced
      };
    }
  } else if (cryptoMovePercent < -moveThreshold) {
    // Crypto went down significantly - "Down" shares should be expensive
    // If "Down" is still cheap (near 0.5), there's a lag - buy DOWN shares
    const expectedDownPrice = Math.min(0.5 + absMove * 5, 0.95);
    const gap = expectedDownPrice - downImpliedProb;

    // Return positive gap (let config.gapThreshold filter in strategy)
    if (gap > 0) {
      return {
        gap,
        direction: 'DOWN',
        tokenSide: 'down', // Buy "Down" shares which are underpriced
      };
    }
  }

  return { gap: 0, direction: 'UP', tokenSide: 'up' };
}

/**
 * Check if a market is still tradeable (not expired, not closed)
 * Note: Market parsing is now handled in MarketDiscoveryClient
 */
export function isMarketTradeable(market: CryptoMarket): boolean {
  const now = Date.now();
  const expiryBuffer = 60 * 1000; // 1 minute buffer before expiry

  return (
    market.active &&
    !market.closed &&
    market.enableOrderBook &&
    market.expiryTime.getTime() - now > expiryBuffer &&
    market.upTokenId !== '' &&
    market.downTokenId !== ''
  );
}

/**
 * Calculate time remaining until market expiry
 */
export function getTimeToExpiry(market: CryptoMarket): number {
  return Math.max(0, market.expiryTime.getTime() - Date.now());
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Format currency value
 */
export function formatCurrency(value: number, decimals: number = 2): string {
  return `$${value.toFixed(decimals)}`;
}

/**
 * Format percentage
 */
export function formatPercent(value: number, decimals: number = 2): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Throttle function calls
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return function (this: unknown, ...args: Parameters<T>): void {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * Debounce function calls
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function (this: unknown, ...args: Parameters<T>): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      fn.apply(this, args);
    }, delay);
  };
}

/**
 * Clamp a number between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate percentage change
 */
export function percentChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  return (newValue - oldValue) / oldValue;
}

/**
 * Round to specified decimal places
 */
export function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

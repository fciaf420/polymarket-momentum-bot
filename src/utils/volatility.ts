/**
 * Volatility Calculation Utilities
 * Implements Bollinger Bands and volatility metrics for momentum detection
 */

import { BollingerBands, StandardDeviation, SMA } from 'technicalindicators';
import type { VolatilityMetrics, PricePoint, PriceMove, CryptoAsset } from '../types/index.js';

/**
 * Calculate Bollinger Bands for a price series
 */
export function calculateBollingerBands(
  prices: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: number; middle: number; lower: number; width: number } | null {
  if (prices.length < period) {
    return null;
  }

  const result = BollingerBands.calculate({
    period,
    values: prices,
    stdDev,
  });

  if (result.length === 0) {
    return null;
  }

  const latest = result[result.length - 1];
  const width = (latest.upper - latest.lower) / latest.middle;

  return {
    upper: latest.upper,
    middle: latest.middle,
    lower: latest.lower,
    width,
  };
}

/**
 * Calculate standard deviation for a price series
 */
export function calculateStandardDeviation(prices: number[], period: number = 20): number | null {
  if (prices.length < period) {
    return null;
  }

  const result = StandardDeviation.calculate({
    period,
    values: prices,
  });

  return result.length > 0 ? result[result.length - 1] : null;
}

/**
 * Calculate volatility metrics for a price series
 */
export function calculateVolatilityMetrics(
  prices: number[],
  period: number = 20,
  stdDevMultiplier: number = 2,
  squeezeThreshold: number = 0.005
): VolatilityMetrics | null {
  const bb = calculateBollingerBands(prices, period, stdDevMultiplier);
  if (!bb) {
    return null;
  }

  // Calculate percentage standard deviation (normalized by price)
  const stdDev = calculateStandardDeviation(prices, period);
  if (stdDev === null) {
    return null;
  }

  const avgPrice = prices.slice(-period).reduce((a, b) => a + b, 0) / period;
  const normalizedStdDev = stdDev / avgPrice;

  return {
    standardDeviation: normalizedStdDev,
    bollingerBandWidth: bb.width,
    upperBand: bb.upper,
    lowerBand: bb.lower,
    middleBand: bb.middle,
    isSqueezing: normalizedStdDev < squeezeThreshold,
  };
}

/**
 * Detect a hard directional move in price
 * A hard move is defined as >threshold% move in <1 minute with low volatility leading in
 */
export function detectHardMove(
  priceHistory: PricePoint[],
  asset: CryptoAsset,
  moveThreshold: number = 0.02,
  maxDurationSeconds: number = 60,
  volatilityLookback: number = 20
): PriceMove | null {
  if (priceHistory.length < 2) {
    return null;
  }

  const now = Date.now();
  const recentPrices = priceHistory.filter(p => now - p.timestamp <= maxDurationSeconds * 1000);

  if (recentPrices.length < 2) {
    return null;
  }

  // Get oldest and newest prices in the time window
  const startPoint = recentPrices[0];
  const endPoint = recentPrices[recentPrices.length - 1];

  // Calculate percentage move
  const movePercent = (endPoint.price - startPoint.price) / startPoint.price;

  // Check if move exceeds threshold
  if (Math.abs(movePercent) < moveThreshold) {
    return null;
  }

  // Calculate volatility from prices before the move
  const beforeMovePrices = priceHistory
    .filter(p => p.timestamp < startPoint.timestamp)
    .slice(-volatilityLookback)
    .map(p => p.price);

  let volatilityBefore: VolatilityMetrics;

  if (beforeMovePrices.length >= volatilityLookback) {
    const metrics = calculateVolatilityMetrics(beforeMovePrices);
    if (!metrics) {
      // Default to non-squeezing if we can't calculate
      volatilityBefore = {
        standardDeviation: 0.01,
        bollingerBandWidth: 0.02,
        upperBand: 0,
        lowerBand: 0,
        middleBand: 0,
        isSqueezing: false,
      };
    } else {
      volatilityBefore = metrics;
    }
  } else {
    // Not enough history, assume moderate volatility
    volatilityBefore = {
      standardDeviation: 0.01,
      bollingerBandWidth: 0.02,
      upperBand: 0,
      lowerBand: 0,
      middleBand: 0,
      isSqueezing: false,
    };
  }

  const durationSeconds = (endPoint.timestamp - startPoint.timestamp) / 1000;

  return {
    asset,
    movePercent,
    direction: movePercent > 0 ? 'up' : 'down',
    durationSeconds,
    startPrice: startPoint.price,
    endPrice: endPoint.price,
    timestamp: endPoint.timestamp,
    volatilityBefore,
  };
}

/**
 * Calculate the rate of price change (velocity)
 */
export function calculatePriceVelocity(priceHistory: PricePoint[], periodSeconds: number = 10): number | null {
  const now = Date.now();
  const recentPrices = priceHistory.filter(p => now - p.timestamp <= periodSeconds * 1000);

  if (recentPrices.length < 2) {
    return null;
  }

  const startPrice = recentPrices[0].price;
  const endPrice = recentPrices[recentPrices.length - 1].price;
  const durationSeconds = (recentPrices[recentPrices.length - 1].timestamp - recentPrices[0].timestamp) / 1000;

  if (durationSeconds === 0) {
    return null;
  }

  // Return percentage change per second
  return ((endPrice - startPrice) / startPrice) / durationSeconds;
}

/**
 * Check if volatility is in a squeeze condition
 */
export function isVolatilitySqueeze(
  priceHistory: PricePoint[],
  period: number = 20,
  threshold: number = 0.005
): boolean {
  const prices = priceHistory.slice(-period * 2).map(p => p.price);
  const metrics = calculateVolatilityMetrics(prices, period, 2, threshold);
  return metrics?.isSqueezing ?? false;
}

/**
 * Calculate rolling average price
 */
export function calculateRollingAverage(priceHistory: PricePoint[], periodSeconds: number): number | null {
  const now = Date.now();
  const recentPrices = priceHistory.filter(p => now - p.timestamp <= periodSeconds * 1000);

  if (recentPrices.length === 0) {
    return null;
  }

  return recentPrices.reduce((sum, p) => sum + p.price, 0) / recentPrices.length;
}

/**
 * Calculate momentum score based on price action
 * Returns a value between -1 (strong downward) and 1 (strong upward)
 */
export function calculateMomentumScore(priceHistory: PricePoint[]): number {
  if (priceHistory.length < 10) {
    return 0;
  }

  const shortTerm = calculateRollingAverage(priceHistory, 10);
  const mediumTerm = calculateRollingAverage(priceHistory, 30);
  const longTerm = calculateRollingAverage(priceHistory, 60);

  if (!shortTerm || !mediumTerm || !longTerm) {
    return 0;
  }

  // Momentum based on moving average alignment
  const shortVsMedium = (shortTerm - mediumTerm) / mediumTerm;
  const mediumVsLong = (mediumTerm - longTerm) / longTerm;

  // Combine signals with short-term having more weight
  const momentum = shortVsMedium * 0.7 + mediumVsLong * 0.3;

  // Clamp to [-1, 1]
  return Math.max(-1, Math.min(1, momentum * 20));
}

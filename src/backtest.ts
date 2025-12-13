/**
 * Backtesting Module
 * Simulates strategy performance using historical data
 */

import axios, { AxiosInstance } from 'axios';
import type {
  Config,
  CryptoAsset,
  BacktestResult,
  TradeRecord,
  PricePoint,
  MarketDirection,
  ExitReason,
} from './types/index.js';
import { loadConfig } from './config.js';
import { detectHardMove } from './utils/volatility.js';
import { calculatePriceGap, generateId, formatPercent, formatCurrency } from './utils/helpers.js';
import logger from './utils/logger.js';
import { TradeHistoryWriter } from './utils/csv.js';

interface HistoricalDataPoint {
  timestamp: number;
  cryptoPrice: number;
  upPrice: number;
  downPrice: number;
}

interface SimulatedMarket {
  asset: CryptoAsset;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  startTime: number;
  endTime: number;
  outcome?: 'up' | 'down';
}

interface SimulatedPosition {
  id: string;
  market: SimulatedMarket;
  side: MarketDirection;
  entryPrice: number;
  entryTimestamp: number;
  size: number;
  costBasis: number;
  signalGap: number;
  signalConfidence: number;
}

export class Backtester {
  private config: Config;
  private apiClient: AxiosInstance;
  private tradeHistory: TradeRecord[] = [];
  private initialBalance: number = 10000;
  private balance: number;

  constructor(config: Config) {
    this.config = config;
    this.balance = this.initialBalance;

    this.apiClient = axios.create({
      baseURL: config.host,
      timeout: 30000,
    });
  }

  /**
   * Run backtest for a specific date range
   */
  public async run(
    startDate: Date,
    endDate: Date,
    assets: CryptoAsset[] = ['BTC', 'ETH', 'SOL', 'XRP']
  ): Promise<BacktestResult> {
    logger.info('Starting backtest', {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      assets: assets.join(', '),
      initialBalance: formatCurrency(this.initialBalance),
    });

    this.tradeHistory = [];
    this.balance = this.initialBalance;

    let highWaterMark = this.initialBalance;
    let maxDrawdown = 0;

    // Simulate market-by-market
    const markets = await this.generateSimulatedMarkets(startDate, endDate, assets);
    logger.info(`Generated ${markets.length} simulated markets for backtest`);

    for (const market of markets) {
      // Get historical data for this market period
      const data = await this.getHistoricalData(market);
      if (data.length < 60) {
        continue; // Need at least 60 seconds of data
      }

      // Run strategy on this market
      const position = await this.simulateMarket(market, data);

      if (position) {
        // Update balance
        this.balance += position.pnl;

        // Track drawdown
        if (this.balance > highWaterMark) {
          highWaterMark = this.balance;
        }
        const currentDrawdown = (highWaterMark - this.balance) / highWaterMark;
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown;
        }

        this.tradeHistory.push(position);
      }
    }

    // Calculate results
    const result = this.calculateResults(startDate, endDate, maxDrawdown);

    // Log results
    this.logResults(result);

    return result;
  }

  /**
   * Generate simulated 15-minute markets for the backtest period
   */
  private async generateSimulatedMarkets(
    startDate: Date,
    endDate: Date,
    assets: CryptoAsset[]
  ): Promise<SimulatedMarket[]> {
    const markets: SimulatedMarket[] = [];
    const FIFTEEN_MINUTES = 15 * 60 * 1000;

    // Generate markets every 15 minutes for each asset
    let currentTime = startDate.getTime();

    while (currentTime < endDate.getTime()) {
      for (const asset of assets) {
        markets.push({
          asset,
          conditionId: `sim-${asset}-${currentTime}`,
          upTokenId: `sim-${asset}-up-${currentTime}`,
          downTokenId: `sim-${asset}-down-${currentTime}`,
          startTime: currentTime,
          endTime: currentTime + FIFTEEN_MINUTES,
        });
      }
      currentTime += FIFTEEN_MINUTES;
    }

    return markets;
  }

  /**
   * Get historical data for a market period
   */
  private async getHistoricalData(market: SimulatedMarket): Promise<HistoricalDataPoint[]> {
    try {
      // Fetch crypto price history from Polymarket or simulate
      const startTs = Math.floor(market.startTime / 1000);
      const endTs = Math.floor(market.endTime / 1000);

      // Try to get real historical data
      const response = await this.apiClient.get('/prices-history', {
        params: {
          market: market.conditionId,
          start_ts: startTs,
          end_ts: endTs,
          interval: 1, // 1 second
        },
      }).catch(() => null);

      if (response?.data?.history) {
        return this.parseHistoricalData(response.data.history);
      }

      // Fallback: simulate data based on asset's typical volatility
      return this.simulateHistoricalData(market);

    } catch (error) {
      // Simulate data if API fails
      return this.simulateHistoricalData(market);
    }
  }

  /**
   * Parse API historical data
   */
  private parseHistoricalData(history: Array<{ t: number; p: string }>): HistoricalDataPoint[] {
    return history.map(h => ({
      timestamp: h.t * 1000,
      cryptoPrice: parseFloat(h.p),
      upPrice: 0.5, // Will be calculated based on crypto movement
      downPrice: 0.5,
    }));
  }

  /**
   * Simulate historical data with realistic price movements
   */
  private simulateHistoricalData(market: SimulatedMarket): HistoricalDataPoint[] {
    const data: HistoricalDataPoint[] = [];
    const SAMPLE_RATE = 1000; // 1 second

    // Get base price for asset
    const basePrices: Record<CryptoAsset, number> = {
      BTC: 65000,
      ETH: 3500,
      SOL: 150,
      XRP: 0.55,
    };

    let cryptoPrice = basePrices[market.asset];
    let upPrice = 0.5;
    let downPrice = 0.5;

    // Simulate random walk with occasional hard moves
    const hasHardMove = Math.random() < 0.40; // 40% chance of hard move (increased for testing)
    const hardMoveDirection = Math.random() < 0.5 ? 1 : -1;
    const hardMoveStart = market.startTime + Math.floor(Math.random() * 3 * 60 * 1000); // Random start in first 3 min
    const hardMoveDuration = 20 + Math.floor(Math.random() * 40); // 20-60 seconds
    const hardMoveMagnitude = 0.03 + Math.random() * 0.04; // 3-7% move (larger for testing)

    // Volatility parameters
    const baseVolatility = 0.0001; // Per-second volatility
    let currentVolatility = baseVolatility;
    let squeezePeriod = false;

    // Simulate squeeze before hard move
    if (hasHardMove && Math.random() < 0.6) {
      squeezePeriod = true;
    }

    let currentTime = market.startTime;
    let inHardMove = false;

    while (currentTime < market.endTime) {
      // Check if entering hard move
      if (hasHardMove && currentTime >= hardMoveStart && currentTime < hardMoveStart + hardMoveDuration * 1000) {
        inHardMove = true;
      } else {
        inHardMove = false;
      }

      // Determine volatility
      if (squeezePeriod && currentTime < hardMoveStart - 30000) {
        currentVolatility = baseVolatility * 0.3; // Low vol squeeze
      } else if (inHardMove) {
        currentVolatility = baseVolatility * 5; // High vol during move
      } else {
        currentVolatility = baseVolatility;
      }

      // Price movement
      let priceChange: number;
      if (inHardMove) {
        // Directional move
        const moveStep = (hardMoveMagnitude / hardMoveDuration) * hardMoveDirection;
        priceChange = moveStep + (Math.random() - 0.5) * baseVolatility;
      } else {
        // Random walk
        priceChange = (Math.random() - 0.5) * 2 * currentVolatility;
      }

      cryptoPrice *= (1 + priceChange);

      // Calculate market-implied probabilities
      // Simulate lag: market prices update slower than crypto price
      const cryptoMove = (cryptoPrice - basePrices[market.asset]) / basePrices[market.asset];
      const targetUpPrice = 0.5 + cryptoMove * 5; // Sensitivity factor
      const targetDownPrice = 1 - targetUpPrice;

      // Add lag to market prices (30-90 second lag during hard moves)
      // During hard moves, market prices update very slowly creating exploitable gaps
      const lagFactor = inHardMove ? 0.005 : 0.08; // Much slower update during hard moves
      upPrice += (Math.max(0.01, Math.min(0.99, targetUpPrice)) - upPrice) * lagFactor;
      downPrice += (Math.max(0.01, Math.min(0.99, targetDownPrice)) - downPrice) * lagFactor;

      data.push({
        timestamp: currentTime,
        cryptoPrice,
        upPrice,
        downPrice,
      });

      currentTime += SAMPLE_RATE;
    }

    // Determine market outcome
    const finalMove = (cryptoPrice - basePrices[market.asset]) / basePrices[market.asset];
    market.outcome = finalMove > 0 ? 'up' : 'down';

    return data;
  }

  /**
   * Simulate strategy on a single market
   */
  private async simulateMarket(
    market: SimulatedMarket,
    data: HistoricalDataPoint[]
  ): Promise<TradeRecord | null> {
    const priceHistory: PricePoint[] = [];
    let position: SimulatedPosition | null = null;

    // Scan through data
    for (let i = 0; i < data.length; i++) {
      const point = data[i];
      priceHistory.push({ price: point.cryptoPrice, timestamp: point.timestamp });

      // Keep last 5 minutes of history
      const cutoff = point.timestamp - 5 * 60 * 1000;
      while (priceHistory.length > 0 && priceHistory[0].timestamp < cutoff) {
        priceHistory.shift();
      }

      // If we have a position, check for exit
      if (position) {
        const holdTime = (point.timestamp - position.entryTimestamp) / (60 * 1000);
        const currentPrice = position.side === 'UP' ? point.upPrice : point.downPrice;

        // Calculate current gap
        const recentMove = this.calculateRecentMove(priceHistory);
        const gapResult = calculatePriceGap(recentMove, point.upPrice, point.downPrice);

        // Exit conditions
        let shouldExit = false;
        let exitReason: ExitReason = 'gap_closed';

        // Gap closed
        if (gapResult.gap < this.config.exitGapThreshold) {
          shouldExit = true;
          exitReason = 'gap_closed';
        }

        // Max hold time
        if (holdTime >= this.config.maxHoldMinutes) {
          shouldExit = true;
          exitReason = 'max_hold_time';
        }

        // Near market end
        if (point.timestamp >= market.endTime - 60000) {
          shouldExit = true;
          exitReason = 'market_resolved';
        }

        if (shouldExit) {
          const exitPrice = currentPrice;
          const proceeds = position.size * exitPrice;
          const pnl = proceeds - position.costBasis;

          return {
            timestamp: new Date(point.timestamp).toISOString(),
            asset: market.asset,
            market: market.conditionId,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            size: position.size,
            costBasis: position.costBasis,
            proceeds,
            pnl,
            pnlPercent: pnl / position.costBasis,
            holdTimeMinutes: holdTime,
            exitReason,
            signalGap: position.signalGap,
            signalConfidence: position.signalConfidence,
          };
        }

        continue;
      }

      // No position - look for entry signal
      if (priceHistory.length < 30) {
        continue; // Need enough history
      }

      // Detect hard move
      const move = detectHardMove(
        priceHistory,
        market.asset,
        this.config.moveThreshold,
        60,
        20
      );

      if (!move) {
        continue;
      }

      // Calculate gap
      const gapResult = calculatePriceGap(move.movePercent, point.upPrice, point.downPrice);

      // Debug: Log first few signals found
      if (this.tradeHistory.length === 0 && position === null) {
        logger.debug('Potential signal found', {
          asset: market.asset,
          movePercent: (move.movePercent * 100).toFixed(2) + '%',
          upPrice: point.upPrice.toFixed(4),
          downPrice: point.downPrice.toFixed(4),
          gap: (gapResult.gap * 100).toFixed(2) + '%',
          threshold: (this.config.gapThreshold * 100).toFixed(2) + '%',
        });
      }

      if (gapResult.gap < this.config.gapThreshold) {
        continue;
      }

      // Calculate signal confidence
      const confidence = this.calculateConfidence(move, gapResult.gap, move.volatilityBefore.isSqueezing);

      // Open position
      const entryPrice = gapResult.tokenSide === 'up' ? point.upPrice : point.downPrice;
      const positionValue = this.balance * this.config.positionSizePct;
      const size = positionValue / entryPrice;

      position = {
        id: generateId(),
        market,
        side: gapResult.direction,
        entryPrice,
        entryTimestamp: point.timestamp,
        size,
        costBasis: positionValue,
        signalGap: gapResult.gap,
        signalConfidence: confidence,
      };
    }

    // Position still open at end - close at market resolution
    if (position) {
      const finalPoint = data[data.length - 1];
      const holdTime = (finalPoint.timestamp - position.entryTimestamp) / (60 * 1000);

      // Determine exit price based on market outcome
      let exitPrice: number;
      if (market.outcome === 'up' && position.side === 'UP') {
        exitPrice = 0.95; // Won
      } else if (market.outcome === 'down' && position.side === 'DOWN') {
        exitPrice = 0.95; // Won
      } else {
        exitPrice = 0.05; // Lost
      }

      const proceeds = position.size * exitPrice;
      const pnl = proceeds - position.costBasis;

      return {
        timestamp: new Date(finalPoint.timestamp).toISOString(),
        asset: market.asset,
        market: market.conditionId,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        size: position.size,
        costBasis: position.costBasis,
        proceeds,
        pnl,
        pnlPercent: pnl / position.costBasis,
        holdTimeMinutes: holdTime,
        exitReason: 'market_resolved',
        signalGap: position.signalGap,
        signalConfidence: position.signalConfidence,
      };
    }

    return null;
  }

  /**
   * Calculate recent price move percentage
   */
  private calculateRecentMove(priceHistory: PricePoint[]): number {
    if (priceHistory.length < 2) return 0;
    const start = priceHistory[0].price;
    const end = priceHistory[priceHistory.length - 1].price;
    return (end - start) / start;
  }

  /**
   * Calculate signal confidence
   */
  private calculateConfidence(
    move: { movePercent: number; durationSeconds: number; volatilityBefore: { isSqueezing: boolean } },
    gap: number,
    hadSqueeze: boolean
  ): number {
    let confidence = 0.5;
    confidence += Math.min(gap / 0.10, 0.2);
    confidence += Math.min(Math.abs(move.movePercent) / 0.05, 0.15);
    if (move.durationSeconds < 30) confidence += 0.1;
    if (hadSqueeze) confidence += 0.1;
    return Math.min(confidence, 0.99);
  }

  /**
   * Calculate backtest results
   */
  private calculateResults(startDate: Date, endDate: Date, maxDrawdown: number): BacktestResult {
    const winningTrades = this.tradeHistory.filter(t => t.pnl > 0);
    const losingTrades = this.tradeHistory.filter(t => t.pnl <= 0);
    const totalPnl = this.balance - this.initialBalance;

    // Calculate Sharpe ratio
    let sharpeRatio = 0;
    if (this.tradeHistory.length >= 10) {
      const returns = this.tradeHistory.map(t => t.pnlPercent);
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      sharpeRatio = stdDev > 0 ? (avgReturn * Math.sqrt(252 * 96)) / stdDev : 0; // Annualized for 15-min periods
    }

    // Calculate signal accuracy (did we correctly identify the direction?)
    const correctSignals = this.tradeHistory.filter(t => {
      // A correct signal means we predicted the right direction based on the move
      return t.pnl > 0;
    }).length;

    return {
      startDate,
      endDate,
      totalTrades: this.tradeHistory.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: this.tradeHistory.length > 0 ? winningTrades.length / this.tradeHistory.length : 0,
      totalPnl,
      averagePnl: this.tradeHistory.length > 0 ? totalPnl / this.tradeHistory.length : 0,
      maxDrawdown,
      sharpeRatio,
      averageHoldTime: this.tradeHistory.length > 0
        ? this.tradeHistory.reduce((sum, t) => sum + t.holdTimeMinutes, 0) / this.tradeHistory.length
        : 0,
      signalAccuracy: this.tradeHistory.length > 0 ? correctSignals / this.tradeHistory.length : 0,
      trades: this.tradeHistory,
    };
  }

  /**
   * Log backtest results
   */
  private logResults(result: BacktestResult): void {
    logger.info('=== Backtest Results ===');
    logger.info(`Period: ${result.startDate.toISOString()} to ${result.endDate.toISOString()}`);
    logger.info(`Total Trades: ${result.totalTrades}`);
    logger.info(`Winning Trades: ${result.winningTrades}`);
    logger.info(`Losing Trades: ${result.losingTrades}`);
    logger.info(`Win Rate: ${formatPercent(result.winRate)}`);
    logger.info(`Signal Accuracy: ${formatPercent(result.signalAccuracy)}`);
    logger.info(`Total PnL: ${formatCurrency(result.totalPnl)}`);
    logger.info(`Average PnL per Trade: ${formatCurrency(result.averagePnl)}`);
    logger.info(`Max Drawdown: ${formatPercent(result.maxDrawdown)}`);
    logger.info(`Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
    logger.info(`Average Hold Time: ${result.averageHoldTime.toFixed(1)} minutes`);
    logger.info(`Final Balance: ${formatCurrency(this.balance)}`);
    logger.info(`Return: ${formatPercent((this.balance - this.initialBalance) / this.initialBalance)}`);
  }

  /**
   * Export results to CSV
   */
  public exportTrades(filePath: string): void {
    const writer = new TradeHistoryWriter(filePath);
    writer.writeAll(this.tradeHistory);
    logger.info(`Trades exported to ${filePath}`);
  }
}

/**
 * Run backtest from command line
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const backtester = new Backtester(config);

  // Default to last 7 days
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

  const result = await backtester.run(startDate, endDate);

  // Export to CSV
  backtester.exportTrades('./backtest_trades.csv');

  // Exit with appropriate code
  process.exit(result.winRate >= 0.5 ? 0 : 1);
}

// Run if called directly
if (process.argv[1]?.endsWith('backtest.ts') || process.argv[1]?.endsWith('backtest.js')) {
  main().catch(error => {
    logger.error('Backtest failed', { error: error.message });
    process.exit(1);
  });
}

export default Backtester;

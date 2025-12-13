/**
 * Polymarket Momentum Lag Trading Bot
 *
 * Production-ready trading bot that exploits 30-90 second momentum lags
 * in Polymarket's 15-minute crypto prediction markets.
 *
 * Strategy Overview:
 * - Monitors BTC, ETH, SOL, XRP 15-minute up/down prediction markets
 * - Detects hard directional moves (>2% in <1 minute) with low volatility leading in
 * - Identifies 3-5% gaps between crypto price and implied market probability
 * - Enters positions on the lagging side and exits when gap closes
 *
 * Documentation: https://docs.polymarket.com
 */

import { loadConfig, SUPPORTED_ASSETS } from './config.js';
import { MomentumLagStrategy } from './strategy.js';
import { Backtester } from './backtest.js';
import logger from './utils/logger.js';
import { formatCurrency, formatPercent } from './utils/helpers.js';

// ASCII art banner
const BANNER = `
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ██████╗  ██████╗ ██╗  ██╗   ██╗███╗   ███╗ ██████╗ ███╗   ██╗║
║   ██╔══██╗██╔═══██╗██║  ╚██╗ ██╔╝████╗ ████║██╔═══██╗████╗  ██║║
║   ██████╔╝██║   ██║██║   ╚████╔╝ ██╔████╔██║██║   ██║██╔██╗ ██║║
║   ██╔═══╝ ██║   ██║██║    ╚██╔╝  ██║╚██╔╝██║██║   ██║██║╚██╗██║║
║   ██║     ╚██████╔╝███████╗██║   ██║ ╚═╝ ██║╚██████╔╝██║ ╚████║║
║   ╚═╝      ╚═════╝ ╚══════╝╚═╝   ╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝║
║                                                               ║
║           Momentum Lag Trading Bot v1.0.0                     ║
║           15-Minute Crypto Prediction Markets                 ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`;

// Print startup banner
function printBanner(): void {
  console.log(BANNER);
}

// Print configuration summary
function printConfig(config: ReturnType<typeof loadConfig>): void {
  logger.info('Configuration Summary:');
  logger.info(`  Mode: ${config.backtest ? 'BACKTEST' : config.dryRun ? 'DRY RUN' : 'LIVE TRADING'}`);
  logger.info(`  Network: ${config.chainId === 137 ? 'Polygon Mainnet' : 'Amoy Testnet'}`);
  logger.info(`  Host: ${config.host}`);
  logger.info(`  Assets: ${SUPPORTED_ASSETS.join(', ')}`);
  logger.info(`  Position Size: ${formatPercent(config.positionSizePct)}`);
  logger.info(`  Gap Threshold: ${formatPercent(config.gapThreshold)}`);
  logger.info(`  Move Threshold: ${formatPercent(config.moveThreshold)}`);
  logger.info(`  Max Positions: ${config.maxPositions}`);
  logger.info(`  Max Drawdown: ${formatPercent(config.maxDrawdown)}`);
  logger.info(`  Min Liquidity: ${formatCurrency(config.minLiquidity)}`);
  logger.info(`  Max Hold Time: ${config.maxHoldMinutes} minutes`);
  logger.info(`  Binance Fallback: ${config.binanceFallbackEnabled ? 'Enabled' : 'Disabled'}`);
}

// Handle graceful shutdown
function setupGracefulShutdown(strategy: MomentumLagStrategy): void {
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      await strategy.stop();
      logger.info('Bot stopped successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: (error as Error).message });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled rejection', { reason });
    shutdown('unhandledRejection');
  });
}

// Run backtest mode
async function runBacktest(config: ReturnType<typeof loadConfig>): Promise<void> {
  logger.info('Starting backtest mode...');

  const backtester = new Backtester(config);

  // Get command line arguments for date range
  const args = process.argv.slice(2);
  let startDate: Date;
  let endDate = new Date();

  if (args.includes('--start') && args.indexOf('--start') < args.length - 1) {
    startDate = new Date(args[args.indexOf('--start') + 1]);
  } else {
    // Default: last 7 days
    startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  }

  if (args.includes('--end') && args.indexOf('--end') < args.length - 1) {
    endDate = new Date(args[args.indexOf('--end') + 1]);
  }

  // Validate dates
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    logger.error('Invalid date format. Use ISO format (YYYY-MM-DD)');
    process.exit(1);
  }

  const result = await backtester.run(startDate, endDate);

  // Export trades
  const exportPath = config.tradeHistoryPath.replace('.csv', '_backtest.csv');
  backtester.exportTrades(exportPath);

  // Print summary
  console.log('\n=== Backtest Summary ===');
  console.log(`Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`Total Trades: ${result.totalTrades}`);
  console.log(`Win Rate: ${formatPercent(result.winRate)}`);
  console.log(`Signal Accuracy: ${formatPercent(result.signalAccuracy)}`);
  console.log(`Total PnL: ${formatCurrency(result.totalPnl)}`);
  console.log(`Max Drawdown: ${formatPercent(result.maxDrawdown)}`);
  console.log(`Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
  console.log(`\nTrades exported to: ${exportPath}`);
}

// Run live trading mode
async function runLive(config: ReturnType<typeof loadConfig>): Promise<void> {
  const strategy = new MomentumLagStrategy(config);

  // Setup graceful shutdown
  setupGracefulShutdown(strategy);

  // Setup event listeners for monitoring
  strategy.on('positionOpened', (position) => {
    logger.info(`Position opened: ${position.signal.asset} ${position.side}`, {
      entryPrice: position.entryPrice.toFixed(4),
      size: position.size.toFixed(4),
      costBasis: formatCurrency(position.costBasis),
    });
  });

  strategy.on('positionClosed', (position) => {
    logger.info(`Position closed: ${position.signal.asset} ${position.side}`, {
      exitPrice: position.exitPrice?.toFixed(4),
      pnl: formatCurrency(position.realizedPnl || 0),
      reason: position.exitReason,
    });
  });

  try {
    // Start the strategy
    await strategy.start();

    logger.info('Bot is running. Press Ctrl+C to stop.');

    // Keep process alive
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => resolve());
      process.on('SIGTERM', () => resolve());
    });

  } catch (error) {
    logger.error('Failed to start bot', { error: (error as Error).message });
    process.exit(1);
  }
}

// Print help message
function printHelp(): void {
  console.log(`
Polymarket Momentum Lag Trading Bot

Usage:
  npm start                    Run the bot (mode based on .env BACKTEST setting)
  npm run backtest             Run backtest with simulated data

Options:
  --backtest                   Force backtest mode
  --live                       Force live mode (requires BACKTEST=false in .env)
  --start YYYY-MM-DD          Backtest start date (default: 7 days ago)
  --end YYYY-MM-DD            Backtest end date (default: now)
  --help                       Show this help message

Environment Variables:
  PRIVATE_KEY                  Your Ethereum private key (required)
  HOST                         Polymarket CLOB API host
  CHAIN_ID                     137 (Polygon) or 80002 (Amoy testnet)
  BACKTEST                     true/false - run in backtest mode
  DRY_RUN                      true/false - simulate trades without executing
  POSITION_SIZE_PCT            Position size as % of balance (e.g., 0.02 = 2%)
  GAP_THRESHOLD                Minimum gap to trigger entry (e.g., 0.03 = 3%)
  MOVE_THRESHOLD               Minimum price move (e.g., 0.02 = 2%)
  MAX_POSITIONS                Maximum concurrent positions
  MAX_DRAWDOWN                 Maximum allowed drawdown (e.g., 0.10 = 10%)
  LOG_LEVEL                    debug/info/warn/error

Configuration:
  Copy .env.example to .env and fill in your settings.

Documentation:
  https://docs.polymarket.com

Assumptions:
  - USDC approval: Ensure you have approved USDC spending on Polymarket
  - Account setup: Create a Polymarket account and fund it with USDC
  - API access: Generate API credentials or let the bot derive them
  `);
}

// Main entry point
async function main(): Promise<void> {
  printBanner();

  // Check for help flag
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  try {
    // Load configuration
    const config = loadConfig();
    printConfig(config);

    // Determine mode from args or config
    const forceBacktest = process.argv.includes('--backtest');
    const forceLive = process.argv.includes('--live');

    if (forceBacktest || (config.backtest && !forceLive)) {
      await runBacktest(config);
    } else {
      // Safety check for live trading
      if (!config.dryRun) {
        logger.warn('LIVE TRADING MODE - Real funds will be used!');
        logger.warn('Press Ctrl+C within 5 seconds to abort...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      await runLive(config);
    }

  } catch (error) {
    if ((error as Error).message.includes('Missing required environment variable')) {
      logger.error((error as Error).message);
      logger.info('Copy .env.example to .env and fill in your settings');
    } else {
      logger.error('Fatal error', { error: (error as Error).message });
    }
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export { MomentumLagStrategy, Backtester };

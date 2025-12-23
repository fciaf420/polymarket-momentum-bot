/**
 * Test Trading Script
 * Tests that token IDs from Gamma API work with CLOB API for trading
 * Places a small $1.50 test trade in each market and closes it
 */

import dotenv from 'dotenv';
import axios from 'axios';
import { MarketDiscoveryClient } from './clients/market-discovery.js';
import { PolymarketClobClient } from './clients/clob-client.js';
import { loadConfig } from './config.js';
import logger from './utils/logger.js';

dotenv.config();

const TEST_AMOUNT = 1.50; // USD
const CLOB_API = 'https://clob.polymarket.com';

/**
 * Test CLOB API endpoints directly to verify token IDs work
 */
async function testClobEndpoints(tokenId: string, asset: string): Promise<boolean> {
  logger.info(`\n--- Testing CLOB API endpoints for ${asset} ---`);
  logger.info(`  Token ID (first 40 chars): ${tokenId.substring(0, 40)}...`);
  logger.info(`  Token ID length: ${tokenId.length} chars`);

  let allPassed = true;

  // Test 1: /midpoint endpoint
  try {
    const response = await axios.get(`${CLOB_API}/midpoint`, {
      params: { token_id: tokenId },
      timeout: 10000,
    });
    logger.info(`  /midpoint: ✓ mid=${response.data?.mid}`);
  } catch (error: unknown) {
    const err = error as { response?: { status: number; data: unknown }; message: string };
    logger.error(`  /midpoint: ✗ ${err.response?.status || 'error'} - ${JSON.stringify(err.response?.data || err.message)}`);
    allPassed = false;
  }

  // Test 2: /book endpoint (order book)
  try {
    const response = await axios.get(`${CLOB_API}/book`, {
      params: { token_id: tokenId },
      timeout: 10000,
    });
    const bids = response.data?.bids?.length || 0;
    const asks = response.data?.asks?.length || 0;
    logger.info(`  /book: ✓ ${bids} bids, ${asks} asks`);
  } catch (error: unknown) {
    const err = error as { response?: { status: number; data: unknown }; message: string };
    logger.error(`  /book: ✗ ${err.response?.status || 'error'} - ${JSON.stringify(err.response?.data || err.message)}`);
    allPassed = false;
  }

  // Test 3: /price endpoint
  try {
    const response = await axios.get(`${CLOB_API}/price`, {
      params: { token_id: tokenId, side: 'buy' },
      timeout: 10000,
    });
    logger.info(`  /price: ✓ price=${response.data?.price}`);
  } catch (error: unknown) {
    const err = error as { response?: { status: number; data: unknown }; message: string };
    logger.error(`  /price: ✗ ${err.response?.status || 'error'} - ${JSON.stringify(err.response?.data || err.message)}`);
    allPassed = false;
  }

  return allPassed;
}

async function testTrading() {
  logger.info('=== Starting Trading Test ===');
  logger.info(`Test amount: $${TEST_AMOUNT} per market`);

  // Load config
  const config = loadConfig();

  // Force DRY_RUN = false for actual trading test
  config.dryRun = false;

  logger.info('Config loaded', {
    host: config.host,
    chainId: config.chainId,
    dryRun: config.dryRun,
  });

  // Initialize CLOB client
  const clobClient = new PolymarketClobClient(config);
  await clobClient.initialize();

  // Check balance first
  const balance = await clobClient.getBalance();
  logger.info(`Account balance: $${balance.toFixed(2)}`);

  if (balance < TEST_AMOUNT * 4) {
    logger.error(`Insufficient balance for testing. Need at least $${(TEST_AMOUNT * 4).toFixed(2)}`);
    return;
  }

  // Initialize market discovery
  const discovery = new MarketDiscoveryClient(config.host, config.maxHoldMinutes);

  logger.info('Fetching active markets...');
  await discovery.refreshMarkets();

  const markets = discovery.getActiveMarkets();
  logger.info(`Found ${markets.length} active markets`);

  if (markets.length === 0) {
    logger.warn('No active markets found. Checking for next market cycle...');
    // Wait for next 15-minute market to start (up to 5 min)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 30000)); // 30 sec intervals
      await discovery.refreshMarkets();
      const newMarkets = discovery.getActiveMarkets();
      if (newMarkets.length > 0) {
        logger.info(`Found ${newMarkets.length} markets after ${(i+1) * 30}s wait`);
        break;
      }
      logger.info(`Still waiting... (${(i+1) * 30}s elapsed)`);
    }
  }

  // Re-fetch markets after waiting
  const finalMarkets = discovery.getActiveMarkets();

  const results: Array<{
    asset: string;
    tokenId: string;
    step: string;
    success: boolean;
    error?: string;
  }> = [];

  if (finalMarkets.length === 0) {
    logger.error('No active markets found after waiting. Exiting.');
    return;
  }

  // First: Test CLOB API endpoints directly with raw HTTP calls
  logger.info('\n=== PHASE 1: Testing CLOB API Endpoints Directly ===');
  for (const market of finalMarkets.slice(0, 4)) {
    // Test UP token
    const upValid = await testClobEndpoints(market.upTokenId, `${market.asset} UP`);
    // Test DOWN token
    const downValid = await testClobEndpoints(market.downTokenId, `${market.asset} DOWN`);

    if (!upValid || !downValid) {
      logger.warn(`${market.asset}: Some endpoints failed - token IDs may be invalid`);
    }
  }

  logger.info('\n=== PHASE 2: Testing Trading via CLOB Client ===');

  // Test each market
  for (const market of finalMarkets.slice(0, 4)) { // Limit to 4 markets
    logger.info(`\n=== Testing ${market.asset} Market ===`);
    logger.info(`  ConditionId: ${market.conditionId}`);
    logger.info(`  Up Token: ${market.upTokenId}`);
    logger.info(`  Down Token: ${market.downTokenId}`);

    // Step 1: Test order book fetch via CLOB client
    try {
      logger.info('  Step 1: Testing order book fetch...');
      const book = await clobClient.getOrderBook(market.upTokenId);

      if (book.bids.length === 0 && book.asks.length === 0) {
        logger.warn(`  Order book empty for ${market.upTokenId}`);
        results.push({
          asset: market.asset,
          tokenId: market.upTokenId,
          step: 'order_book',
          success: false,
          error: 'Empty order book',
        });
        continue;
      }

      logger.info(`  Order book: ${book.bids.length} bids, ${book.asks.length} asks`);
      if (book.asks.length > 0) {
        logger.info(`  Best ask: ${(book.asks[0].price * 100).toFixed(1)}%`);
      }
      if (book.bids.length > 0) {
        logger.info(`  Best bid: ${(book.bids[0].price * 100).toFixed(1)}%`);
      }

      results.push({
        asset: market.asset,
        tokenId: market.upTokenId,
        step: 'order_book',
        success: true,
      });
    } catch (error) {
      logger.error(`  Order book fetch failed: ${(error as Error).message}`);
      results.push({
        asset: market.asset,
        tokenId: market.upTokenId,
        step: 'order_book',
        success: false,
        error: (error as Error).message,
      });
      continue;
    }

    // Step 2: Place test buy order
    let buyOrder;
    try {
      logger.info(`  Step 2: Placing $${TEST_AMOUNT} buy order...`);
      buyOrder = await clobClient.marketBuy(market.upTokenId, TEST_AMOUNT, market);

      if (buyOrder.status === 'failed') {
        logger.error(`  Buy order failed`);
        results.push({
          asset: market.asset,
          tokenId: market.upTokenId,
          step: 'buy',
          success: false,
          error: 'Order failed',
        });
        continue;
      }

      logger.info(`  Buy order success:`, {
        orderId: buyOrder.id,
        shares: buyOrder.filledSize?.toFixed(4),
        avgPrice: buyOrder.avgFillPrice?.toFixed(4),
      });

      results.push({
        asset: market.asset,
        tokenId: market.upTokenId,
        step: 'buy',
        success: true,
      });
    } catch (error) {
      logger.error(`  Buy order exception: ${(error as Error).message}`);
      results.push({
        asset: market.asset,
        tokenId: market.upTokenId,
        step: 'buy',
        success: false,
        error: (error as Error).message,
      });
      continue;
    }

    // Wait a bit before selling
    await new Promise(r => setTimeout(r, 2000));

    // Step 3: Close position (sell)
    try {
      logger.info(`  Step 3: Closing position (selling ${buyOrder.filledSize?.toFixed(4)} shares)...`);
      const sellOrder = await clobClient.marketSell(
        market.upTokenId,
        buyOrder.filledSize || 0,
        market
      );

      if (sellOrder.status === 'failed') {
        logger.error(`  Sell order failed - POSITION STILL OPEN!`);
        results.push({
          asset: market.asset,
          tokenId: market.upTokenId,
          step: 'sell',
          success: false,
          error: 'Order failed',
        });
        continue;
      }

      const pnl = (sellOrder.avgFillPrice - buyOrder.avgFillPrice) * buyOrder.filledSize;
      logger.info(`  Sell order success:`, {
        orderId: sellOrder.id,
        avgPrice: sellOrder.avgFillPrice?.toFixed(4),
        pnl: `$${pnl.toFixed(4)}`,
      });

      results.push({
        asset: market.asset,
        tokenId: market.upTokenId,
        step: 'sell',
        success: true,
      });
    } catch (error) {
      logger.error(`  Sell order exception: ${(error as Error).message}`);
      results.push({
        asset: market.asset,
        tokenId: market.upTokenId,
        step: 'sell',
        success: false,
        error: (error as Error).message,
      });
    }

    // Wait between markets
    await new Promise(r => setTimeout(r, 1000));
  }

  // Summary
  logger.info('\n=== Test Results Summary ===');

  const byAsset = new Map<string, typeof results>();
  for (const r of results) {
    const arr = byAsset.get(r.asset) || [];
    arr.push(r);
    byAsset.set(r.asset, arr);
  }

  for (const [asset, assetResults] of byAsset) {
    const allSuccess = assetResults.every(r => r.success);
    logger.info(`${asset}: ${allSuccess ? '✅ PASS' : '❌ FAIL'}`);
    for (const r of assetResults) {
      logger.info(`  - ${r.step}: ${r.success ? '✓' : '✗'} ${r.error || ''}`);
    }
  }

  const finalBalance = await clobClient.getBalance();
  logger.info(`\nFinal balance: $${finalBalance.toFixed(2)}`);
  logger.info(`Change: $${(finalBalance - balance).toFixed(4)}`);
}

// Run the test
testTrading().catch(error => {
  logger.error('Test failed with error:', { error: error.message, stack: error.stack });
  process.exit(1);
});

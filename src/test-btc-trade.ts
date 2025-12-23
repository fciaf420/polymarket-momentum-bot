/**
 * Test BTC Trade Script
 * Buys and sells a small amount of BTC to verify trading works
 */

import dotenv from 'dotenv';
import axios from 'axios';
import { MarketDiscoveryClient } from './clients/market-discovery.js';
import { PolymarketClobClient } from './clients/clob-client.js';
import { loadConfig } from './config.js';
import logger from './utils/logger.js';

dotenv.config();

const TEST_AMOUNT = 5.00; // $5 USD worth of contracts
const CLOB_API = 'https://clob.polymarket.com';

async function checkTokenBalance(tokenId: string, walletAddress: string): Promise<number> {
  try {
    // Query the CTF contract for ERC1155 balance
    const response = await axios.get(`${CLOB_API}/balance`, {
      params: {
        asset_id: tokenId,
        address: walletAddress
      },
      timeout: 10000,
    });
    return parseFloat(response.data?.balance || '0');
  } catch (error) {
    logger.debug('Balance check failed (might not be available via API)', { tokenId: tokenId.substring(0, 20) });
    return -1; // Unknown
  }
}

async function testBtcTrade() {
  logger.info('=== BTC Trade Test ===');
  logger.info(`Test amount: $${TEST_AMOUNT}`);

  // Load config
  const config = loadConfig();

  // Force LIVE trading (not dry run) for this test
  config.dryRun = false;
  logger.info('Mode: LIVE TRADING (not dry run)');

  // Get proxy wallet address for balance checks
  const proxyWallet = config.polymarketWallet;
  logger.info(`Proxy wallet: ${proxyWallet || 'Not set (using EOA)'}`);

  // Initialize clients
  const discovery = new MarketDiscoveryClient(config.host, config.maxHoldMinutes);
  const clobClient = new PolymarketClobClient(config);

  await clobClient.initialize();

  // Get initial USDC balance
  const initialBalance = await clobClient.getBalance();
  logger.info(`Initial USDC balance: $${initialBalance.toFixed(2)}`);

  // Fetch active markets
  logger.info('Fetching active BTC markets...');
  await discovery.refreshMarkets();

  const markets = discovery.getActiveMarkets();
  const btcMarket = markets.find(m => m.asset === 'BTC');

  if (!btcMarket) {
    logger.error('No active BTC market found!');
    logger.info('Available markets:', markets.map(m => m.asset));

    // Wait for next market cycle
    logger.info('Waiting for BTC market to become available...');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 15000)); // 15 sec intervals
      await discovery.refreshMarkets();
      const newMarkets = discovery.getActiveMarkets();
      const newBtcMarket = newMarkets.find(m => m.asset === 'BTC');
      if (newBtcMarket) {
        logger.info('BTC market found!');
        await runTradeTest(clobClient, newBtcMarket, initialBalance, proxyWallet);
        return;
      }
      logger.info(`Still waiting... (${(i+1) * 15}s elapsed)`);
    }
    logger.error('Timed out waiting for BTC market');
    return;
  }

  await runTradeTest(clobClient, btcMarket, initialBalance, proxyWallet);
}

async function runTradeTest(
  clobClient: PolymarketClobClient,
  btcMarket: {
    asset: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    marketSlug: string;
    expiryTime: Date;
    tokens: Array<{ tokenId: string; outcome: string; price: number }>;
  },
  initialBalance: number,
  proxyWallet: string | undefined
) {
  logger.info('\n=== BTC Market Details ===');
  logger.info(`  Condition ID: ${btcMarket.conditionId}`);
  logger.info(`  Market Slug: ${btcMarket.marketSlug}`);
  logger.info(`  UP Token: ${btcMarket.upTokenId.substring(0, 30)}...`);
  logger.info(`  DOWN Token: ${btcMarket.downTokenId.substring(0, 30)}...`);
  logger.info(`  Expiry: ${btcMarket.expiryTime.toISOString()}`);

  const timeToExpiry = btcMarket.expiryTime.getTime() - Date.now();
  logger.info(`  Time to expiry: ${(timeToExpiry / 60000).toFixed(1)} minutes`);

  if (timeToExpiry < 120000) { // Less than 2 minutes
    logger.warn('Market expires too soon! Waiting for next cycle...');
    return;
  }

  // Get current prices
  const upToken = btcMarket.tokens.find(t => t.tokenId === btcMarket.upTokenId);
  const downToken = btcMarket.tokens.find(t => t.tokenId === btcMarket.downTokenId);

  logger.info(`  UP Price: ${upToken?.price?.toFixed(4) || 'N/A'}`);
  logger.info(`  DOWN Price: ${downToken?.price?.toFixed(4) || 'N/A'}`);

  // Use UP token for test (we'll buy UP)
  const tokenId = btcMarket.upTokenId;

  logger.info('\n=== Step 1: Check Order Book ===');
  const orderBook = await clobClient.getOrderBook(tokenId);
  logger.info(`Order book: ${orderBook.bids.length} bids, ${orderBook.asks.length} asks`);

  if (orderBook.asks.length === 0) {
    logger.error('No asks available - cannot buy');
    return;
  }

  const bestAsk = orderBook.asks[0];
  logger.info(`Best ask: ${bestAsk.price} @ ${bestAsk.size} shares`);

  // Check initial token balance (if available)
  logger.info('\n=== Step 2: Check Initial Token Balance ===');
  if (proxyWallet) {
    const initialTokenBalance = await checkTokenBalance(tokenId, proxyWallet);
    if (initialTokenBalance >= 0) {
      logger.info(`Initial BTC UP token balance: ${initialTokenBalance}`);
    } else {
      logger.info('Token balance check not available via API');
    }
  } else {
    logger.info('No proxy wallet configured - skipping token balance check');
  }

  logger.info('\n=== Step 3: Buy BTC UP ===');
  logger.info(`Buying $${TEST_AMOUNT} worth of BTC UP tokens...`);

  const buyOrder = await clobClient.marketBuy(tokenId, TEST_AMOUNT, btcMarket as any);

  if (buyOrder.status === 'failed') {
    logger.error('BUY FAILED!');
    return;
  }

  logger.info('BUY SUCCESS!', {
    orderId: buyOrder.id,
    filledSize: buyOrder.filledSize.toFixed(4),
    avgFillPrice: buyOrder.avgFillPrice.toFixed(4),
    totalCost: (buyOrder.filledSize * buyOrder.avgFillPrice).toFixed(2),
  });

  const boughtShares = buyOrder.filledSize;

  // Wait for settlement
  logger.info('\n=== Step 4: Wait for Settlement ===');
  logger.info('Waiting 10 seconds for on-chain settlement...');
  await new Promise(r => setTimeout(r, 10000));

  // Check token balance after buy
  logger.info('\n=== Step 5: Check Token Balance After Buy ===');
  if (proxyWallet) {
    const afterBuyBalance = await checkTokenBalance(tokenId, proxyWallet);
    if (afterBuyBalance >= 0) {
      logger.info(`BTC UP token balance after buy: ${afterBuyBalance}`);
      if (afterBuyBalance < boughtShares * 0.99) {
        logger.warn('Token balance lower than expected! Tokens may not have settled.');
      }
    }
  } else {
    logger.info('No proxy wallet configured - skipping token balance check');
  }

  // Get updated order book for sell
  logger.info('\n=== Step 6: Check Order Book for Sell ===');
  const sellOrderBook = await clobClient.getOrderBook(tokenId);
  logger.info(`Order book: ${sellOrderBook.bids.length} bids, ${sellOrderBook.asks.length} asks`);

  if (sellOrderBook.bids.length === 0) {
    logger.error('No bids available - cannot sell');
    return;
  }

  const bestBid = sellOrderBook.bids[0];
  logger.info(`Best bid: ${bestBid.price} @ ${bestBid.size} shares`);

  logger.info('\n=== Step 7: Sell BTC UP ===');
  logger.info(`Selling ${boughtShares.toFixed(4)} BTC UP tokens...`);

  const sellOrder = await clobClient.marketSell(tokenId, boughtShares, btcMarket as any);

  if (sellOrder.status === 'failed') {
    logger.error('SELL FAILED!');
    logger.error('This confirms the issue - BTC sells are failing.');

    // Check final balance to see if we still have the tokens
    const finalBalance = await clobClient.getBalance();
    logger.info(`Final USDC balance: $${finalBalance.toFixed(2)}`);
    logger.info(`Balance change: $${(finalBalance - initialBalance).toFixed(2)}`);
    logger.warn('You now have BTC UP tokens stuck in your wallet!');
    logger.warn(`Tokens: ${boughtShares.toFixed(4)} @ estimated value $${(boughtShares * bestBid.price).toFixed(2)}`);
    return;
  }

  logger.info('SELL SUCCESS!', {
    orderId: sellOrder.id,
    filledSize: sellOrder.filledSize.toFixed(4),
    avgFillPrice: sellOrder.avgFillPrice.toFixed(4),
    totalProceeds: (sellOrder.filledSize * sellOrder.avgFillPrice).toFixed(2),
  });

  // Calculate P&L
  const cost = buyOrder.filledSize * buyOrder.avgFillPrice;
  const proceeds = sellOrder.filledSize * sellOrder.avgFillPrice;
  const pnl = proceeds - cost;

  logger.info('\n=== Trade Summary ===');
  logger.info(`Cost: $${cost.toFixed(4)}`);
  logger.info(`Proceeds: $${proceeds.toFixed(4)}`);
  logger.info(`P&L: $${pnl.toFixed(4)} (${((pnl/cost) * 100).toFixed(2)}%)`);

  // Check final balance
  const finalBalance = await clobClient.getBalance();
  logger.info(`\nFinal USDC balance: $${finalBalance.toFixed(2)}`);
  logger.info(`Balance change: $${(finalBalance - initialBalance).toFixed(4)}`);

  logger.info('\n=== TEST PASSED! BTC BUY/SELL WORKS ===');
}

// Run the test
testBtcTrade().catch(error => {
  logger.error('Test failed with error:', { error: error.message, stack: error.stack });
  process.exit(1);
});

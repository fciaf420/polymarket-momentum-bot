import { useState, useEffect } from 'react';
import { Coins, Clock, TrendingUp, TrendingDown, Timer } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';
import type { DashboardState, CryptoAsset } from '../types';

interface PriceMonitorProps {
  prices: DashboardState['prices'];
  markets: DashboardState['markets'];
}

const ASSET_ICONS: Record<CryptoAsset, string> = {
  BTC: 'orange',
  ETH: 'purple',
  SOL: 'cyan',
  XRP: 'slate',
};

// Format countdown as MM:SS
function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatCurrency(value: number, asset?: CryptoAsset): string {
  if (asset && value > 1000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

export function PriceMonitor({ prices, markets }: PriceMonitorProps) {
  const [now, setNow] = useState(Date.now());
  const assets = Object.keys(prices.crypto) as CryptoAsset[];

  // Update countdown every second
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (assets.length === 0) {
    return (
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <Coins className="h-5 w-5 text-yellow-400" />
          Price Monitor
        </h2>
        <div className="text-center py-8 text-slate-400">
          <Coins className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>Waiting for price data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Coins className="h-5 w-5 text-yellow-400" />
        Price Monitor
      </h2>

      <div className="space-y-4">
        {assets.map((asset) => {
          const cryptoPrice = prices.crypto[asset];
          const assetMarkets = markets.filter((m) => m.asset === asset);
          const color = ASSET_ICONS[asset];

          // Get the main market odds for this asset (first available market)
          const mainMarket = assetMarkets[0];
          const mainMarketPrice = mainMarket ? prices.markets[mainMarket.conditionId] : null;

          // Calculate countdown for main market
          const expiryMs = mainMarket ? new Date(mainMarket.expiryTime).getTime() : 0;
          const timeLeft = expiryMs - now;
          const isExpiringSoon = timeLeft > 0 && timeLeft < 2 * 60 * 1000; // Less than 2 min

          return (
            <div key={asset} className="border border-slate-700 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center bg-${color}-500/20`}
                  >
                    <span className={`text-${color}-400 font-bold text-sm`}>{asset}</span>
                  </div>
                  <div>
                    <p className="font-bold text-white">{asset}</p>
                    <p className="text-xs text-slate-400">
                      <Clock className="h-3 w-3 inline mr-1" />
                      {cryptoPrice && formatDistanceToNow(cryptoPrice.timestamp, { addSuffix: true })}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xl font-bold text-white">
                    {cryptoPrice ? formatCurrency(cryptoPrice.price, asset) : '-'}
                  </p>
                  {/* Countdown Timer */}
                  {mainMarket && timeLeft > 0 && (
                    <div className={clsx(
                      'flex items-center justify-end gap-1 text-xs font-mono',
                      isExpiringSoon ? 'text-amber-400' : 'text-slate-400'
                    )}>
                      <Timer className="h-3 w-3" />
                      <span>{formatCountdown(timeLeft)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* UP/DOWN Odds Display */}
              {mainMarketPrice && (
                <div className="flex items-center justify-center gap-4 py-2 bg-slate-800/50 rounded-lg mb-2">
                  <div className="flex items-center gap-1.5">
                    <TrendingUp className="h-4 w-4 text-emerald-400" />
                    <span className="text-sm font-medium text-emerald-400">
                      UP {(mainMarketPrice.upPrice * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="w-px h-4 bg-slate-600" />
                  <div className="flex items-center gap-1.5">
                    <TrendingDown className="h-4 w-4 text-red-400" />
                    <span className="text-sm font-medium text-red-400">
                      DOWN {(mainMarketPrice.downPrice * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              )}

              {/* Odds bar visualization */}
              {mainMarketPrice && (
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                    style={{ width: `${mainMarketPrice.upPrice * 100}%` }}
                  />
                </div>
              )}

              {/* Active Markets for this Asset */}
              {assetMarkets.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-700/50">
                  <p className="text-xs text-slate-500 mb-2">Active Markets ({assetMarkets.length})</p>
                  <div className="grid grid-cols-2 gap-2">
                    {assetMarkets.map((market) => {
                      const marketPrice = prices.markets[market.conditionId];
                      const expiryMs = new Date(market.expiryTime).getTime();
                      const minutesLeft = Math.max(0, Math.floor((expiryMs - Date.now()) / 60000));

                      return (
                        <div
                          key={market.conditionId}
                          className="bg-slate-700/30 rounded p-2 text-xs"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className={clsx(
                              'font-medium',
                              market.direction === 'UP' ? 'text-emerald-400' : 'text-red-400'
                            )}>
                              {market.direction === 'UP' ? '↑ UP' : '↓ DOWN'}
                            </span>
                            <span className="text-slate-400">{minutesLeft}m</span>
                          </div>
                          {marketPrice && (
                            <div className="flex justify-between text-slate-300">
                              <span className="text-emerald-400/80">UP {(marketPrice.upPrice * 100).toFixed(0)}%</span>
                              <span className="text-red-400/80">DN {(marketPrice.downPrice * 100).toFixed(0)}%</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PriceMonitor;

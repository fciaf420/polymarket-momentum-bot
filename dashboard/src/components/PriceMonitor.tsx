import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import type { DashboardState, CryptoAsset } from '../types';

interface PriceMonitorProps {
  prices: DashboardState['prices'];
  markets: DashboardState['markets'];
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatPrice(value: number): string {
  if (value >= 1000) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  }
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function AsciiProgressBar({ value, width = 20 }: { value: number; width?: number }) {
  const filled = Math.round(value * width);
  const empty = width - filled;
  return (
    <span className="font-mono text-xs">
      <span className="text-matrix-green">{'█'.repeat(filled)}</span>
      <span className="text-term-dim">{'░'.repeat(empty)}</span>
    </span>
  );
}

export function PriceMonitor({ prices, markets }: PriceMonitorProps) {
  const [now, setNow] = useState(Date.now());
  const assets = Object.keys(prices.crypto) as CryptoAsset[];

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (assets.length === 0) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">PRICES</div>
        <div className="text-center py-6">
          <div className="text-term-dim text-sm">[ AWAITING PRICE DATA ]</div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">MARKET DATA</div>

      <div className="space-y-4">
        {assets.map((asset) => {
          const cryptoPrice = prices.crypto[asset];
          const assetMarkets = markets.filter((m) => m.asset === asset);
          const mainMarket = assetMarkets[0];
          const mainMarketPrice = mainMarket ? prices.markets[mainMarket.conditionId] : null;
          const expiryMs = mainMarket ? new Date(mainMarket.expiryTime).getTime() : 0;
          const timeLeft = expiryMs - now;
          const isExpiringSoon = timeLeft > 0 && timeLeft < 2 * 60 * 1000;

          return (
            <div key={asset} className="border border-term-border p-3">
              {/* Header Row */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-cyber-cyan font-bold text-lg">{asset}</span>
                  <span className="text-term-text text-xl font-mono num-fixed">
                    ${cryptoPrice ? formatPrice(cryptoPrice.price) : '---'}
                  </span>
                </div>
                {/* Countdown */}
                {mainMarket && timeLeft > 0 && (
                  <div className={clsx(
                    'font-mono text-sm',
                    isExpiringSoon ? 'text-hot-pink animate-pulse' : 'text-term-muted'
                  )}>
                    T-{formatCountdown(timeLeft)}
                  </div>
                )}
              </div>

              {/* Odds Display */}
              {mainMarketPrice && (
                <div className="space-y-2">
                  {/* UP/DOWN Values */}
                  <div className="flex items-center justify-between text-sm font-mono">
                    <div className="flex items-center gap-2">
                      <span className="text-matrix-green">▲ UP</span>
                      <span className="text-matrix-green font-bold">
                        {(mainMarketPrice.upPrice * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-hot-pink font-bold">
                        {(mainMarketPrice.downPrice * 100).toFixed(0)}%
                      </span>
                      <span className="text-hot-pink">DN ▼</span>
                    </div>
                  </div>

                  {/* ASCII Progress Bar */}
                  <div className="flex items-center gap-2">
                    <AsciiProgressBar value={mainMarketPrice.upPrice} width={30} />
                  </div>
                </div>
              )}

              {/* Sub-markets */}
              {assetMarkets.length > 1 && (
                <div className="mt-3 pt-2 border-t border-term-border">
                  <div className="text-term-dim text-xs mb-2">ACTIVE MARKETS: {assetMarkets.length}</div>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    {assetMarkets.slice(0, 4).map((market) => {
                      const mp = prices.markets[market.conditionId];
                      const exp = new Date(market.expiryTime).getTime();
                      const minLeft = Math.max(0, Math.floor((exp - now) / 60000));

                      return (
                        <div key={market.conditionId} className="flex justify-between text-term-muted">
                          <span className={market.direction === 'UP' ? 'text-matrix-green' : 'text-hot-pink'}>
                            {market.direction === 'UP' ? '↑' : '↓'} {minLeft}m
                          </span>
                          {mp && (
                            <span>
                              <span className="text-matrix-green">{(mp.upPrice * 100).toFixed(0)}</span>
                              /
                              <span className="text-hot-pink">{(mp.downPrice * 100).toFixed(0)}</span>
                            </span>
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

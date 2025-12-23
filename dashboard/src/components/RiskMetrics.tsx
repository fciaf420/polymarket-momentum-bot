import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import type { DashboardState } from '../types';
import { api } from '../services/api';

interface RiskMetricsProps {
  risk: DashboardState['risk'];
  accountBalance: number;
}

interface OnChainData {
  balance: number;
  positions: Array<{
    tokenId: string;
    size: number;
    avgEntryPrice: number;
    currentValue: number;
  }>;
  timestamp: number;
  source: 'onchain' | 'error';
  error?: string;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function AsciiGauge({ value, max, width = 20 }: { value: number; max: number; width?: number }) {
  const ratio = Math.min(value / max, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  const color = ratio > 0.8 ? 'text-hot-pink' : ratio > 0.5 ? 'text-amber' : 'text-matrix-green';

  return (
    <span className="font-mono text-xs">
      [<span className={color}>{'█'.repeat(filled)}</span>
      <span className="text-term-dim">{'░'.repeat(empty)}</span>]
    </span>
  );
}

export function RiskMetrics({ risk, accountBalance }: RiskMetricsProps) {
  const { metrics, limits } = risk;
  const [onChainData, setOnChainData] = useState<OnChainData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchOnChainData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getOnChainData();
      setOnChainData(data);
    } catch (error) {
      console.error('Failed to fetch on-chain data:', error);
      setOnChainData({
        balance: 0,
        positions: [],
        timestamp: Date.now(),
        source: 'error',
        error: (error as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on-chain data periodically (every 30 seconds)
  useEffect(() => {
    fetchOnChainData();
    const interval = setInterval(fetchOnChainData, 30000);
    return () => clearInterval(interval);
  }, [fetchOnChainData]);

  const drawdownRatio = metrics.currentDrawdown / limits.maxDrawdown;
  const dailyLossRatio = metrics.dailyPnl < 0 ? Math.abs(metrics.dailyPnl) / (limits.maxDailyLoss || 1) : 0;
  const concentrationRatio = metrics.positionConcentration / (limits.maxConcentration || 0.5);

  // Calculate balance difference between local and on-chain
  const balanceDiff = onChainData ? onChainData.balance - accountBalance : 0;
  const hasBalanceMismatch = Math.abs(balanceDiff) > 0.01;

  return (
    <div className="terminal-panel">
      <div className="flex items-center justify-between mb-3">
        <div className="terminal-header">RISK</div>
        <div className="flex items-center gap-2">
          {drawdownRatio > 0.7 && (
            <span className="badge badge-red text-xs animate-pulse">! HIGH RISK</span>
          )}
        </div>
      </div>

      {/* On-Chain Data Section */}
      <div className="mb-3 p-2 border border-cyber-cyan/30 bg-cyber-cyan/5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-cyber-cyan text-xs font-medium tracking-wider">ON-CHAIN</span>
          <div className="flex items-center gap-2">
            {loading && <span className="text-term-dim text-xs animate-pulse">SYNC...</span>}
            <button
              onClick={fetchOnChainData}
              disabled={loading}
              className="text-cyber-cyan text-xs hover:text-white transition-colors disabled:opacity-50"
            >
              [REFRESH]
            </button>
          </div>
        </div>

        {onChainData && onChainData.source === 'onchain' && (
          <div className="space-y-1 text-xs font-mono">
            <div className="flex justify-between">
              <span className="text-term-muted">USDC BAL:</span>
              <span className={clsx(
                'num-fixed',
                hasBalanceMismatch ? 'text-amber' : 'text-matrix-green'
              )}>
                ${formatCurrency(onChainData.balance)}
                {hasBalanceMismatch && (
                  <span className="text-amber ml-1">
                    ({balanceDiff >= 0 ? '+' : ''}{formatCurrency(balanceDiff)})
                  </span>
                )}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-term-muted">POSITIONS:</span>
              <span className="text-term-text num-fixed">{onChainData.positions.length}</span>
            </div>
            {onChainData.positions.length > 0 && (
              <div className="flex justify-between">
                <span className="text-term-muted">POS VALUE:</span>
                <span className="text-term-text num-fixed">
                  ${formatCurrency(onChainData.positions.reduce((sum, p) => sum + p.currentValue, 0))}
                </span>
              </div>
            )}
            <div className="flex justify-between text-term-dim">
              <span>LAST SYNC:</span>
              <span>{formatTime(onChainData.timestamp)}</span>
            </div>
          </div>
        )}

        {onChainData && onChainData.source === 'error' && (
          <div className="text-hot-pink text-xs">! {onChainData.error || 'Failed to fetch'}</div>
        )}

        {!onChainData && !loading && (
          <div className="text-term-dim text-xs">[ AWAITING DATA ]</div>
        )}
      </div>

      {/* Drawdown Gauge */}
      <div className="mb-3 p-2 border border-term-border">
        <div className="flex items-center justify-between mb-1 text-xs">
          <span className="text-term-muted">DRAWDOWN</span>
          <span className={clsx(
            'font-mono num-fixed',
            drawdownRatio > 0.8 ? 'text-hot-pink' : drawdownRatio > 0.5 ? 'text-amber' : 'text-matrix-green'
          )}>
            {formatPercent(metrics.currentDrawdown)} / {formatPercent(limits.maxDrawdown)}
          </span>
        </div>
        <AsciiGauge value={metrics.currentDrawdown} max={limits.maxDrawdown} width={28} />
      </div>

      {/* Daily Loss Gauge (if negative) */}
      {metrics.dailyPnl < 0 && limits.maxDailyLoss > 0 && (
        <div className="mb-3 p-2 border border-term-border">
          <div className="flex items-center justify-between mb-1 text-xs">
            <span className="text-term-muted">DAILY LOSS</span>
            <span className={clsx(
              'font-mono num-fixed',
              dailyLossRatio > 0.8 ? 'text-hot-pink' : dailyLossRatio > 0.5 ? 'text-amber' : 'text-term-text'
            )}>
              ${formatCurrency(Math.abs(metrics.dailyPnl))} / ${formatCurrency(limits.maxDailyLoss)}
            </span>
          </div>
          <AsciiGauge value={Math.abs(metrics.dailyPnl)} max={limits.maxDailyLoss} width={28} />
        </div>
      )}

      {/* Concentration Gauge */}
      {metrics.positionConcentration > 0 && (
        <div className="mb-3 p-2 border border-term-border">
          <div className="flex items-center justify-between mb-1 text-xs">
            <span className="text-term-muted">CONCENTRATION</span>
            <span className={clsx(
              'font-mono num-fixed',
              concentrationRatio > 0.8 ? 'text-hot-pink' : concentrationRatio > 0.5 ? 'text-amber' : 'text-term-text'
            )}>
              {formatPercent(metrics.positionConcentration)} / {formatPercent(limits.maxConcentration || 0.5)}
            </span>
          </div>
          <AsciiGauge value={metrics.positionConcentration} max={limits.maxConcentration || 0.5} width={28} />
        </div>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
        <div className="flex justify-between">
          <span className="text-term-muted">MAX DD:</span>
          <span className={clsx(
            'num-fixed',
            metrics.maxDrawdown > limits.maxDrawdown * 0.8 ? 'text-hot-pink' : 'text-term-text'
          )}>
            {formatPercent(metrics.maxDrawdown)}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">DAILY P&L:</span>
          <span className={clsx('num-fixed', metrics.dailyPnl >= 0 ? 'text-profit' : 'text-loss')}>
            {metrics.dailyPnl >= 0 ? '+' : ''}${formatCurrency(metrics.dailyPnl)}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">TOTAL P&L:</span>
          <span className={clsx('num-fixed', metrics.totalPnl >= 0 ? 'text-profit' : 'text-loss')}>
            {metrics.totalPnl >= 0 ? '+' : ''}${formatCurrency(metrics.totalPnl)}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">WIN RATE:</span>
          <span className={clsx('num-fixed', metrics.winRate >= 0.5 ? 'text-profit' : 'text-loss')}>
            {formatPercent(metrics.winRate)}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">AVG WIN:</span>
          <span className="num-fixed text-profit">
            +${formatCurrency(metrics.averageWin || 0)}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">AVG LOSS:</span>
          <span className="num-fixed text-loss">
            ${formatCurrency(metrics.averageLoss || 0)}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">PROFIT F:</span>
          <span className={clsx('num-fixed', metrics.profitFactor >= 1 ? 'text-profit' : 'text-loss')}>
            {metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">SHARPE:</span>
          <span className={clsx('num-fixed', metrics.sharpeRatio >= 1 ? 'text-profit' : metrics.sharpeRatio >= 0 ? 'text-amber' : 'text-loss')}>
            {metrics.sharpeRatio.toFixed(2)}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">EXPOSURE:</span>
          <span className="num-fixed text-term-text">${formatCurrency(metrics.totalExposure)}</span>
        </div>

        <div className="flex justify-between">
          <span className="text-term-muted">MAX POS:</span>
          <span className="num-fixed text-term-text">{limits.maxPositions}</span>
        </div>
      </div>
    </div>
  );
}

export default RiskMetrics;

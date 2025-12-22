import { TrendingUp, TrendingDown, Check, X, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import type { Signal } from '../types';

interface RecentSignalsProps {
  signals: Signal[];
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function RecentSignals({ signals }: RecentSignalsProps) {
  if (signals.length === 0) {
    return (
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4">Recent Signals</h2>
        <div className="text-center py-8 text-slate-400">
          <Clock className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>No signals detected yet</p>
          <p className="text-sm">Monitoring for momentum gaps...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-4">Recent Signals</h2>
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {signals.map((signal) => {
          const isUp = signal.direction === 'up';
          return (
            <div
              key={signal.id}
              className={clsx(
                'flex items-center gap-3 p-3 rounded-lg border transition-colors',
                signal.executed
                  ? 'bg-emerald-500/10 border-emerald-500/30'
                  : 'bg-slate-700/30 border-slate-700'
              )}
            >
              {/* Asset and Direction */}
              <div className="flex items-center gap-2 min-w-[100px]">
                <span className="font-bold text-white">{signal.asset}</span>
                <span className={clsx('badge', isUp ? 'badge-green' : 'badge-red')}>
                  {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                </span>
              </div>

              {/* Gap and Prices */}
              <div className="flex-1 grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-slate-400 text-xs">Gap</span>
                  <p className={clsx('font-medium', signal.gap > 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {formatPercent(signal.gap)}
                  </p>
                </div>
                <div>
                  <span className="text-slate-400 text-xs">Crypto</span>
                  <p className="text-white">{formatCurrency(signal.cryptoPrice)}</p>
                </div>
                <div>
                  <span className="text-slate-400 text-xs">Implied</span>
                  <p className="text-white">{formatCurrency(signal.impliedPrice)}</p>
                </div>
              </div>

              {/* Confidence */}
              <div className="min-w-[60px] text-right">
                <span className="text-slate-400 text-xs">Conf</span>
                <p
                  className={clsx(
                    'font-medium',
                    signal.confidence > 0.7 ? 'text-emerald-400' : signal.confidence > 0.5 ? 'text-yellow-400' : 'text-red-400'
                  )}
                >
                  {(signal.confidence * 100).toFixed(0)}%
                </p>
              </div>

              {/* Execution Status */}
              <div className="min-w-[80px] text-right">
                {signal.executed ? (
                  <span className="badge badge-green">
                    <Check className="h-3 w-3 mr-1" />
                    Executed
                  </span>
                ) : (
                  <span className="badge badge-gray">
                    <X className="h-3 w-3 mr-1" />
                    Skipped
                  </span>
                )}
              </div>

              {/* Timestamp */}
              <div className="min-w-[80px] text-right text-xs text-slate-400">
                {formatDistanceToNow(signal.timestamp, { addSuffix: true })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default RecentSignals;

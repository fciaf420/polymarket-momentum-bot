import { clsx } from 'clsx';
import type { Signal } from '../types';

interface RecentSignalsProps {
  signals: Signal[];
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
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function RecentSignals({ signals }: RecentSignalsProps) {
  if (signals.length === 0) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">SIGNALS</div>
        <div className="text-center py-6">
          <div className="text-term-dim text-sm">[ NO SIGNALS DETECTED ]</div>
          <div className="text-term-muted text-xs mt-1">Monitoring for momentum gaps...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">SIGNALS [{signals.length}]</div>
      <div className="space-y-1 max-h-[300px] overflow-y-auto font-mono text-xs">
        {signals.map((signal) => {
          const isUp = signal.direction === 'up';
          const confColor = signal.confidence > 0.7 ? 'text-matrix-green' : signal.confidence > 0.5 ? 'text-amber' : 'text-hot-pink';

          return (
            <div
              key={signal.id}
              className={clsx(
                'flex items-center gap-2 py-1.5 px-2 border-l-2',
                signal.executed ? 'border-matrix-green bg-matrix-green/5' : 'border-term-border'
              )}
            >
              {/* Timestamp */}
              <span className="text-term-dim w-16">[{formatTime(signal.timestamp)}]</span>

              {/* Asset */}
              <span className="text-term-text w-8 font-semibold">{signal.asset}</span>

              {/* Direction */}
              <span className={clsx('w-12', isUp ? 'text-matrix-green' : 'text-hot-pink')}>
                {isUp ? '▲ UP' : '▼ DN'}
              </span>

              {/* Gap */}
              <span className="text-term-muted w-8">GAP:</span>
              <span className={clsx('w-14 num-fixed', signal.gap > 0 ? 'text-matrix-green' : 'text-hot-pink')}>
                {formatPercent(signal.gap)}
              </span>

              {/* Prices */}
              <span className="text-term-muted">SPOT:</span>
              <span className="text-term-text w-20 num-fixed">${formatCurrency(signal.cryptoPrice)}</span>

              <span className="text-term-muted">IMP:</span>
              <span className="text-term-text w-20 num-fixed">${formatCurrency(signal.impliedPrice)}</span>

              {/* Confidence */}
              <span className="text-term-muted">CONF:</span>
              <span className={clsx('w-10 num-fixed', confColor)}>
                {(signal.confidence * 100).toFixed(0)}%
              </span>

              {/* Status */}
              <span className={clsx(
                'ml-auto px-2 py-0.5 text-xs',
                signal.executed ? 'text-matrix-green' : 'text-term-dim'
              )}>
                {signal.executed ? '[EXEC]' : '[SKIP]'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default RecentSignals;

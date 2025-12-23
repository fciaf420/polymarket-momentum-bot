import { clsx } from 'clsx';
import type { Position } from '../types';

interface LivePositionsProps {
  positions: Position[];
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function formatHoldTime(entryTime: number): string {
  const now = Date.now();
  const diff = now - entryTime;
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function LivePositions({ positions }: LivePositionsProps) {
  if (positions.length === 0) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">POSITIONS</div>
        <div className="text-center py-6">
          <div className="text-term-dim text-sm">[ NO ACTIVE POSITIONS ]</div>
          <div className="text-term-muted text-xs mt-1">Waiting for signals...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">POSITIONS [{positions.length}]</div>
      <div className="overflow-x-auto">
        <table className="terminal-table">
          <thead>
            <tr>
              <th>ASSET</th>
              <th>DIR</th>
              <th>SIDE</th>
              <th className="text-right">ENTRY</th>
              <th className="text-right">CURRENT</th>
              <th className="text-right">SIZE</th>
              <th className="text-right">COST</th>
              <th className="text-right">P&L</th>
              <th className="text-right">%</th>
              <th className="text-right">TIME</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => {
              const isProfitable = pos.unrealizedPnl >= 0;
              const isUp = pos.signal.direction === 'up';

              return (
                <tr key={pos.id} className="hover:bg-term-panel/50">
                  <td className="text-term-text font-semibold">{pos.signal.asset}</td>
                  <td>
                    <span className={clsx(isUp ? 'text-matrix-green' : 'text-hot-pink')}>
                      {isUp ? '▲ UP' : '▼ DN'}
                    </span>
                  </td>
                  <td>
                    <span className={clsx('badge text-xs', pos.side === 'YES' ? 'badge-cyan' : 'badge-amber')}>
                      {pos.side}
                    </span>
                  </td>
                  <td className="text-right num-fixed text-term-text">{pos.entryPrice.toFixed(4)}</td>
                  <td className="text-right num-fixed text-term-text">{pos.currentPrice.toFixed(4)}</td>
                  <td className="text-right num-fixed text-term-muted">{pos.size.toFixed(2)}</td>
                  <td className="text-right num-fixed text-term-muted">${formatCurrency(pos.costBasis)}</td>
                  <td className={clsx('text-right num-fixed font-semibold', isProfitable ? 'text-profit' : 'text-loss')}>
                    {isProfitable ? '+' : ''}${formatCurrency(pos.unrealizedPnl)}
                  </td>
                  <td className={clsx('text-right num-fixed', isProfitable ? 'text-profit' : 'text-loss')}>
                    {formatPercent(pos.unrealizedPnlPercent)}
                  </td>
                  <td className="text-right num-fixed text-term-dim">{formatHoldTime(pos.entryTime)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Position Details Footer */}
      <div className="mt-3 pt-3 border-t border-term-border text-xs text-term-dim flex justify-between">
        <div className="flex gap-4">
          {positions.map((pos) => (
            <span key={pos.id}>
              {pos.signal.asset}: gap={((pos.signal.gap) * 100).toFixed(1)}% conf={((pos.signal.confidence) * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default LivePositions;

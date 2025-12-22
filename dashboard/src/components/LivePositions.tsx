import { TrendingUp, TrendingDown, Clock } from 'lucide-react';
import { clsx } from 'clsx';
import type { Position } from '../types';

interface LivePositionsProps {
  positions: Position[];
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function formatHoldTime(entryTime: number): string {
  const now = Date.now();
  const diff = now - entryTime;
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function PositionCard({ position }: { position: Position }) {
  const isProfitable = position.unrealizedPnl >= 0;
  const isUp = position.signal.direction === 'up';

  return (
    <div className="card hover:border-slate-600 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-white">{position.signal.asset}</span>
          <span className={clsx('badge', isUp ? 'badge-green' : 'badge-red')}>
            {isUp ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
            {position.signal.direction.toUpperCase()}
          </span>
          <span className={clsx('badge', position.side === 'YES' ? 'badge-blue' : 'badge-yellow')}>
            {position.side}
          </span>
        </div>
        <div className="flex items-center gap-1 text-xs text-slate-400">
          <Clock className="h-3 w-3" />
          {formatHoldTime(position.entryTime)}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-slate-400 text-xs">Entry Price</p>
          <p className="text-white font-medium">{position.entryPrice.toFixed(4)}</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs">Current Price</p>
          <p className="text-white font-medium">{position.currentPrice.toFixed(4)}</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs">Size</p>
          <p className="text-white font-medium">{position.size.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-slate-400 text-xs">Cost Basis</p>
          <p className="text-white font-medium">{formatCurrency(position.costBasis)}</p>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-700">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-slate-400 text-xs">Unrealized P&L</p>
            <p className={clsx('text-lg font-bold', isProfitable ? 'text-emerald-400' : 'text-red-400')}>
              {formatCurrency(position.unrealizedPnl)}
            </p>
          </div>
          <div
            className={clsx(
              'px-3 py-1 rounded-lg text-sm font-medium',
              isProfitable ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
            )}
          >
            {formatPercent(position.unrealizedPnlPercent)}
          </div>
        </div>
      </div>

      <div className="mt-2 text-xs text-slate-500">
        Gap: {(position.signal.gap * 100).toFixed(2)}% | Confidence: {(position.signal.confidence * 100).toFixed(0)}%
      </div>
    </div>
  );
}

export function LivePositions({ positions }: LivePositionsProps) {
  if (positions.length === 0) {
    return (
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4">Live Positions</h2>
        <div className="text-center py-8 text-slate-400">
          <TrendingUp className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>No open positions</p>
          <p className="text-sm">Waiting for trading signals...</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-4">
        Live Positions ({positions.length})
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {positions.map((position) => (
          <PositionCard key={position.id} position={position} />
        ))}
      </div>
    </div>
  );
}

export default LivePositions;

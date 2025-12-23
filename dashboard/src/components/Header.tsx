import { Pause, Play } from 'lucide-react';
import { clsx } from 'clsx';
import type { DashboardState } from '../types';

interface HeaderProps {
  state: DashboardState | null;
  isConnected: boolean;
  onPause: () => void;
  onResume: () => void;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function Header({ state, isConnected, onPause, onResume }: HeaderProps) {
  const isPaused = state?.status.paused ?? false;
  const isRunning = state?.status.isRunning ?? false;

  return (
    <header className="bg-term-bg border-b border-cyber-cyan/30 px-4 py-3">
      <div className="flex items-center justify-between">
        {/* Logo and Status */}
        <div className="flex items-center gap-6">
          {/* Title */}
          <div className="flex items-center gap-2">
            <span className="text-cyber-cyan text-lg font-bold tracking-wider">POLYMARKET</span>
            <span className="text-term-muted text-lg">MOMENTUM</span>
            <span className="text-term-dim text-xs ml-2">v1.0</span>
          </div>

          {/* Status Indicator */}
          <div className="flex items-center gap-3 pl-4 border-l border-term-border">
            <div className="flex items-center gap-2">
              <div
                className={clsx(
                  'w-2 h-2 rounded-full',
                  isRunning && !isPaused && 'status-dot-online',
                  isPaused && 'status-dot-warning',
                  !isRunning && 'status-dot-offline'
                )}
              />
              <span
                className={clsx(
                  'text-xs font-medium tracking-wider',
                  isRunning && !isPaused && 'text-matrix-green',
                  isPaused && 'text-amber',
                  !isRunning && 'text-hot-pink'
                )}
              >
                {isPaused ? 'PAUSED' : isRunning ? 'RUNNING' : 'OFFLINE'}
              </span>
            </div>
            {state && (
              <span className="text-term-dim text-xs font-mono">
                UP:{formatUptime(state.status.uptime)}
              </span>
            )}
          </div>
        </div>

        {/* Account Summary & Controls */}
        <div className="flex items-center gap-4">
          {state && (
            <div className="flex items-center gap-6 text-sm font-mono">
              {/* Balance */}
              <div className="text-right">
                <span className="text-term-muted text-xs">BAL</span>
                <div className="text-term-text">${formatCurrency(state.account.balance)}</div>
              </div>

              {/* P&L */}
              <div className="text-right">
                <span className="text-term-muted text-xs">P&L</span>
                <div
                  className={clsx(
                    state.account.totalPnl >= 0 ? 'text-profit' : 'text-loss'
                  )}
                >
                  {state.account.totalPnl >= 0 ? '+' : ''}${formatCurrency(state.account.totalPnl)}
                </div>
              </div>

              {/* Drawdown */}
              <div className="text-right">
                <span className="text-term-muted text-xs">DD</span>
                <div
                  className={clsx(
                    'num-fixed',
                    state.account.currentDrawdown > 0.05 ? 'text-hot-pink' : 'text-term-text'
                  )}
                >
                  {(state.account.currentDrawdown * 100).toFixed(2)}%
                </div>
              </div>
            </div>
          )}

          {/* Connection Status */}
          <div className="flex items-center gap-3 px-3 border-l border-term-border">
            <div className="flex items-center gap-2">
              <span className="text-term-dim text-xs">WS:</span>
              {/* Dashboard */}
              <div className="flex items-center gap-1" title="Dashboard WebSocket">
                <div className={clsx('w-1.5 h-1.5 rounded-full', isConnected ? 'bg-matrix-green' : 'bg-hot-pink')} />
                <span className={clsx('text-xs', isConnected ? 'text-matrix-green' : 'text-hot-pink')}>D</span>
              </div>
              {/* Binance */}
              {state && (
                <div className="flex items-center gap-1" title="Binance WebSocket">
                  <div className={clsx('w-1.5 h-1.5 rounded-full', state.connections.binance ? 'bg-matrix-green' : 'bg-hot-pink')} />
                  <span className={clsx('text-xs', state.connections.binance ? 'text-matrix-green' : 'text-hot-pink')}>B</span>
                </div>
              )}
              {/* Polymarket */}
              {state && (
                <div className="flex items-center gap-1" title="Polymarket WebSocket">
                  <div className={clsx('w-1.5 h-1.5 rounded-full', state.connections.polymarket ? 'bg-matrix-green' : 'bg-hot-pink')} />
                  <span className={clsx('text-xs', state.connections.polymarket ? 'text-matrix-green' : 'text-hot-pink')}>P</span>
                </div>
              )}
            </div>
          </div>

          {/* Pause/Resume Button */}
          <button
            onClick={isPaused ? onResume : onPause}
            disabled={!isRunning}
            className={clsx(
              'terminal-btn flex items-center gap-2',
              isPaused ? 'border-matrix-green/50 text-matrix-green hover:border-matrix-green hover:bg-matrix-green/10' : 'terminal-btn-danger',
              !isRunning && 'opacity-40 cursor-not-allowed'
            )}
          >
            {isPaused ? (
              <>
                <Play className="h-3 w-3" />
                <span>RESUME</span>
              </>
            ) : (
              <>
                <Pause className="h-3 w-3" />
                <span>PAUSE</span>
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;

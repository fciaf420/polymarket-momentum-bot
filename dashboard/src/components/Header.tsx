import { Activity, Pause, Play, Wifi, WifiOff } from 'lucide-react';
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

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function Header({ state, isConnected, onPause, onResume }: HeaderProps) {
  const isPaused = state?.status.paused ?? false;
  const isRunning = state?.status.isRunning ?? false;

  return (
    <header className="bg-slate-800/80 border-b border-slate-700 px-6 py-4">
      <div className="flex items-center justify-between">
        {/* Logo and Title */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Activity className="h-8 w-8 text-emerald-500" />
            <div>
              <h1 className="text-xl font-bold text-white">Polymarket Momentum Bot</h1>
              <p className="text-xs text-slate-400">15-Minute Crypto Prediction Markets</p>
            </div>
          </div>

          {/* Status Badge */}
          <div className="flex items-center gap-2 ml-4">
            <span
              className={clsx(
                'badge',
                isRunning && !isPaused && 'badge-green',
                isPaused && 'badge-yellow',
                !isRunning && 'badge-gray'
              )}
            >
              {isPaused ? 'PAUSED' : isRunning ? 'RUNNING' : 'STOPPED'}
            </span>
            {state && (
              <span className="text-xs text-slate-400">
                Uptime: {formatUptime(state.status.uptime)}
              </span>
            )}
          </div>
        </div>

        {/* Account Summary */}
        <div className="flex items-center gap-6">
          {state && (
            <>
              <div className="text-right">
                <div className="text-xs text-slate-400">Balance</div>
                <div className="text-lg font-semibold text-white">
                  {formatCurrency(state.account.balance)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-400">Total P&L</div>
                <div
                  className={clsx(
                    'text-lg font-semibold',
                    state.account.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                  )}
                >
                  {state.account.totalPnl >= 0 ? '+' : ''}
                  {formatCurrency(state.account.totalPnl)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-400">Drawdown</div>
                <div
                  className={clsx(
                    'text-lg font-semibold',
                    state.account.currentDrawdown > 0.05 ? 'text-red-400' : 'text-slate-300'
                  )}
                >
                  {(state.account.currentDrawdown * 100).toFixed(1)}%
                </div>
              </div>
            </>
          )}

          {/* Controls */}
          <div className="flex items-center gap-3 ml-4 border-l border-slate-700 pl-4">
            {/* WebSocket Connections */}
            <div className="flex items-center gap-2">
              {/* Dashboard WS */}
              <div className="flex items-center gap-1" title="Dashboard WebSocket">
                {isConnected ? (
                  <Wifi className="h-3 w-3 text-emerald-400" />
                ) : (
                  <WifiOff className="h-3 w-3 text-red-400" />
                )}
                <span className={clsx('text-xs', isConnected ? 'text-emerald-400' : 'text-red-400')}>
                  Dash
                </span>
              </div>

              {/* Binance WS */}
              {state && (
                <div className="flex items-center gap-1" title="Binance WebSocket">
                  {state.connections.binance ? (
                    <Wifi className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <WifiOff className="h-3 w-3 text-red-400" />
                  )}
                  <span className={clsx('text-xs', state.connections.binance ? 'text-emerald-400' : 'text-red-400')}>
                    BN
                  </span>
                </div>
              )}

              {/* Polymarket WS */}
              {state && (
                <div className="flex items-center gap-1" title="Polymarket WebSocket">
                  {state.connections.polymarket ? (
                    <Wifi className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <WifiOff className="h-3 w-3 text-red-400" />
                  )}
                  <span className={clsx('text-xs', state.connections.polymarket ? 'text-emerald-400' : 'text-red-400')}>
                    PM
                  </span>
                </div>
              )}
            </div>

            {/* Pause/Resume Button */}
            <button
              onClick={isPaused ? onResume : onPause}
              disabled={!isRunning}
              className={clsx(
                'flex items-center gap-1 px-3 py-1.5 rounded text-sm font-medium transition-colors',
                isPaused
                  ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                  : 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30',
                !isRunning && 'opacity-50 cursor-not-allowed'
              )}
            >
              {isPaused ? (
                <>
                  <Play className="h-4 w-4" /> Resume
                </>
              ) : (
                <>
                  <Pause className="h-4 w-4" /> Pause
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Header;

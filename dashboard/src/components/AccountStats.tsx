import { clsx } from 'clsx';
import type { DashboardState } from '../types';

interface AccountStatsProps {
  state: DashboardState;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function AccountStats({ state }: AccountStatsProps) {
  const { account, risk, trades, positions } = state;

  const totalPnlPercent = account.initialBalance > 0
    ? (account.totalPnl / account.initialBalance) * 100
    : 0;

  const stats = [
    {
      label: 'BALANCE',
      value: `$${formatCurrency(account.balance)}`,
      sub: `init: $${formatCurrency(account.initialBalance)}`,
      color: 'text-term-text',
    },
    {
      label: 'TOTAL P&L',
      value: `${account.totalPnl >= 0 ? '+' : ''}$${formatCurrency(account.totalPnl)}`,
      sub: `${totalPnlPercent >= 0 ? '+' : ''}${totalPnlPercent.toFixed(2)}%`,
      color: account.totalPnl >= 0 ? 'text-profit' : 'text-loss',
    },
    {
      label: 'DRAWDOWN',
      value: formatPercent(account.currentDrawdown),
      sub: `max: ${formatPercent(risk.metrics.maxDrawdown)}`,
      color: account.currentDrawdown > 0.05 ? 'text-loss' : 'text-term-text',
    },
    {
      label: 'WIN RATE',
      value: formatPercent(trades.summary.winRate),
      sub: `${trades.summary.winningTrades}W/${trades.summary.losingTrades}L`,
      color: trades.summary.winRate > 0.5 ? 'text-profit' : 'text-loss',
    },
    {
      label: 'TRADES',
      value: trades.summary.totalTrades.toString(),
      sub: `avg: $${formatCurrency(trades.summary.averagePnl)}`,
      color: 'text-cyber-cyan',
    },
    {
      label: 'POSITIONS',
      value: `${positions.length}/${risk.limits.maxPositions}`,
      sub: positions.length > 0 ? 'ACTIVE' : 'NONE',
      color: positions.length > 0 ? 'text-amber' : 'text-term-muted',
    },
  ];

  return (
    <div className="terminal-panel">
      <div className="terminal-header">ACCOUNT</div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {stats.map((stat) => (
          <div key={stat.label} className="border-l-2 border-term-border pl-3">
            <div className="text-term-muted text-xs tracking-wider mb-1">{stat.label}</div>
            <div className={clsx('text-lg font-semibold num-fixed', stat.color)}>{stat.value}</div>
            <div className="text-term-dim text-xs num-fixed">{stat.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AccountStats;

import { TrendingUp, TrendingDown, Wallet, Target, BarChart3, Activity } from 'lucide-react';
import { clsx } from 'clsx';
import type { DashboardState } from '../types';

interface AccountStatsProps {
  state: DashboardState;
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
  return `${(value * 100).toFixed(2)}%`;
}

interface StatCardProps {
  title: string;
  value: string;
  subValue?: string;
  icon: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
}

function StatCard({ title, value, subValue, icon, trend }: StatCardProps) {
  return (
    <div className="card">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-slate-400 mb-1">{title}</p>
          <p
            className={clsx(
              'text-2xl font-bold',
              trend === 'up' && 'text-emerald-400',
              trend === 'down' && 'text-red-400',
              !trend && 'text-white'
            )}
          >
            {value}
          </p>
          {subValue && <p className="text-xs text-slate-400 mt-1">{subValue}</p>}
        </div>
        <div className="p-2 bg-slate-700/50 rounded-lg">{icon}</div>
      </div>
    </div>
  );
}

export function AccountStats({ state }: AccountStatsProps) {
  const { account, risk, trades, positions } = state;

  const totalPnlPercent = account.initialBalance > 0
    ? ((account.totalPnl / account.initialBalance) * 100).toFixed(2)
    : '0.00';

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      <StatCard
        title="Account Balance"
        value={formatCurrency(account.balance)}
        subValue={`Initial: ${formatCurrency(account.initialBalance)}`}
        icon={<Wallet className="h-5 w-5 text-blue-400" />}
      />

      <StatCard
        title="Total P&L"
        value={`${account.totalPnl >= 0 ? '+' : ''}${formatCurrency(account.totalPnl)}`}
        subValue={`${account.totalPnl >= 0 ? '+' : ''}${totalPnlPercent}%`}
        icon={
          account.totalPnl >= 0 ? (
            <TrendingUp className="h-5 w-5 text-emerald-400" />
          ) : (
            <TrendingDown className="h-5 w-5 text-red-400" />
          )
        }
        trend={account.totalPnl >= 0 ? 'up' : 'down'}
      />

      <StatCard
        title="Drawdown"
        value={formatPercent(account.currentDrawdown)}
        subValue={`Max: ${formatPercent(risk.metrics.maxDrawdown)}`}
        icon={<BarChart3 className="h-5 w-5 text-yellow-400" />}
        trend={account.currentDrawdown > 0.05 ? 'down' : 'neutral'}
      />

      <StatCard
        title="Win Rate"
        value={formatPercent(trades.summary.winRate)}
        subValue={`${trades.summary.winningTrades}W / ${trades.summary.losingTrades}L`}
        icon={<Target className="h-5 w-5 text-purple-400" />}
        trend={trades.summary.winRate > 0.5 ? 'up' : 'down'}
      />

      <StatCard
        title="Total Trades"
        value={trades.summary.totalTrades.toString()}
        subValue={`Avg P&L: ${formatCurrency(trades.summary.averagePnl)}`}
        icon={<Activity className="h-5 w-5 text-cyan-400" />}
      />

      <StatCard
        title="Open Positions"
        value={positions.length.toString()}
        subValue={`Max: ${risk.limits.maxPositions}`}
        icon={<BarChart3 className="h-5 w-5 text-orange-400" />}
      />
    </div>
  );
}

export default AccountStats;

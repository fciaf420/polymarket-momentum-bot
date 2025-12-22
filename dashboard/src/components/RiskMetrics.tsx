import { Shield, AlertTriangle, TrendingUp, Target, BarChart3 } from 'lucide-react';
import { clsx } from 'clsx';
import type { DashboardState } from '../types';

interface RiskMetricsProps {
  risk: DashboardState['risk'];
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

interface MetricRowProps {
  label: string;
  value: string;
  limit?: string;
  isWarning?: boolean;
  isCritical?: boolean;
  icon?: React.ReactNode;
}

function MetricRow({ label, value, limit, isWarning, isCritical, icon }: MetricRowProps) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-700/50 last:border-0">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-slate-400">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'font-medium',
            isCritical && 'text-red-400',
            isWarning && !isCritical && 'text-yellow-400',
            !isWarning && !isCritical && 'text-white'
          )}
        >
          {value}
        </span>
        {limit && <span className="text-xs text-slate-500">/ {limit}</span>}
      </div>
    </div>
  );
}

export function RiskMetrics({ risk }: RiskMetricsProps) {
  const { metrics, limits } = risk;

  const maxDrawdownPercent = limits.maxDrawdown * 100;
  const drawdownRatio = metrics.currentDrawdown / limits.maxDrawdown;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Shield className="h-5 w-5 text-blue-400" />
          Risk Metrics
        </h2>
        {drawdownRatio > 0.7 && (
          <span className="badge badge-red">
            <AlertTriangle className="h-3 w-3 mr-1" />
            High Risk
          </span>
        )}
      </div>

      {/* Drawdown Progress Bar */}
      <div className="mb-4">
        <div className="flex justify-between text-sm mb-1">
          <span className="text-slate-400">Drawdown</span>
          <span className={clsx(drawdownRatio > 0.7 ? 'text-red-400' : 'text-white')}>
            {formatPercent(metrics.currentDrawdown)}
          </span>
        </div>
        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
          <div
            className={clsx(
              'h-full rounded-full transition-all',
              drawdownRatio > 0.8 ? 'bg-red-500' : drawdownRatio > 0.5 ? 'bg-yellow-500' : 'bg-emerald-500'
            )}
            style={{ width: `${Math.min(drawdownRatio * 100, 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-slate-500 mt-1">
          <span>0%</span>
          <span>Max: {maxDrawdownPercent.toFixed(0)}%</span>
        </div>
      </div>

      <div className="space-y-1">
        <MetricRow
          label="Max Drawdown"
          value={formatPercent(metrics.maxDrawdown)}
          limit={formatPercent(limits.maxDrawdown)}
          isWarning={metrics.maxDrawdown > limits.maxDrawdown * 0.5}
          isCritical={metrics.maxDrawdown > limits.maxDrawdown * 0.8}
          icon={<BarChart3 className="h-4 w-4 text-slate-500" />}
        />

        <MetricRow
          label="Daily P&L"
          value={`${metrics.dailyPnl >= 0 ? '+' : ''}${formatCurrency(metrics.dailyPnl)}`}
          icon={<TrendingUp className="h-4 w-4 text-slate-500" />}
        />

        <MetricRow
          label="Total P&L"
          value={`${metrics.totalPnl >= 0 ? '+' : ''}${formatCurrency(metrics.totalPnl)}`}
          icon={<TrendingUp className="h-4 w-4 text-slate-500" />}
        />

        <MetricRow
          label="Win Rate"
          value={formatPercent(metrics.winRate)}
          isWarning={metrics.winRate < 0.4}
          icon={<Target className="h-4 w-4 text-slate-500" />}
        />

        <MetricRow
          label="Profit Factor"
          value={metrics.profitFactor.toFixed(2)}
          isWarning={metrics.profitFactor < 1}
          icon={<BarChart3 className="h-4 w-4 text-slate-500" />}
        />

        <MetricRow
          label="Sharpe Ratio"
          value={metrics.sharpeRatio.toFixed(2)}
          isWarning={metrics.sharpeRatio < 1}
          icon={<BarChart3 className="h-4 w-4 text-slate-500" />}
        />

        <MetricRow
          label="Position Concentration"
          value={formatPercent(metrics.positionConcentration)}
          isWarning={metrics.positionConcentration > 0.4}
          isCritical={metrics.positionConcentration > 0.6}
          icon={<Shield className="h-4 w-4 text-slate-500" />}
        />

        <MetricRow
          label="Total Exposure"
          value={formatCurrency(metrics.totalExposure)}
          icon={<BarChart3 className="h-4 w-4 text-slate-500" />}
        />
      </div>
    </div>
  );
}

export default RiskMetrics;

import { Settings, Zap, Target, Shield, Clock, DollarSign } from 'lucide-react';
import { clsx } from 'clsx';
import type { TradingConfig as TradingConfigType } from '../types';

interface TradingConfigProps {
  config: TradingConfigType;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function TradingConfig({ config }: TradingConfigProps) {
  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Settings className="h-5 w-5 text-blue-400" />
        Trading Config
        {config.dryRun && (
          <span className="ml-auto text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded">
            DRY RUN
          </span>
        )}
        {config.backtest && (
          <span className="ml-auto text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded">
            BACKTEST
          </span>
        )}
      </h2>

      <div className="space-y-3">
        {/* Entry Thresholds */}
        <div className="border border-slate-700 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300 mb-2">
            <Target className="h-4 w-4 text-emerald-400" />
            Entry Thresholds
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Move %</span>
              <span className={clsx(
                'font-mono font-medium',
                config.moveThreshold <= 0.015 ? 'text-amber-400' : 'text-white'
              )}>
                {formatPercent(config.moveThreshold)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Gap %</span>
              <span className={clsx(
                'font-mono font-medium',
                config.gapThreshold <= 0.02 ? 'text-amber-400' : 'text-white'
              )}>
                {formatPercent(config.gapThreshold)}
              </span>
            </div>
          </div>
        </div>

        {/* Position Sizing */}
        <div className="border border-slate-700 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300 mb-2">
            <DollarSign className="h-4 w-4 text-yellow-400" />
            Position Sizing
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Size</span>
              <span className="font-mono font-medium text-white">
                {formatPercent(config.positionSizePct)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Max Pos</span>
              <span className="font-mono font-medium text-white">
                {config.maxPositions}
              </span>
            </div>
            <div className="flex justify-between col-span-2">
              <span className="text-slate-400">Min Liquidity</span>
              <span className="font-mono font-medium text-white">
                {formatCurrency(config.minLiquidity)}
              </span>
            </div>
          </div>
        </div>

        {/* Exit Rules */}
        <div className="border border-slate-700 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300 mb-2">
            <Clock className="h-4 w-4 text-cyan-400" />
            Exit Rules
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Exit Gap</span>
              <span className="font-mono font-medium text-white">
                {formatPercent(config.exitGapThreshold)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Max Hold</span>
              <span className="font-mono font-medium text-white">
                {config.maxHoldMinutes}m
              </span>
            </div>
          </div>
        </div>

        {/* Risk Limits */}
        <div className="border border-slate-700 rounded-lg p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300 mb-2">
            <Shield className="h-4 w-4 text-red-400" />
            Risk Limits
          </div>
          <div className="text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Max Drawdown</span>
              <span className="font-mono font-medium text-red-400">
                {formatPercent(config.maxDrawdown)}
              </span>
            </div>
          </div>
        </div>

        {/* Aggressive Indicator */}
        {(config.moveThreshold <= 0.015 || config.gapThreshold <= 0.02) && (
          <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg p-2">
            <Zap className="h-4 w-4" />
            <span>Aggressive settings - more signals, higher risk</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default TradingConfig;

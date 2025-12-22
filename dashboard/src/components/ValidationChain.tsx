import { CheckCircle, XCircle, MinusCircle, Activity, Zap } from 'lucide-react';
import { clsx } from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import type { AssetValidation, ValidationCheck, CryptoAsset } from '../types';

interface ValidationChainProps {
  validation: AssetValidation[];
}

// Crypto logo URLs from CoinGecko CDN
const ASSET_LOGOS: Record<CryptoAsset, string> = {
  BTC: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
  ETH: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  SOL: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
  XRP: 'https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png',
};

const ASSET_COLORS: Record<CryptoAsset, string> = {
  BTC: 'orange',
  ETH: 'purple',
  SOL: 'cyan',
  XRP: 'slate',
};

function StatusIcon({ status }: { status: ValidationCheck['status'] }) {
  switch (status) {
    case 'passed':
      return <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-400" />;
    case 'skipped':
      return <MinusCircle className="h-3.5 w-3.5 text-slate-500" />;
  }
}

function CheckRow({ check }: { check: ValidationCheck }) {
  return (
    <div className={clsx(
      'flex items-center justify-between py-1 px-2 rounded text-xs',
      check.status === 'passed' && 'bg-emerald-500/10',
      check.status === 'failed' && 'bg-red-500/10',
      check.status === 'skipped' && 'bg-slate-800/50'
    )}>
      <div className="flex items-center gap-2">
        <StatusIcon status={check.status} />
        <span className={clsx(
          check.status === 'passed' && 'text-emerald-400',
          check.status === 'failed' && 'text-red-400',
          check.status === 'skipped' && 'text-slate-500'
        )}>
          {check.name}
        </span>
      </div>
      <div className="flex items-center gap-2 text-slate-400">
        {check.value && (
          <span className="font-mono">{check.value}</span>
        )}
        {check.threshold && (
          <>
            <span className="text-slate-600">/</span>
            <span className="font-mono text-slate-500">{check.threshold}</span>
          </>
        )}
      </div>
    </div>
  );
}

function AssetValidationCard({ validation }: { validation: AssetValidation }) {
  const color = ASSET_COLORS[validation.asset];
  const logo = ASSET_LOGOS[validation.asset];
  const passedCount = validation.checks.filter(c => c.status === 'passed').length;
  const totalChecks = validation.checks.filter(c => c.status !== 'skipped').length;

  return (
    <div className="border border-slate-700 rounded-lg p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center bg-${color}-500/20 p-1`}>
            <img
              src={logo}
              alt={validation.asset}
              className="w-full h-full object-contain"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                e.currentTarget.nextElementSibling?.classList.remove('hidden');
              }}
            />
            <span className={`text-${color}-400 font-bold text-xs hidden`}>{validation.asset}</span>
          </div>
          <span className="text-white font-medium text-sm">{validation.asset}</span>
        </div>
        <div className="flex items-center gap-2">
          {validation.finalResult === 'signal_triggered' && (
            <span className="flex items-center gap-1 text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded">
              <Zap className="h-3 w-3" />
              SIGNAL
            </span>
          )}
          {validation.finalResult === 'blocked' && (
            <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded">
              BLOCKED
            </span>
          )}
          {validation.finalResult === 'no_opportunity' && (
            <span className="text-xs bg-slate-700 text-slate-400 px-2 py-0.5 rounded">
              WAITING
            </span>
          )}
          <span className="text-xs text-slate-500">
            {passedCount}/{totalChecks}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-slate-700 rounded-full overflow-hidden mb-2">
        <div
          className={clsx(
            'h-full transition-all',
            validation.finalResult === 'signal_triggered' && 'bg-emerald-500',
            validation.finalResult === 'blocked' && 'bg-gradient-to-r from-emerald-500 to-red-500',
            validation.finalResult === 'no_opportunity' && 'bg-gradient-to-r from-emerald-500 to-amber-500'
          )}
          style={{ width: `${(passedCount / Math.max(totalChecks, 1)) * 100}%` }}
        />
      </div>

      {/* Checks list */}
      <div className="space-y-1">
        {validation.checks.map((check, idx) => (
          <CheckRow key={idx} check={check} />
        ))}
      </div>

      {/* Block reason */}
      {validation.blockReason && (
        <div className="mt-2 pt-2 border-t border-slate-700/50">
          <p className="text-xs text-red-400">
            {validation.blockReason}
          </p>
        </div>
      )}

      {/* Last updated */}
      <div className="mt-2 text-[10px] text-slate-600">
        Updated {formatDistanceToNow(validation.timestamp, { addSuffix: true })}
      </div>
    </div>
  );
}

export function ValidationChain({ validation }: ValidationChainProps) {
  if (!validation || validation.length === 0) {
    return (
      <div className="card">
        <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <Activity className="h-5 w-5 text-blue-400" />
          Signal Validation
        </h2>
        <div className="text-center py-8 text-slate-400">
          <Activity className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>Waiting for validation data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Activity className="h-5 w-5 text-blue-400" />
        Signal Validation
        <span className="ml-auto text-xs text-slate-500 font-normal">
          Real-time check status
        </span>
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {validation.map((v) => (
          <AssetValidationCard key={v.asset} validation={v} />
        ))}
      </div>
    </div>
  );
}

export default ValidationChain;

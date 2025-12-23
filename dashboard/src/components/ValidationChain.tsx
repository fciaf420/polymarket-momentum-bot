import { clsx } from 'clsx';
import type { AssetValidation, ValidationCheck } from '../types';

interface ValidationChainProps {
  validation: AssetValidation[];
}

function CheckIcon({ status }: { status: ValidationCheck['status'] }) {
  switch (status) {
    case 'passed':
      return <span className="text-matrix-green">[✓]</span>;
    case 'failed':
      return <span className="text-hot-pink">[✗]</span>;
    case 'skipped':
      return <span className="text-term-dim">[—]</span>;
  }
}

function CheckRow({ check }: { check: ValidationCheck }) {
  return (
    <div className={clsx(
      'flex items-center justify-between py-0.5 text-xs font-mono',
      check.status === 'passed' && 'text-matrix-green',
      check.status === 'failed' && 'text-hot-pink',
      check.status === 'skipped' && 'text-term-dim'
    )}>
      <div className="flex items-center gap-2">
        <CheckIcon status={check.status} />
        <span>{check.name}</span>
      </div>
      <div className="flex items-center gap-1 text-term-muted">
        {check.value && <span className="num-fixed">{check.value}</span>}
        {check.threshold && (
          <>
            <span className="text-term-dim">/</span>
            <span className="num-fixed text-term-dim">{check.threshold}</span>
          </>
        )}
      </div>
    </div>
  );
}

function AssetValidationBlock({ validation }: { validation: AssetValidation }) {
  const passedCount = validation.checks.filter(c => c.status === 'passed').length;
  const totalChecks = validation.checks.filter(c => c.status !== 'skipped').length;

  return (
    <div className="border border-term-border p-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-2 pb-1 border-b border-term-border">
        <div className="flex items-center gap-2">
          <span className="text-cyber-cyan font-bold">{validation.asset}</span>
          <span className="text-term-dim text-xs">[{passedCount}/{totalChecks}]</span>
        </div>
        <span className={clsx(
          'text-xs px-2 py-0.5',
          validation.finalResult === 'signal_triggered' && 'text-matrix-green bg-matrix-green/10',
          validation.finalResult === 'blocked' && 'text-hot-pink bg-hot-pink/10',
          validation.finalResult === 'no_opportunity' && 'text-term-muted bg-term-bg'
        )}>
          {validation.finalResult === 'signal_triggered' && '⚡ SIGNAL'}
          {validation.finalResult === 'blocked' && '✗ BLOCKED'}
          {validation.finalResult === 'no_opportunity' && '— WAITING'}
        </span>
      </div>

      {/* Checks */}
      <div className="space-y-0.5">
        {validation.checks.map((check, idx) => (
          <CheckRow key={idx} check={check} />
        ))}
      </div>

      {/* Block reason */}
      {validation.blockReason && (
        <div className="mt-2 pt-1 border-t border-term-border text-xs text-hot-pink">
          ! {validation.blockReason}
        </div>
      )}
    </div>
  );
}

export function ValidationChain({ validation }: ValidationChainProps) {
  if (!validation || validation.length === 0) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">VALIDATION</div>
        <div className="text-center py-4">
          <div className="text-term-dim text-sm">[ AWAITING DATA ]</div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">VALIDATION</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {validation.map((v) => (
          <AssetValidationBlock key={v.asset} validation={v} />
        ))}
      </div>
    </div>
  );
}

export default ValidationChain;

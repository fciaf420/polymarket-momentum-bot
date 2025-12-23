import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import type { TradingConfig } from '../types';
import { api } from '../services/api';

interface ConfigBannerProps {
  config: TradingConfig;
  onConfigUpdated?: (config: TradingConfig) => void;
}

interface EditableConfig {
  positionSizePct: string;
  gapThreshold: string;
  moveThreshold: string;
  maxPositions: string;
  minLiquidity: string;
  maxHoldMinutes: string;
  exitGapThreshold: string;
  maxDrawdown: string;
  maxEntrySlippage: string;
}

type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

function configToEditable(config: TradingConfig): EditableConfig {
  return {
    positionSizePct: (config.positionSizePct * 100).toFixed(2),
    gapThreshold: (config.gapThreshold * 100).toFixed(2),
    moveThreshold: (config.moveThreshold * 100).toFixed(2),
    maxPositions: config.maxPositions.toString(),
    minLiquidity: config.minLiquidity.toString(),
    maxHoldMinutes: config.maxHoldMinutes.toString(),
    exitGapThreshold: (config.exitGapThreshold * 100).toFixed(2),
    maxDrawdown: (config.maxDrawdown * 100).toFixed(1),
    maxEntrySlippage: ((config.maxEntrySlippage || 0.15) * 100).toFixed(0),
  };
}

function editableToConfig(editable: EditableConfig): Partial<TradingConfig> {
  return {
    positionSizePct: parseFloat(editable.positionSizePct) / 100,
    gapThreshold: parseFloat(editable.gapThreshold) / 100,
    moveThreshold: parseFloat(editable.moveThreshold) / 100,
    maxPositions: parseInt(editable.maxPositions),
    minLiquidity: parseFloat(editable.minLiquidity),
    maxHoldMinutes: parseInt(editable.maxHoldMinutes),
    exitGapThreshold: parseFloat(editable.exitGapThreshold) / 100,
    maxDrawdown: parseFloat(editable.maxDrawdown) / 100,
    maxEntrySlippage: parseFloat(editable.maxEntrySlippage) / 100,
  };
}

export function ConfigBanner({ config, onConfigUpdated }: ConfigBannerProps) {
  const [editable, setEditable] = useState<EditableConfig>(configToEditable(config));
  const [hasChanges, setHasChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (saveStatus !== 'saving') {
      const newEditable = configToEditable(config);
      setEditable(newEditable);
      setHasChanges(false);
    }
  }, [config, saveStatus]);

  const checkChanges = useCallback((newEditable: EditableConfig) => {
    const original = configToEditable(config);
    const changed = Object.keys(newEditable).some(
      (key) => newEditable[key as keyof EditableConfig] !== original[key as keyof EditableConfig]
    );
    setHasChanges(changed);
  }, [config]);

  const handleChange = (key: keyof EditableConfig, value: string) => {
    const newEditable = { ...editable, [key]: value };
    setEditable(newEditable);
    checkChanges(newEditable);
    setErrorMessage(null);
    if (saveStatus === 'success' || saveStatus === 'error') {
      setSaveStatus('idle');
    }
  };

  const handleReset = () => {
    setEditable(configToEditable(config));
    setHasChanges(false);
    setErrorMessage(null);
    setSaveStatus('idle');
  };

  const handleSave = async () => {
    setSaveStatus('saving');
    setErrorMessage(null);

    try {
      const updates = editableToConfig(editable);
      const response = await api.updateConfig(updates);

      if (response.success && response.config) {
        setSaveStatus('success');
        setHasChanges(false);
        onConfigUpdated?.(response.config);
        setTimeout(() => setSaveStatus('idle'), 3000);
      } else {
        setSaveStatus('error');
        setErrorMessage(response.errors?.join(', ') || response.error || 'Unknown error');
      }
    } catch (error) {
      setSaveStatus('error');
      setErrorMessage((error as Error).message);
    }
  };

  const isAggressive =
    parseFloat(editable.moveThreshold) <= 1.5 ||
    parseFloat(editable.gapThreshold) <= 2;

  const configItems: Array<{
    key: keyof EditableConfig;
    label: string;
    suffix: string;
    warn?: boolean;
    danger?: boolean;
  }> = [
    { key: 'positionSizePct', label: 'POS%', suffix: '%' },
    { key: 'gapThreshold', label: 'GAP%', suffix: '%', warn: parseFloat(editable.gapThreshold) <= 2 },
    { key: 'moveThreshold', label: 'MOVE%', suffix: '%', warn: parseFloat(editable.moveThreshold) <= 1.5 },
    { key: 'maxPositions', label: 'MAX_POS', suffix: '' },
    { key: 'minLiquidity', label: 'MIN_LIQ', suffix: '$' },
    { key: 'exitGapThreshold', label: 'EXIT%', suffix: '%' },
    { key: 'maxHoldMinutes', label: 'HOLD', suffix: 'm' },
    { key: 'maxEntrySlippage', label: 'SLIP%', suffix: '%' },
    { key: 'maxDrawdown', label: 'MAX_DD', suffix: '%', danger: true },
  ];

  return (
    <div className="bg-term-bg border-b border-term-border px-4 py-3">
      {/* Header Row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-cyber-cyan text-xs font-medium tracking-wider">CONFIG</span>
          {config.dryRun && (
            <span className="text-amber text-xs px-2 py-0.5 border border-amber/30 bg-amber/10">DRY RUN</span>
          )}
          {isAggressive && (
            <span className="text-hot-pink text-xs px-2 py-0.5 border border-hot-pink/30 bg-hot-pink/10 animate-pulse">
              ! AGGRESSIVE
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {hasChanges && (
            <button
              onClick={handleReset}
              className="text-term-muted text-xs hover:text-term-text transition-colors"
            >
              [RESET]
            </button>
          )}

          <button
            onClick={handleSave}
            disabled={!hasChanges || saveStatus === 'saving'}
            className={clsx(
              'terminal-btn text-xs',
              hasChanges && saveStatus !== 'saving' && 'border-matrix-green/50 text-matrix-green hover:border-matrix-green hover:bg-matrix-green/10',
              saveStatus === 'success' && 'border-matrix-green text-matrix-green',
              saveStatus === 'error' && 'border-hot-pink text-hot-pink',
              !hasChanges && saveStatus === 'idle' && 'opacity-40 cursor-not-allowed'
            )}
          >
            {saveStatus === 'saving' && '[SAVING...]'}
            {saveStatus === 'success' && '[✓ SAVED]'}
            {saveStatus === 'error' && '[✗ ERROR]'}
            {saveStatus === 'idle' && '[SAVE]'}
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="mb-3 px-2 py-1 border border-hot-pink/30 bg-hot-pink/5 text-xs text-hot-pink">
          ! {errorMessage}
        </div>
      )}

      {/* Config Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {configItems.map((item) => (
          <div key={item.key} className="space-y-1">
            <label className="text-term-dim text-[10px] tracking-wider">{item.label}</label>
            <div className="relative">
              <input
                type="number"
                step={item.key === 'maxPositions' ? '1' : '0.1'}
                value={editable[item.key]}
                onChange={(e) => handleChange(item.key, e.target.value)}
                className={clsx(
                  'terminal-input w-full text-xs py-1 pr-6',
                  item.warn && 'border-amber text-amber',
                  item.danger && 'border-hot-pink/50 text-hot-pink'
                )}
              />
              {item.suffix && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-term-dim">
                  {item.suffix}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ConfigBanner;

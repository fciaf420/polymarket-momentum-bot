import { useState, useEffect, useCallback } from 'react';
import { Settings, Save, RotateCcw, Check, AlertTriangle, Zap } from 'lucide-react';
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
  };
}

export function ConfigBanner({ config, onConfigUpdated }: ConfigBannerProps) {
  const [editable, setEditable] = useState<EditableConfig>(configToEditable(config));
  const [hasChanges, setHasChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Update editable when config prop changes (e.g., from WebSocket)
  useEffect(() => {
    if (saveStatus !== 'saving') {
      const newEditable = configToEditable(config);
      setEditable(newEditable);
      setHasChanges(false);
    }
  }, [config, saveStatus]);

  // Check if values have changed
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

        // Reset status after 3 seconds
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

  return (
    <div className="bg-slate-800/50 border-b border-slate-700 px-6 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <Settings className="h-5 w-5 text-blue-400" />
          <h2 className="text-sm font-semibold text-white">Trading Configuration</h2>

          {config.dryRun && (
            <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded">
              DRY RUN
            </span>
          )}

          {isAggressive && (
            <span className="text-xs bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded flex items-center gap-1">
              <Zap className="h-3 w-3" />
              AGGRESSIVE
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {hasChanges && (
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white transition-colors"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
          )}

          <button
            onClick={handleSave}
            disabled={!hasChanges || saveStatus === 'saving'}
            className={clsx(
              'flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded transition-all',
              hasChanges && saveStatus !== 'saving'
                ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                : saveStatus === 'success'
                ? 'bg-emerald-500/20 text-emerald-400'
                : saveStatus === 'error'
                ? 'bg-red-500/20 text-red-400'
                : 'bg-slate-700 text-slate-500 cursor-not-allowed'
            )}
          >
            {saveStatus === 'saving' ? (
              <>
                <div className="h-3.5 w-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving...
              </>
            ) : saveStatus === 'success' ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Saved!
              </>
            ) : saveStatus === 'error' ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5" />
                Error
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5" />
                Save & Apply
              </>
            )}
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
          {errorMessage}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {/* Position Size */}
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Position %
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="100"
              value={editable.positionSizePct}
              onChange={(e) => handleChange('positionSizePct', e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-blue-500 focus:outline-none"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
          </div>
        </div>

        {/* Gap Threshold */}
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Gap %
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="50"
              value={editable.gapThreshold}
              onChange={(e) => handleChange('gapThreshold', e.target.value)}
              className={clsx(
                'w-full bg-slate-900 border rounded px-2 py-1.5 text-sm font-mono focus:outline-none',
                parseFloat(editable.gapThreshold) <= 2
                  ? 'border-amber-500/50 text-amber-400 focus:border-amber-500'
                  : 'border-slate-700 text-white focus:border-blue-500'
              )}
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
          </div>
        </div>

        {/* Move Threshold */}
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Move %
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="50"
              value={editable.moveThreshold}
              onChange={(e) => handleChange('moveThreshold', e.target.value)}
              className={clsx(
                'w-full bg-slate-900 border rounded px-2 py-1.5 text-sm font-mono focus:outline-none',
                parseFloat(editable.moveThreshold) <= 1.5
                  ? 'border-amber-500/50 text-amber-400 focus:border-amber-500'
                  : 'border-slate-700 text-white focus:border-blue-500'
              )}
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
          </div>
        </div>

        {/* Max Positions */}
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Max Pos
          </label>
          <input
            type="number"
            step="1"
            min="1"
            max="10"
            value={editable.maxPositions}
            onChange={(e) => handleChange('maxPositions', e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-blue-500 focus:outline-none"
          />
        </div>

        {/* Min Liquidity */}
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Min Liq $
          </label>
          <input
            type="number"
            step="100"
            min="0"
            value={editable.minLiquidity}
            onChange={(e) => handleChange('minLiquidity', e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-blue-500 focus:outline-none"
          />
        </div>

        {/* Exit Gap */}
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Exit Gap %
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="50"
              value={editable.exitGapThreshold}
              onChange={(e) => handleChange('exitGapThreshold', e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-blue-500 focus:outline-none"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
          </div>
        </div>

        {/* Max Hold */}
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Max Hold
          </label>
          <div className="relative">
            <input
              type="number"
              step="1"
              min="1"
              max="14"
              value={editable.maxHoldMinutes}
              onChange={(e) => handleChange('maxHoldMinutes', e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-blue-500 focus:outline-none"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">m</span>
          </div>
        </div>

        {/* Max Drawdown */}
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">
            Max DD %
          </label>
          <div className="relative">
            <input
              type="number"
              step="1"
              min="1"
              max="100"
              value={editable.maxDrawdown}
              onChange={(e) => handleChange('maxDrawdown', e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-red-400 font-mono focus:border-red-500 focus:outline-none"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ConfigBanner;

import { ArrowUp, ArrowDown, Minus, Activity } from 'lucide-react';
import type { MoveProgress as MoveProgressType } from '../types';

interface MoveProgressProps {
  moveProgress: MoveProgressType[];
}

export function MoveProgress({ moveProgress }: MoveProgressProps) {
  if (!moveProgress || moveProgress.length === 0) {
    return (
      <div className="bg-slate-800 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="h-5 w-5 text-purple-400" />
          <h2 className="text-lg font-semibold text-white">Move Progress</h2>
        </div>
        <p className="text-slate-400 text-sm">Waiting for price data...</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-5 w-5 text-purple-400" />
        <h2 className="text-lg font-semibold text-white">Hard Move Progress</h2>
        <span className="text-xs text-slate-500 ml-auto">
          Threshold: {(moveProgress[0]?.threshold * 100).toFixed(2)}%
        </span>
      </div>

      <div className="space-y-3">
        {moveProgress.map((item) => (
          <MoveProgressBar key={item.asset} data={item} />
        ))}
      </div>
    </div>
  );
}

function MoveProgressBar({ data }: { data: MoveProgressType }) {
  const { asset, currentMovePercent, direction, progress, durationSeconds } = data;

  const getDirectionIcon = () => {
    if (direction === 'up') return <ArrowUp className="h-4 w-4 text-emerald-400" />;
    if (direction === 'down') return <ArrowDown className="h-4 w-4 text-red-400" />;
    return <Minus className="h-4 w-4 text-slate-400" />;
  };

  const getProgressBarColor = () => {
    if (progress >= 0.8) return 'bg-yellow-500'; // Almost there!
    if (direction === 'up') return 'bg-emerald-500/70';
    if (direction === 'down') return 'bg-red-500/70';
    return 'bg-slate-600';
  };

  const progressPercent = Math.min(progress * 100, 100);
  const movePercentDisplay = (Math.abs(currentMovePercent) * 100).toFixed(3);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium text-white w-10">{asset}</span>
          {getDirectionIcon()}
          <span className={direction === 'up' ? 'text-emerald-400' : direction === 'down' ? 'text-red-400' : 'text-slate-400'}>
            {direction === 'flat' ? '0.000' : (direction === 'up' ? '+' : '-')}{movePercentDisplay}%
          </span>
        </div>
        <div className="flex items-center gap-2 text-slate-400">
          <span className="text-xs">{durationSeconds.toFixed(0)}s</span>
          <span className="text-xs font-mono w-12 text-right">
            {progressPercent.toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${getProgressBarColor()}`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>
    </div>
  );
}

export default MoveProgress;

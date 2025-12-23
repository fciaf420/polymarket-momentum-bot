import { clsx } from 'clsx';
import type { MoveProgress as MoveProgressType } from '../types';

interface MoveProgressProps {
  moveProgress: MoveProgressType[];
}

function AsciiProgressBar({ progress, direction, width = 20 }: { progress: number; direction: string; width?: number }) {
  const filled = Math.round(Math.min(progress, 1) * width);
  const empty = width - filled;

  const barColor = progress >= 0.8 ? 'text-amber' : direction === 'up' ? 'text-matrix-green' : direction === 'down' ? 'text-hot-pink' : 'text-term-dim';

  return (
    <span className="font-mono text-xs">
      [<span className={barColor}>{'█'.repeat(filled)}</span>
      <span className="text-term-dim">{'░'.repeat(empty)}</span>]
    </span>
  );
}

function MoveProgressRow({ data }: { data: MoveProgressType }) {
  const { asset, currentMovePercent, direction, progress, durationSeconds } = data;
  const movePercentDisplay = (Math.abs(currentMovePercent) * 100).toFixed(3);
  const progressPercent = (Math.min(progress, 1) * 100).toFixed(0);

  return (
    <div className="flex items-center gap-2 py-1 text-xs font-mono">
      {/* Asset */}
      <span className="text-cyber-cyan w-8 font-semibold">{asset}</span>

      {/* Direction indicator */}
      <span className={clsx(
        'w-20',
        direction === 'up' && 'text-matrix-green',
        direction === 'down' && 'text-hot-pink',
        direction === 'flat' && 'text-term-dim'
      )}>
        {direction === 'up' && `▲ +${movePercentDisplay}%`}
        {direction === 'down' && `▼ -${movePercentDisplay}%`}
        {direction === 'flat' && `— 0.000%`}
      </span>

      {/* Progress bar */}
      <AsciiProgressBar progress={progress} direction={direction} width={15} />

      {/* Progress percentage */}
      <span className={clsx(
        'w-10 text-right num-fixed',
        progress >= 0.8 ? 'text-amber' : 'text-term-muted'
      )}>
        {progressPercent}%
      </span>

      {/* Duration */}
      <span className="text-term-dim w-10 text-right">{durationSeconds.toFixed(0)}s</span>
    </div>
  );
}

export function MoveProgress({ moveProgress }: MoveProgressProps) {
  if (!moveProgress || moveProgress.length === 0) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">MOVE TRACKER</div>
        <div className="text-center py-4">
          <div className="text-term-dim text-sm">[ AWAITING PRICE DATA ]</div>
        </div>
      </div>
    );
  }

  const threshold = moveProgress[0]?.threshold ?? 0.02;

  return (
    <div className="terminal-panel">
      <div className="flex items-center justify-between mb-2">
        <div className="terminal-header">MOVE TRACKER</div>
        <span className="text-term-dim text-xs font-mono">THR: {(threshold * 100).toFixed(1)}%</span>
      </div>

      <div className="space-y-0">
        {moveProgress.map((item) => (
          <MoveProgressRow key={item.asset} data={item} />
        ))}
      </div>
    </div>
  );
}

export default MoveProgress;

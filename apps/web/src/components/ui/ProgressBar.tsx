import React from 'react';
import { joinClassNames } from '@stark-ballot/web/shared/classNames';

/**
 * ProgressBar - finalization progress
 *
 * 集計進捗バー。表示補間は所有する進捗モデルに従う。
 * 非線形補間は application の finalization-progress read model を使用。
 */

export interface ProgressBarProps {
  value: number;
  max: number;
  variant?: 'primary' | 'verified' | 'warning';
  ariaLabel?: string;
}

const calculatePercentage = (value: number, max: number): number => {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
};

export function ProgressBar({ value, max, variant = 'primary', ariaLabel }: ProgressBarProps): React.ReactElement {
  const percentage = calculatePercentage(value, max);

  // State colours do not confer a verification verdict.
  const fillStyles = {
    primary: 'bg-ink-700',
    verified: 'bg-verified-600',
    warning: 'bg-warning-600',
  };

  return (
    <div className="w-full">
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        className="relative h-[5px] w-full overflow-hidden bg-paper-border"
      >
        <div
          data-testid="progress-fill"
          className={joinClassNames('h-full', fillStyles[variant])}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

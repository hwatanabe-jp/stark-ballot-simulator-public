import React from 'react';

/**
 * ProgressBar - 「透明な信頼」デザインシステム
 *
 * 集計進捗バー。8px高さ、墨色グラデーション。
 * 非線形補間は src/lib/finalize/progress-interpolation.ts を使用。
 */

export interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
  showPercentage?: boolean;
  showValue?: boolean;
  format?: (value: number, max: number) => string;
  className?: string;
  variant?: 'primary' | 'verified' | 'warning';
  animate?: boolean;
}

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

const calculatePercentage = (value: number, max: number): number => {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
};

const getDisplayText = (
  value: number,
  max: number,
  percentage: number,
  options: Pick<ProgressBarProps, 'format' | 'showPercentage' | 'showValue'>,
): string | null => {
  const { format, showPercentage, showValue } = options;

  if (format) return format(value, max);
  if (showPercentage) return `${percentage}%`;
  if (showValue) return `${value}/${max}`;
  return null;
};

export function ProgressBar({
  value,
  max,
  label,
  showPercentage = false,
  showValue = false,
  format,
  className,
  variant = 'primary',
  animate = true,
}: ProgressBarProps): React.ReactElement {
  const percentage = calculatePercentage(value, max);
  const displayText = getDisplayText(value, max, percentage, {
    format,
    showPercentage,
    showValue,
  });

  // Variant-specific gradient colors
  const gradientStyles = {
    primary: 'from-ink-600 to-ink-500',
    verified: 'from-verified-600 to-verified-500',
    warning: 'from-warning-600 to-warning-500',
  };

  return (
    <div className={cn('w-full', className)}>
      {label && <div className="mb-2 text-sm font-medium text-text-primary font-secondary">{label}</div>}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
        className="relative w-full bg-paper-border rounded-full overflow-hidden h-2"
      >
        <div
          data-testid="progress-fill"
          className={cn(
            'h-full rounded-full',
            'bg-gradient-to-r',
            gradientStyles[variant],
            animate && 'transition-all duration-300 ease-out',
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {displayText && (
        <div className="mt-2 text-[0.8125rem] text-text-secondary text-center font-mono font-features-none tracking-wide">
          {displayText}
        </div>
      )}
    </div>
  );
}

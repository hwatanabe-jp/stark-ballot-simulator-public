'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { ProgressBar } from '@stark-ballot/web/components/ui/ProgressBar';
import { interpolateProgress } from '@stark-ballot/web/finalize/progress-interpolation';
import { useTranslation } from '@stark-ballot/web/hooks';

type FinalizationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout';

interface ProgressDisplayProps {
  /** Timestamp when job was queued (epoch ms or ISO string) */
  queuedAt?: number | string | null;
  /** Timestamp when job started running (epoch ms or ISO string) */
  startedAt?: number | string | null;
  /** Timestamp when job completed (epoch ms or ISO string) */
  completedAt?: number | string | null;
  /** Estimated duration in milliseconds */
  estimatedDurationMs?: number;
  /** Current status */
  status: FinalizationStatus;
  /** Ignored legacy queue-position props retained only to fail closed for stale callers. */
  queuePosition?: number;
  queueDepth?: number;
  /** Optional concurrency limit */
  concurrencyLimit?: number;
}

const COMPLETION_ANIMATION_DURATION_MS = 500;
const COMPLETION_ANIMATION_INTERVAL_MS = 16;

/**
 * Parse timestamp to epoch milliseconds
 */
function parseTimestamp(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  const parsed = new Date(value).getTime();
  return isNaN(parsed) ? null : parsed;
}

function formatTypicalDuration(estimatedDurationMs: number, translate: ReturnType<typeof useTranslation>['t']): string {
  const seconds = Math.ceil(estimatedDurationMs / 1000);
  if (seconds < 60) {
    return translate('pages.aggregate.progress.estimate.approxSeconds', { seconds });
  }
  return translate('pages.aggregate.progress.estimate.approxMinutes', {
    minutes: Math.ceil(estimatedDurationMs / 60000),
  });
}

/**
 * Get status color variant for progress bar
 */
function getVariant(status: FinalizationStatus): 'primary' | 'verified' | 'warning' {
  switch (status) {
    case 'succeeded':
      return 'verified';
    case 'failed':
    case 'timeout':
      return 'warning';
    case 'running':
    case 'pending':
      return 'primary';
  }
}

/**
 * Progress Display with non-linear interpolation
 *
 * Design spec (design-spec-transparent-trust.md):
 * - Progress is TIME-BASED, not API-driven
 * - Uses interpolateProgress() for non-linear curve
 * - 100% only reached on completion event
 */
export function ProgressDisplay({
  startedAt,
  estimatedDurationMs = 360000,
  status,
  concurrencyLimit,
}: ProgressDisplayProps): React.ReactElement {
  const { t } = useTranslation();
  const [progress, setProgress] = useState(() => (status === 'succeeded' ? 100 : 0));
  const completionIntervalRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const progressRef = useRef(status === 'succeeded' ? 100 : 0);
  const previousStatusRef = useRef<FinalizationStatus | null>(null);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const stopCompletionAnimation = useCallback(() => {
    if (completionIntervalRef.current !== null) {
      window.clearInterval(completionIntervalRef.current);
      completionIntervalRef.current = null;
    }
  }, []);

  const startCompletionAnimation = useCallback(() => {
    stopCompletionAnimation();
    const startProgress = Math.min(99, Math.max(0, progressRef.current));
    const startTime = Date.now();
    completionIntervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const ratio = Math.min(1, Math.max(0, elapsed / COMPLETION_ANIMATION_DURATION_MS));
      const eased = 1 - (1 - ratio) * (1 - ratio);
      const nextValue = Math.round(startProgress + (100 - startProgress) * eased);
      setProgress(nextValue);
      if (ratio >= 1) {
        stopCompletionAnimation();
      }
    }, COMPLETION_ANIMATION_INTERVAL_MS);
  }, [stopCompletionAnimation]);

  // Update progress based on time
  const updateProgress = useCallback(() => {
    if (status === 'succeeded') {
      return;
    }

    if (status === 'failed' || status === 'timeout') {
      // Keep current progress on failure
      return;
    }

    const startMs = parseTimestamp(startedAt);
    if (!startMs || status !== 'running') {
      // Waiting in queue or not started
      setProgress(0);
      return;
    }

    // Store start time for consistent animation
    if (startTimeRef.current === null) {
      startTimeRef.current = startMs;
    }

    const elapsed = Date.now() - startTimeRef.current;
    const newProgress = interpolateProgress(elapsed, estimatedDurationMs);
    const nextProgress = Math.floor(newProgress);
    // Spec: start at 1% once execution begins
    setProgress(nextProgress < 1 ? 1 : nextProgress);
  }, [status, startedAt, estimatedDurationMs]);

  // Animation loop
  useEffect(() => {
    if (status !== 'running') {
      // Reset start time when not running
      startTimeRef.current = null;
      return;
    }

    const timeoutId = window.setTimeout(updateProgress, 0);
    const interval = window.setInterval(updateProgress, 100);
    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(interval);
    };
  }, [status, updateProgress]);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;

    if (status !== 'succeeded') {
      stopCompletionAnimation();
      return;
    }

    if (previousStatus === 'running' || previousStatus === 'pending') {
      const timeoutId = window.setTimeout(startCompletionAnimation, 0);
      return () => window.clearTimeout(timeoutId);
    }

    const timeoutId = window.setTimeout(() => {
      setProgress(100);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [status, startCompletionAnimation, stopCompletionAnimation]);

  // Clean up on unmount
  useEffect(
    () => () => {
      stopCompletionAnimation();
    },
    [stopCompletionAnimation],
  );

  // Get phase description (simplified - queue timing shown in separate panel)
  const getPhaseText = (): string => {
    const withEllipsis = (text: string) => (text.endsWith('...') ? text : `${text}...`);
    if (status === 'pending') {
      return withEllipsis(t('pages.aggregate.progress.phase.waiting'));
    }

    if (status === 'succeeded') {
      return t('pages.aggregate.progress.phase.completed');
    }

    if (status === 'failed') {
      return t('pages.aggregate.progress.phase.error');
    }

    if (status === 'timeout') {
      return t('pages.aggregate.progress.phase.timeout');
    }

    // Running: keep a single, honest label
    return withEllipsis(t('pages.aggregate.progress.phase.processing'));
  };

  const hasQueueInfo = concurrencyLimit !== undefined;
  const variant = getVariant(status);
  const formattedTypicalDuration = formatTypicalDuration(estimatedDurationMs, t);

  return (
    <div className="space-y-3">
      {/* Progress bar */}
      <ProgressBar value={progress} max={100} variant={variant} showPercentage={false} />

      {/* Status text */}
      <div className="flex justify-between items-center text-sm">
        <span className="text-text-secondary">{getPhaseText()}</span>
        <span className="font-mono font-features-none text-text-primary">{progress}%</span>
      </div>

      {/* Queue info panel (shown when pending with queue info) */}
      {status === 'pending' && hasQueueInfo && (
        <div className="mt-4 p-3 bg-paper-cream rounded-lg border border-paper-border">
          <div className="flex items-center gap-2 mb-3">
            <span className="animate-pulse w-2 h-2 rounded-full bg-ink-500" />
            <span className="font-secondary text-sm text-text-secondary">
              {t('pages.aggregate.progress.queue.waiting')}
            </span>
          </div>

          <div className="flex justify-between items-center text-sm">
            <span className="text-text-muted">{t('pages.aggregate.progress.queue.typicalDuration')}</span>
            <span className="font-mono font-features-none text-text-secondary">{formattedTypicalDuration}</span>
          </div>
        </div>
      )}
    </div>
  );
}

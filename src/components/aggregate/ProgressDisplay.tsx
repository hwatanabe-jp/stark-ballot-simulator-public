'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { interpolateProgress } from '@/lib/finalize/progress-interpolation';
import { useTranslation } from '@/lib/hooks';

type FinalizationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'timeout';
type Translate = ReturnType<typeof useTranslation>['t'];

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
  /** Optional queue position */
  queuePosition?: number;
  /** Optional queue depth */
  queueDepth?: number;
  /** Optional concurrency limit */
  concurrencyLimit?: number;
  /** Optional estimated start timestamp */
  estimatedStartAt?: number;
  /** Optional estimated completion timestamp */
  estimatedCompletionAt?: number;
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

/**
 * Format estimated time for display
 * @returns Formatted string, or null if timestamp is undefined (skip display)
 */
function formatEstimatedTime(timestamp: number | undefined, language: string, translate: Translate): string | null {
  if (timestamp === undefined) {
    return null;
  }

  const now = Date.now();
  const diff = timestamp - now;

  // Handle overdue cases
  if (diff <= 0) {
    const overdueMs = -diff;
    const overdueMinutes = Math.floor(overdueMs / 60000);

    // Within 2 minutes overdue: show "Soon"
    if (overdueMinutes < 2) {
      return translate('pages.aggregate.progress.estimate.soon');
    }

    // 2-10 minutes overdue: show "Taking longer"
    if (overdueMinutes < 10) {
      return translate('pages.aggregate.progress.estimate.takingLonger');
    }

    // More than 10 minutes overdue: show actual estimated time (past)
    return new Date(timestamp).toLocaleTimeString(language === 'ja' ? 'ja-JP' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  const seconds = Math.ceil(diff / 1000);
  const minutes = Math.ceil(diff / 60000);

  if (seconds < 60) {
    return translate('pages.aggregate.progress.estimate.approxSeconds', { seconds });
  }

  if (minutes < 10) {
    return translate('pages.aggregate.progress.estimate.approxMinutes', { minutes });
  }

  // For longer waits, show time in HH:MM format
  return new Date(timestamp).toLocaleTimeString(language === 'ja' ? 'ja-JP' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format position/depth for display (cap at 99+)
 */
function formatPosition(value: number): string {
  return value > 99 ? '99+' : String(value);
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
  queuePosition,
  queueDepth,
  estimatedStartAt,
  estimatedCompletionAt,
}: ProgressDisplayProps): React.ReactElement {
  const { language, t } = useTranslation();
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

  // Get phase description (simplified - queue details shown in separate panel)
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

  // Check if we have queue info to display
  const hasQueueInfo =
    queuePosition !== undefined ||
    queueDepth !== undefined ||
    estimatedStartAt !== undefined ||
    estimatedCompletionAt !== undefined;

  const variant = getVariant(status);

  // Format estimated times for display
  const formattedStartTime = formatEstimatedTime(estimatedStartAt, language, t);
  const formattedCompletionTime = formatEstimatedTime(estimatedCompletionAt, language, t);

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

          {/* Queue position */}
          {queuePosition !== undefined && queueDepth !== undefined && (
            <div className="flex justify-between items-center text-sm mb-2">
              <span className="text-text-muted">{t('pages.aggregate.progress.queue.position')}</span>
              <span className="font-mono font-features-none text-ink-700 font-medium">
                {formatPosition(queuePosition)} / {formatPosition(queueDepth)}
              </span>
            </div>
          )}

          {/* Estimated start time */}
          {formattedStartTime && (
            <div className="flex justify-between items-center text-sm mb-2">
              <span className="text-text-muted">{t('pages.aggregate.progress.queue.estStart')}</span>
              <span className="font-mono font-features-none text-text-secondary">{formattedStartTime}</span>
            </div>
          )}

          {/* Estimated completion time */}
          {formattedCompletionTime && (
            <div className="flex justify-between items-center text-sm">
              <span className="text-text-muted">{t('pages.aggregate.progress.queue.estCompletion')}</span>
              <span className="font-mono font-features-none text-text-secondary">{formattedCompletionTime}</span>
            </div>
          )}
        </div>
      )}

      {/* Estimated time remaining (show for running state) */}
      {status === 'running' && progress < 99 && formattedCompletionTime && (
        <p className="text-xs text-text-muted text-center font-mono font-features-none">
          {t('pages.aggregate.progress.estimate.estCompletionLabel')}
          {formattedCompletionTime}
        </p>
      )}
    </div>
  );
}

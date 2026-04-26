'use client';

import { useTranslation } from '@/lib/hooks';
import type { VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';
import { VerificationCard } from '@/components/verification/VerificationCard';

interface VerificationStepProps {
  /** Step identifier */
  id: VerificationStepId;
  /** Step title */
  title: string;
  /** Optional description */
  description?: string;
  /** Current status */
  status: VerificationStepStatus;
  /** Error message if failed */
  error?: string;
  /** Knowledge keys highlighted by this step */
  highlightedKnowledge?: string[];
  /** Callback when step is clicked (for highlight interaction) */
  onClick?: () => void;
}

const cn = (...classes: Array<string | false | undefined>): string => {
  return classes.filter(Boolean).join(' ');
};

/**
 * Check icon SVG with draw animation
 */
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 13l4 4L19 7" className="animate-check" />
    </svg>
  );
}

/**
 * X icon for failed status
 */
function XIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

/**
 * Loading spinner
 */
function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className ?? ''}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/**
 * Get status-specific styles
 */
function getStatusStyles(status: VerificationStepStatus): {
  border: string;
  bg: string;
  iconColor: string;
} {
  switch (status) {
    case 'success':
      return {
        border: 'border-verified-500',
        bg: 'bg-verified-50',
        iconColor: 'text-verified-600',
      };
    case 'failed':
      return {
        border: 'border-error-500',
        bg: 'bg-error-50',
        iconColor: 'text-error-600',
      };
    case 'running':
      return {
        border: 'border-ink-400',
        bg: 'bg-ink-50',
        iconColor: 'text-ink-500',
      };
    case 'pending':
    case 'not_run':
    default:
      return {
        border: 'border-paper-border',
        bg: 'bg-paper-cream',
        iconColor: 'text-text-muted',
      };
  }
}

/**
 * Verification Step - Individual verification step display
 *
 * Design spec:
 * - Pending: paper-cream bg, paper-border
 * - Running: ink-50 bg, ink-300 border, spinner
 * - Success: verified-50 bg, verified-500 border, checkmark with animation
 * - Failed: error-50 bg, error-500 border, X icon
 */
export function VerificationStep({
  id,
  title,
  description,
  status,
  error,
  highlightedKnowledge,
  onClick,
}: VerificationStepProps): React.ReactElement {
  const { t } = useTranslation();
  const styles = getStatusStyles(status);
  const isClickable = Boolean(onClick);

  // Render status icon
  const renderIcon = () => {
    switch (status) {
      case 'success':
        return <CheckIcon className="w-5 h-5" />;
      case 'failed':
        return <XIcon className="w-5 h-5" />;
      case 'running':
        return <Spinner className="w-5 h-5" />;
      case 'not_run':
      case 'pending':
        return <div className="w-5 h-5 rounded-full border-2 border-current opacity-50" />;
    }
  };

  // Get step name for screen readers
  const getStepLabel = (): string => {
    const labels: Record<VerificationStepId, string> = {
      cast_as_intended: 'verification.steps.castAsIntended',
      recorded_as_cast: 'verification.steps.recordedAsCast',
      counted_as_recorded: 'verification.steps.countedAsRecorded',
      stark_verification: 'verification.steps.starkVerification',
    };
    return t(labels[id]);
  };

  const statusLabels: Record<VerificationStepStatus, string> = {
    pending: 'verification.status.pending',
    running: 'verification.status.running',
    success: 'verification.status.success',
    failed: 'verification.status.failed',
    not_run: 'verification.status.notRun',
  };

  const statusLabel = t(statusLabels[status]);

  return (
    <VerificationCard
      title={title}
      verified={status === 'success'}
      className={cn(
        'transition-all duration-200',
        styles.border,
        styles.bg,
        isClickable && 'cursor-pointer hover:shadow-md',
      )}
      onClick={onClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onClick?.();
              }
            }
          : undefined
      }
      aria-label={`${getStepLabel()}: ${statusLabel}`}
    >
      <div className="flex items-start gap-3">
        {/* Status icon */}
        <div className={`flex-shrink-0 ${styles.iconColor}`}>{renderIcon()}</div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {description && <p className="text-sm text-text-secondary">{description}</p>}
          {error && <p className="text-sm text-error-600 mt-2 p-2 bg-error-100 rounded">{error}</p>}
          {highlightedKnowledge && highlightedKnowledge.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {highlightedKnowledge.map((key) => (
                <span key={key} className="text-xs px-1.5 py-0.5 rounded bg-ink-100 text-ink-600 font-mono">
                  {key}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Status badge */}
        <div className="flex-shrink-0">
          {status === 'success' && (
            <span className="text-xs px-2 py-1 rounded-full bg-verified-100 text-verified-700 font-medium">
              {t('verification.status.success')}
            </span>
          )}
          {status === 'failed' && (
            <span className="text-xs px-2 py-1 rounded-full bg-error-100 text-error-700 font-medium">
              {t('verification.status.failed')}
            </span>
          )}
          {status === 'running' && (
            <span className="text-xs px-2 py-1 rounded-full bg-ink-100 text-ink-700 font-medium">
              {t('verification.status.running')}
            </span>
          )}
        </div>
      </div>
    </VerificationCard>
  );
}

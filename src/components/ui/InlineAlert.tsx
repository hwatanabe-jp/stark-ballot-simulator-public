import type { ReactElement } from 'react';

interface InlineAlertProps {
  message: string;
  variant: 'info' | 'error' | 'success' | 'warning';
  className?: string;
  'data-testid'?: string;
}

/**
 * InlineAlert - Lightweight status message display
 *
 * A simpler alternative to StatusCard for inline feedback within cards.
 * Uses semantic colors from the "Transparent Trust" design system.
 */
export function InlineAlert({
  message,
  variant,
  className = '',
  'data-testid': dataTestId,
}: InlineAlertProps): ReactElement {
  const variantStyles = {
    error: 'bg-error-100 border-error-500 text-error-700',
    success: 'bg-verified-100 border-verified-500 text-verified-700',
    warning: 'bg-warning-100 border-warning-500 text-warning-700',
    info: 'bg-info-100 border-info-500 text-info-600',
  };

  const ariaLive = variant === 'error' ? 'assertive' : 'polite';
  const role = variant === 'error' || variant === 'success' ? 'alert' : 'status';

  return (
    <div
      data-testid={dataTestId}
      role={role}
      aria-live={ariaLive}
      aria-atomic="true"
      className={`rounded-md border px-3 py-2 text-sm font-secondary ${variantStyles[variant]} ${className}`}
    >
      {message}
    </div>
  );
}

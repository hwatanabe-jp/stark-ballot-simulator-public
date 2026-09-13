'use client';

import { Button } from '@stark-ballot/web/components/ui/Button';
import { useTranslation } from '@stark-ballot/web/hooks';

interface FinalizeButtonProps {
  /** Click handler */
  onClick: () => void;
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Whether the button is in loading state */
  loading?: boolean;
  /** Optional additional className */
  className?: string;
}

/**
 * Finalize Button - CTA for starting aggregation
 *
 * Uses the shared primary action style.
 */
export function FinalizeButton({
  onClick,
  disabled = false,
  loading = false,
  className,
}: FinalizeButtonProps): React.ReactElement {
  const { t } = useTranslation();

  const buttonText = loading ? t('pages.aggregate.executing') : t('pages.aggregate.execute');

  return (
    <Button
      variant="verify"
      onClick={onClick}
      disabled={disabled}
      loading={loading}
      className={className}
      data-testid="execute-button"
    >
      {buttonText}
    </Button>
  );
}

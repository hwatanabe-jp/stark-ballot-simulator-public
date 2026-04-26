import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedVerificationCard } from './UnifiedVerificationCard';

vi.mock('@/lib/hooks', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/knowledge', () => ({
  useKnowledgeHighlight: () => ({
    setHighlightedKeys: vi.fn(),
  }),
}));

const baseStepStatusMap = {
  cast_as_intended: { status: 'success' },
  recorded_as_cast: { status: 'success' },
  counted_as_recorded: { status: 'success' },
  stark_verification: { status: 'success' },
} as const;

const baseDownload = {
  available: false,
  status: 'idle' as const,
  source: null,
  error: null,
  onDownload: vi.fn(),
};

describe('UnifiedVerificationCard', () => {
  it('exposes step header status test ids and normalizes not_run to pending in the UI', () => {
    render(
      <UnifiedVerificationCard
        summary={null}
        visibleStepCount={1}
        sequenceComplete={false}
        stepStatusMap={{
          ...baseStepStatusMap,
          cast_as_intended: { status: 'not_run' },
        }}
        download={baseDownload}
      />,
    );

    expect(screen.getByTestId('step-cast_as_intended')).toHaveAttribute('data-status', 'pending');
    expect(screen.getByTestId('check-cast_receipt_present')).toHaveAttribute('data-status', 'pending');
  });

  it('renders a localized fallback message for operational step errors', () => {
    render(
      <UnifiedVerificationCard
        summary={null}
        visibleStepCount={2}
        sequenceComplete={false}
        stepStatusMap={{
          ...baseStepStatusMap,
          recorded_as_cast: {
            status: 'failed',
            error: 'Failed to fetch consistency proof: 500 Internal Server Error',
          },
        }}
        download={baseDownload}
      />,
    );

    expect(screen.getByText('pages.verify.stepsCard.errors.generic')).toBeInTheDocument();
  });

  it('does not show fallback message for integrity failures', () => {
    render(
      <UnifiedVerificationCard
        summary={null}
        visibleStepCount={3}
        sequenceComplete={false}
        stepStatusMap={{
          ...baseStepStatusMap,
          counted_as_recorded: { status: 'failed', error: 'excludedSlots=1' },
        }}
        download={baseDownload}
      />,
    );

    expect(screen.queryByText('pages.verify.stepsCard.errors.generic')).not.toBeInTheDocument();
  });

  it('renders status badges for verification items', () => {
    render(
      <UnifiedVerificationCard
        summary={null}
        visibleStepCount={1}
        sequenceComplete={false}
        stepStatusMap={{
          ...baseStepStatusMap,
          cast_as_intended: { status: 'pending' },
        }}
        download={baseDownload}
      />,
    );

    const item = screen.getByTestId('check-cast_receipt_present');
    expect(within(item).getByText('pages.verify.stepsCard.status.pending')).toBeInTheDocument();
  });
});

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VERIFICATION_CHECK_DEFINITIONS, type VerificationCheck } from '@stark-ballot/verification/checks';
import { UnifiedVerificationCard } from './UnifiedVerificationCard';

vi.mock('@stark-ballot/web/hooks', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@stark-ballot/web/components/knowledge', () => ({
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

  it('renders demo-only summaries as non-verified warning summaries', () => {
    render(
      <UnifiedVerificationCard
        summary={{
          status: 'demo_only',
          message: 'pages.verify.resultSummary.demoOnlyMain',
          subMessage: 'pages.verify.resultSummary.demoOnlySub',
        }}
        visibleStepCount={4}
        sequenceComplete={true}
        stepStatusMap={baseStepStatusMap}
        download={baseDownload}
      />,
    );

    const summary = screen.getByTestId('result-summary');
    expect(summary).toHaveAttribute('data-status', 'demo_only');
    expect(within(summary).getByText('pages.verify.resultSummary.demoOnlyMain')).toBeInTheDocument();
  });

  it('renders successful demo evidence without verified row styling', () => {
    render(
      <UnifiedVerificationCard
        summary={{
          status: 'demo_only',
          message: 'pages.verify.resultSummary.demoOnlyMain',
          subMessage: 'pages.verify.resultSummary.demoOnlySub',
        }}
        verificationChecks={[
          {
            id: 'stark_image_id_match',
            status: 'success',
            evidence: 'zk',
            inputs: [],
          },
          {
            id: 'stark_receipt_verify',
            status: 'success',
            evidence: 'demo',
            inputs: [],
          },
        ]}
        visibleStepCount={4}
        sequenceComplete={true}
        stepStatusMap={baseStepStatusMap}
        download={baseDownload}
      />,
    );

    const row = screen.getByTestId('check-stark_receipt_verify');
    expect(row).toHaveAttribute('data-status', 'success');
    expect(row).toHaveAttribute('data-visual-status', 'demo');
    expect(within(row).getAllByText('pages.verify.stepsCard.evidence.demo')).toHaveLength(2);
    expect(within(row).queryByText('pages.verify.stepsCard.status.success')).not.toBeInTheDocument();
    expect(screen.getByTestId('step-stark_verification')).toHaveAttribute('data-visual-status', 'demo');
  });

  it('keeps known failed STARK-dependent checks terminal while proof evidence is still gated', () => {
    render(
      <UnifiedVerificationCard
        summary={null}
        verificationChecks={[
          {
            id: 'counted_missing_indices_zero',
            status: 'failed',
            evidence: 'zk',
            inputs: [],
          },
        ]}
        starkGateStatus="pending"
        visibleStepCount={3}
        sequenceComplete={false}
        stepStatusMap={baseStepStatusMap}
        download={baseDownload}
      />,
    );

    expect(screen.getByTestId('check-counted_missing_indices_zero')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByTestId('step-counted_as_recorded')).toHaveAttribute('data-status', 'failed');
  });

  it('renders an omitted required detail check as incomplete instead of inheriting category success', () => {
    const checks: VerificationCheck[] = VERIFICATION_CHECK_DEFINITIONS.filter(
      (definition) => definition.id !== 'stark_receipt_verify',
    ).map((definition) => ({
      id: definition.id,
      status: 'success',
      evidence: definition.evidence,
      inputs: definition.inputs,
    }));

    render(
      <UnifiedVerificationCard
        summary={null}
        verificationChecks={checks}
        visibleStepCount={4}
        sequenceComplete={true}
        stepStatusMap={baseStepStatusMap}
        download={baseDownload}
      />,
    );

    const row = screen.getByTestId('check-stark_receipt_verify');
    expect(row).toHaveAttribute('data-status', 'pending');
    expect(row).toHaveAttribute('data-visual-status', 'pending');
    expect(within(row).getByText('pages.verify.stepsCard.status.pending')).toBeInTheDocument();
    expect(within(row).queryByText('pages.verify.stepsCard.status.success')).not.toBeInTheDocument();
    expect(screen.getByTestId('step-stark_verification')).not.toHaveAttribute('data-status', 'success');
    expect(screen.getByTestId('step-stark_verification')).not.toHaveAttribute('data-visual-status', 'success');
  });
});

import { describe, expect, it } from 'vitest';
import {
  resolveVerifyPageOverallStatusOverride,
  resolveVerifyPageRenderReadiness,
  resolveVerifyPageRenderedOverallStatus,
  resolveVerifyPageStatusForSummaryTone,
  type VerifyPageOverallStatus,
  type VerifyPageOverallStatusOverrideSource,
} from './overall-status';
import type { VerificationSummaryTone } from '@stark-ballot/verification/summary';
import displayCasesJson from '../../../../../../docs/formal/generated-vectors/verification-display-cases.json';

interface FormalDisplayCase {
  name: string;
  verificationStarted: boolean;
  sequenceComplete: boolean;
  hasCheckPending: boolean;
  explicitServerFailureStatus: VerifyPageOverallStatus | null;
  summaryTone: VerificationSummaryTone | null;
  hasVerificationChecks: boolean;
  hardFailureDetected: boolean;
  expectedOverrideSource: VerifyPageOverallStatusOverrideSource | null;
  expectedOverrideStatus: VerifyPageOverallStatus | null;
  expectedRenderedStatus: VerifyPageOverallStatus | null;
}

const displayCases = displayCasesJson as FormalDisplayCase[];

describe('formal verify page display vectors', () => {
  it.each(displayCases)('$name', (testCase) => {
    const summaryStatus = testCase.summaryTone ? resolveVerifyPageStatusForSummaryTone(testCase.summaryTone) : null;

    const override = resolveVerifyPageOverallStatusOverride({
      explicitServerFailureStatus: testCase.explicitServerFailureStatus,
      summaryStatus,
      hasVerificationChecks: testCase.hasVerificationChecks,
      hardFailureDetected: testCase.hardFailureDetected,
      hasCheckPending: testCase.hasCheckPending,
    });

    expect(override?.source ?? null).toBe(testCase.expectedOverrideSource);
    expect(override?.status ?? null).toBe(testCase.expectedOverrideStatus);

    const renderedStatus = resolveVerifyPageRenderedOverallStatus(
      resolveVerifyPageRenderReadiness({
        verificationStarted: testCase.verificationStarted,
        sequenceComplete: testCase.sequenceComplete,
        hasCheckPending: testCase.hasCheckPending,
        overrideStatus: override?.status ?? null,
      }),
    );

    expect(renderedStatus).toBe(testCase.expectedRenderedStatus);
    if (testCase.expectedRenderedStatus !== 'verified') {
      expect(renderedStatus).not.toBe('verified');
    }
  });

  it('does not render verified when no verification checks can produce a summary', () => {
    const override = resolveVerifyPageOverallStatusOverride({
      explicitServerFailureStatus: null,
      summaryStatus: null,
      hasVerificationChecks: false,
      hardFailureDetected: false,
      hasCheckPending: false,
    });

    expect(override).toBeNull();
    expect(
      resolveVerifyPageRenderedOverallStatus(
        resolveVerifyPageRenderReadiness({
          verificationStarted: true,
          sequenceComplete: true,
          hasCheckPending: false,
          overrideStatus: override?.status ?? null,
        }),
      ),
    ).toBeNull();
  });

  it('does not render verified when checks exist but all are unknown', () => {
    const override = resolveVerifyPageOverallStatusOverride({
      explicitServerFailureStatus: null,
      summaryStatus: null,
      hasVerificationChecks: true,
      hardFailureDetected: false,
      hasCheckPending: false,
    });

    expect(override).toBeNull();
    expect(
      resolveVerifyPageRenderedOverallStatus(
        resolveVerifyPageRenderReadiness({
          verificationStarted: true,
          sequenceComplete: true,
          hasCheckPending: false,
          overrideStatus: override?.status ?? null,
        }),
      ),
    ).toBeNull();
  });

  it('maps demo summaries to a non-verified rendered status', () => {
    const summaryStatus = resolveVerifyPageStatusForSummaryTone('demo');
    const override = resolveVerifyPageOverallStatusOverride({
      explicitServerFailureStatus: null,
      summaryStatus,
      hasVerificationChecks: true,
      hardFailureDetected: false,
      hasCheckPending: false,
    });

    expect(summaryStatus).toBe('demo_only');
    expect(override).toEqual({ source: 'summary', status: 'demo_only' });
    expect(
      resolveVerifyPageRenderedOverallStatus(
        resolveVerifyPageRenderReadiness({
          verificationStarted: true,
          sequenceComplete: true,
          hasCheckPending: false,
          overrideStatus: override?.status ?? null,
        }),
      ),
    ).toBe('demo_only');
  });
});

import { describe, expect, it } from 'vitest';
import {
  resolveVerifyPageOverallStatusOverride,
  resolveVerifyPageRenderedOverallStatus,
  resolveVerifyPageStatusForSummaryTone,
  type VerifyPageOverallStatus,
  type VerifyPageOverallStatusOverrideSource,
} from '@/app/(routes)/verify/lib/overall-status';
import type { VerificationSummaryTone } from '@/lib/verification/verification-summary';
import displayCasesJson from '../../../../../docs/current/formal/generated-vectors/verification-display-cases.json';

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

    const renderedStatus = resolveVerifyPageRenderedOverallStatus({
      verificationStarted: testCase.verificationStarted,
      sequenceComplete: testCase.sequenceComplete,
      hasCheckPending: testCase.hasCheckPending,
      overrideStatus: override?.status ?? null,
    });

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
      resolveVerifyPageRenderedOverallStatus({
        verificationStarted: true,
        sequenceComplete: true,
        hasCheckPending: false,
        overrideStatus: override?.status ?? null,
      }),
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
      resolveVerifyPageRenderedOverallStatus({
        verificationStarted: true,
        sequenceComplete: true,
        hasCheckPending: false,
        overrideStatus: override?.status ?? null,
      }),
    ).toBeNull();
  });
});

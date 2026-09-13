import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import {
  countFailedRequiredChecksForObservation,
  emitVerificationRunSummaryObservation,
} from './verificationObservability';

const canonicalEventMocks = vi.hoisted(() => ({
  emitCanonicalEvent: vi.fn(),
}));

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: canonicalEventMocks.emitCanonicalEvent,
}));

const sessionId = 'session-verification-observability-1';
const finalizationId = 'execution-verification-observability-1';
const validVerificationReport = {
  status: 'success' as const,
  verifier_version: '0.1.0',
  verified_at: '2026-07-13T00:00:00.000Z',
  duration_ms: 42,
  expected_image_id: `0x${'12'.repeat(32)}`,
  receipt_image_id: `0x${'12'.repeat(32)}`,
  dev_mode_receipt: false,
} as const;

function buildChecks(
  overrides: Partial<Record<VerificationCheckId, VerificationCheck['status']>> = {},
): VerificationCheck[] {
  return VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    status: overrides[definition.id] ?? 'success',
    evidence: definition.evidence,
    inputs: [...definition.inputs],
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));
}

function verificationResult(
  result: VerificationResult = {
    status: 'success',
    report: validVerificationReport,
  },
): VerificationResult {
  return result;
}

describe('verification observability', () => {
  beforeEach(() => {
    canonicalEventMocks.emitCanonicalEvent.mockReset();
  });

  it.each(['failed', 'pending', 'running', 'not_run'] as const)(
    'independently counts a required raw check in non-success status %s',
    (status) => {
      expect(
        countFailedRequiredChecksForObservation(buildChecks({ counted_input_sanity: status }), {
          sthSourcesConfigured: false,
        }),
      ).toBe(1);
    },
  );

  it('counts missing required definitions and runtime-required STH without counting degraded optional checks', () => {
    const checks = buildChecks({ recorded_sth_third_party: 'failed' }).filter(
      (check) => check.id !== 'counted_input_sanity',
    );

    expect(countFailedRequiredChecksForObservation(checks, { sthSourcesConfigured: false })).toBe(1);
    expect(countFailedRequiredChecksForObservation(checks, { sthSourcesConfigured: true })).toBe(2);
  });

  it('emits a closed summary from persisted scenario/report state after presentation', () => {
    const checks = buildChecks({ counted_input_sanity: 'failed' });

    emitVerificationRunSummaryObservation({
      checks,
      summaryContext: {
        sthSourcesConfigured: false,
        devModeEvidence: false,
      },
      persistedScenarios: ['S2'],
      verificationResult: verificationResult(),
      sessionId,
      finalizationId,
    });

    expect(canonicalEventMocks.emitCanonicalEvent).toHaveBeenCalledOnce();
    expect(canonicalEventMocks.emitCanonicalEvent).toHaveBeenCalledWith({
      event: 'verification_run_summary',
      outcome: 'counted_integrity_failed',
      failure_category: 'none',
      scenario_id: 'S2',
      failed_required_count: 1,
      dev_mode_receipt: false,
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalization_id: finalizationId,
    });
    expect(JSON.stringify(canonicalEventMocks.emitCanonicalEvent.mock.calls)).not.toContain(sessionId);
  });

  it('reads dev-mode evidence from the trusted persisted verifier report', () => {
    emitVerificationRunSummaryObservation({
      checks: buildChecks(),
      summaryContext: { devModeEvidence: true },
      persistedScenarios: [],
      verificationResult: verificationResult({
        status: 'dev_mode',
        report: {
          ...validVerificationReport,
          status: 'dev_mode',
          dev_mode_receipt: true,
        },
      }),
      sessionId,
      finalizationId,
    });

    expect(canonicalEventMocks.emitCanonicalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'demo_only',
        failure_category: 'none',
        scenario_id: 'S0',
        dev_mode_receipt: true,
      }),
    );
  });

  it.each(['verifier_crash', 'corrupt_bundle', 's3_denied', 's3_missing', 'timeout', 'unknown'] as const)(
    'uses only the trusted persisted infrastructure category %s',
    (failureCategory) => {
      emitVerificationRunSummaryObservation({
        checks: buildChecks({ stark_receipt_verify: 'failed' }),
        summaryContext: {},
        persistedScenarios: ['S0'],
        verificationResult: { status: 'failed', failureCategory },
        sessionId,
        finalizationId,
      });

      expect(canonicalEventMocks.emitCanonicalEvent).toHaveBeenCalledWith(
        expect.objectContaining({ failure_category: failureCategory }),
      );
    },
  );

  it('does not guess verifier crash from a reportless failure without a persisted category', () => {
    emitVerificationRunSummaryObservation({
      checks: buildChecks({ stark_receipt_verify: 'failed' }),
      summaryContext: {},
      persistedScenarios: ['S0'],
      verificationResult: { status: 'failed' },
      sessionId,
      finalizationId,
    });

    expect(canonicalEventMocks.emitCanonicalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ failure_category: 'unknown' }),
    );
  });

  it('keeps a verifier-reported product failure separate from infrastructure failure', () => {
    emitVerificationRunSummaryObservation({
      checks: buildChecks({ stark_receipt_verify: 'failed' }),
      summaryContext: {},
      persistedScenarios: ['S0'],
      verificationResult: verificationResult({
        status: 'failed',
        report: {
          ...validVerificationReport,
          status: 'failed',
          errors: ['Invalid proof'],
        },
      }),
      sessionId,
      finalizationId,
    });

    expect(canonicalEventMocks.emitCanonicalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ failure_category: 'none' }),
    );
  });

  it('does not guess a scenario when persisted server authority is missing or invalid', () => {
    for (const persistedScenarios of [undefined, ['request-forged-S4'], ['S1', 'S2']] as const) {
      emitVerificationRunSummaryObservation({
        checks: buildChecks(),
        summaryContext: {},
        persistedScenarios,
        verificationResult: verificationResult(),
        sessionId,
        finalizationId,
      });
    }

    expect(canonicalEventMocks.emitCanonicalEvent).not.toHaveBeenCalled();
  });

  it('swallows telemetry failures so they cannot alter a completed verification response', () => {
    canonicalEventMocks.emitCanonicalEvent.mockImplementationOnce(() => {
      throw new Error('telemetry unavailable');
    });

    expect(() =>
      emitVerificationRunSummaryObservation({
        checks: buildChecks(),
        summaryContext: {},
        persistedScenarios: [],
        verificationResult: verificationResult(),
        sessionId,
        finalizationId,
      }),
    ).not.toThrow();
  });
});

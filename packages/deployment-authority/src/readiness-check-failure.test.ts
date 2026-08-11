import { describe, expect, it } from 'vitest';
import { validateReadinessCheckFailureEvidence } from './readiness-check-failure.js';

const CONTROL_SOURCE_SHA = 'c'.repeat(40);

function failureFixture(
  evidenceType: 'app-rollback-readiness-check-failed' | 'dynamodb-recovery-readiness-check-failed',
) {
  return {
    evidenceType,
    targetKey: 'stark-dev/develop',
    controlSourceSha: CONTROL_SOURCE_SHA,
    startedAt: '2026-08-02T01:02:03.000Z',
    finishedAt: '2026-08-02T01:03:04.000Z',
    failureStage: evidenceType === 'app-rollback-readiness-check-failed' ? 'candidate-admission' : 'manifest-admission',
    result: 'check-failed',
    planSummary: null,
    reportOnly: true,
  };
}

describe('readiness check-failure evidence', () => {
  it.each(['app-rollback-readiness-check-failed', 'dynamodb-recovery-readiness-check-failed'] as const)(
    'admits the exact current %s semantic record',
    (evidenceType) => {
      const evidence = validateReadinessCheckFailureEvidence(failureFixture(evidenceType));

      expect(evidence).toEqual(failureFixture(evidenceType));
      expect(Object.isFrozen(evidence)).toBe(true);
    },
  );

  it('rejects unknown fields, target/source drift, and cross-kind failure stages', () => {
    const rollback = failureFixture('app-rollback-readiness-check-failed');
    const recovery = failureFixture('dynamodb-recovery-readiness-check-failed');

    expect(() => validateReadinessCheckFailureEvidence({ ...rollback, rawError: 'secret' })).toThrow(
      /contain exactly/u,
    );
    expect(() => validateReadinessCheckFailureEvidence({ ...rollback, targetKey: 'other/develop' })).toThrow(/target/u);
    expect(() => validateReadinessCheckFailureEvidence({ ...rollback, controlSourceSha: 'short' })).toThrow(/source/u);
    expect(() => validateReadinessCheckFailureEvidence({ ...rollback, failureStage: recovery.failureStage })).toThrow(
      /failure stage/u,
    );
  });

  it('rejects invalid timestamps, reversed time, and non-report-only result coordinates', () => {
    const failure = failureFixture('app-rollback-readiness-check-failed');

    expect(() => validateReadinessCheckFailureEvidence({ ...failure, startedAt: '2026-08-02' })).toThrow(
      /canonical UTC timestamp/u,
    );
    expect(() =>
      validateReadinessCheckFailureEvidence({
        ...failure,
        startedAt: '2026-08-02T01:03:04.000Z',
        finishedAt: '2026-08-02T01:02:03.000Z',
      }),
    ).toThrow(/must not precede/u);
    for (const override of [{ result: 'ready' }, { planSummary: {} }, { reportOnly: false }]) {
      expect(() => validateReadinessCheckFailureEvidence({ ...failure, ...override })).toThrow(
        /check-failed|plan summary|report-only/u,
      );
    }
  });
});

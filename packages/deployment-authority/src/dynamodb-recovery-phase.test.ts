import { describe, expect, it } from 'vitest';
import {
  DYNAMODB_RECOVERY_PHASES,
  evaluateDynamoDbRecoveryPhaseTransition,
  parseDynamoDbRecoveryPhase,
  validateDynamoDbRecoverySelection,
  type DynamoDbRecoveryPhase,
  type DynamoDbRecoverySelection,
} from './dynamodb-recovery-phase.js';

const MANIFEST = Object.freeze({
  key: `recovery-manifests/stark-dev/develop/${'a'.repeat(64)}.json`,
  versionId: 'manifest-version',
  sha256: 'b'.repeat(64),
});

function selection(phase: DynamoDbRecoveryPhase): DynamoDbRecoverySelection {
  return {
    phase,
    manifest: phase === 'primary_active' ? null : MANIFEST,
  };
}

describe('DynamoDB recovery phase authority', () => {
  it('owns the exact ordered phase set', () => {
    expect(DYNAMODB_RECOVERY_PHASES).toEqual([
      'primary_active',
      'primary_quiesced',
      'replacement_quiesced',
      'replacement_active',
    ]);
    expect(parseDynamoDbRecoveryPhase('replacement_quiesced')).toBe('replacement_quiesced');
    expect(() => parseDynamoDbRecoveryPhase('replacement_ready')).toThrow('DynamoDB recovery phase is invalid.');
  });

  it('admits only primary_active as the initial accepted phase', () => {
    const result = evaluateDynamoDbRecoveryPhaseTransition({
      current: null,
      requested: selection('primary_active'),
    });

    expect(result).toEqual({
      current: null,
      requested: selection('primary_active'),
      disposition: 'initial',
      allowedNextPhases: ['primary_active'],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() =>
      evaluateDynamoDbRecoveryPhaseTransition({
        current: null,
        requested: selection('primary_quiesced'),
      }),
    ).toThrow('Initial DynamoDB recovery authority must use primary_active.');
  });

  it.each(DYNAMODB_RECOVERY_PHASES)('admits an exact same-phase %s retry', (phase) => {
    const current = selection(phase);

    expect(evaluateDynamoDbRecoveryPhaseTransition({ current, requested: selection(phase) })).toMatchObject({
      disposition: 'idempotent',
      current,
      requested: current,
    });
  });

  it.each([
    ['primary_active', 'primary_quiesced'],
    ['primary_quiesced', 'replacement_quiesced'],
    ['replacement_quiesced', 'replacement_active'],
  ] as const)('admits the adjacent forward transition %s -> %s', (currentPhase, requestedPhase) => {
    const result = evaluateDynamoDbRecoveryPhaseTransition({
      current: selection(currentPhase),
      requested: selection(requestedPhase),
    });

    expect(result.disposition).toBe('forward');
    expect(result.allowedNextPhases).toContain(requestedPhase);
  });

  it.each([
    ['replacement_active', 'replacement_quiesced'],
    ['replacement_quiesced', 'primary_quiesced'],
    ['primary_quiesced', 'primary_active'],
  ] as const)('admits the adjacent reverse transition %s -> %s', (currentPhase, requestedPhase) => {
    const result = evaluateDynamoDbRecoveryPhaseTransition({
      current: selection(currentPhase),
      requested: selection(requestedPhase),
    });

    expect(result.disposition).toBe('reverse');
    expect(result.allowedNextPhases).toContain(requestedPhase);
  });

  it.each([
    ['primary_active', 'replacement_quiesced'],
    ['primary_active', 'replacement_active'],
    ['primary_quiesced', 'replacement_active'],
    ['replacement_active', 'primary_quiesced'],
    ['replacement_active', 'primary_active'],
    ['replacement_quiesced', 'primary_active'],
  ] as const)('rejects the skipped transition %s -> %s', (currentPhase, requestedPhase) => {
    expect(() =>
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection(currentPhase),
        requested: selection(requestedPhase),
      }),
    ).toThrow('DynamoDB recovery phases may change by only one adjacent phase.');
  });

  it('introduces the manifest only when leaving primary_active and removes it only when returning', () => {
    expect(
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection('primary_active'),
        requested: selection('primary_quiesced'),
      }).disposition,
    ).toBe('forward');
    expect(
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection('primary_quiesced'),
        requested: selection('primary_active'),
      }).disposition,
    ).toBe('reverse');

    expect(() => validateDynamoDbRecoverySelection({ phase: 'primary_active', manifest: MANIFEST })).toThrow(
      'primary_active must not select a DynamoDB recovery manifest.',
    );
    expect(() => validateDynamoDbRecoverySelection({ phase: 'primary_quiesced', manifest: null })).toThrow(
      'DynamoDB recovery transition phases require an exact recovery manifest.',
    );
  });

  it.each([
    ['primary_quiesced', 'primary_quiesced'],
    ['primary_quiesced', 'replacement_quiesced'],
    ['replacement_quiesced', 'replacement_active'],
  ] as const)('rejects manifest substitution across %s -> %s', (currentPhase, requestedPhase) => {
    expect(() =>
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection(currentPhase),
        requested: {
          phase: requestedPhase,
          manifest: { ...MANIFEST, versionId: 'different-version' },
        },
      }),
    ).toThrow('DynamoDB recovery manifest must remain exact across selected recovery phases.');
  });

  it('rejects unknown semantic fields', () => {
    expect(() =>
      evaluateDynamoDbRecoveryPhaseTransition({
        current: selection('primary_active'),
        requested: selection('primary_quiesced'),
        unexpectedField: true,
      }),
    ).toThrow('DynamoDB recovery phase transition must use the exact current shape.');
    expect(() =>
      validateDynamoDbRecoverySelection({
        ...selection('primary_active'),
        legacyPhase: 'active',
      }),
    ).toThrow('DynamoDB recovery selection must use the exact current shape.');
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseVerificationObservationWrite,
  parseVerificationObservation,
  resolveVerificationObservationRecord,
  type VerificationObservation,
} from './verificationObservation';

const observation: VerificationObservation = {
  finalizationId: 'finalization-observation-1',
  fingerprint: 'a'.repeat(64),
  observedAt: 1_750_000_000_000,
};

describe('verification observation', () => {
  it('admits only a bounded finalization id, lowercase SHA-256 fingerprint, and safe timestamp', () => {
    expect(parseVerificationObservation(observation)).toEqual(observation);
    expect(parseVerificationObservation({ ...observation, finalizationId: '../unsafe' })).toBeUndefined();
    expect(parseVerificationObservation({ ...observation, fingerprint: 'A'.repeat(64) })).toBeUndefined();
    expect(parseVerificationObservation({ ...observation, observedAt: -1 })).toBeUndefined();
    expect(parseVerificationObservation({ ...observation, extra: true })).toBeUndefined();
  });

  it('admits an exact write without duplicating the separately supplied finalization identity', () => {
    expect(
      parseVerificationObservationWrite({
        fingerprint: observation.fingerprint,
        observedAt: observation.observedAt,
      }),
    ).toEqual({
      fingerprint: observation.fingerprint,
      observedAt: observation.observedAt,
    });
    expect(
      parseVerificationObservationWrite({
        fingerprint: observation.fingerprint,
        observedAt: observation.observedAt,
        finalizationId: observation.finalizationId,
      }),
    ).toBeUndefined();
  });

  it('records once and classifies retries without changing the stored observation', () => {
    expect(resolveVerificationObservationRecord(observation.finalizationId, undefined, observation)).toEqual({
      status: 'recorded',
    });
    expect(resolveVerificationObservationRecord(observation.finalizationId, observation, observation)).toEqual({
      status: 'idempotent',
    });
    expect(
      resolveVerificationObservationRecord(observation.finalizationId, observation, {
        ...observation,
        fingerprint: 'b'.repeat(64),
      }),
    ).toEqual({ status: 'conflict', reason: 'fingerprint_mismatch' });
    expect(resolveVerificationObservationRecord('finalization-other', undefined, observation)).toEqual({
      status: 'conflict',
      reason: 'finalization_mismatch',
    });
  });

  it('allows a later finalization to replace an earlier finalization observation', () => {
    const nextObservation = {
      finalizationId: 'finalization-observation-2',
      fingerprint: 'b'.repeat(64),
      observedAt: observation.observedAt + 1,
    };

    expect(resolveVerificationObservationRecord(nextObservation.finalizationId, observation, nextObservation)).toEqual({
      status: 'recorded',
    });
  });
});

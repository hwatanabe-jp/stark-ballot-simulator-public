import { describe, expect, it } from 'vitest';
import {
  parseVerificationObservation,
  resolveVerificationObservationRecord,
  type VerificationObservation,
} from './verificationObservation';

const observation: VerificationObservation = {
  executionId: 'exec-observation-1',
  fingerprint: 'a'.repeat(64),
  observedAt: 1_750_000_000_000,
};

describe('verification observation', () => {
  it('admits only a bounded execution id, lowercase SHA-256 fingerprint, and safe timestamp', () => {
    expect(parseVerificationObservation(observation)).toEqual(observation);
    expect(parseVerificationObservation({ ...observation, executionId: '../unsafe' })).toBeUndefined();
    expect(parseVerificationObservation({ ...observation, fingerprint: 'A'.repeat(64) })).toBeUndefined();
    expect(parseVerificationObservation({ ...observation, observedAt: -1 })).toBeUndefined();
    expect(parseVerificationObservation({ ...observation, extra: true })).toBeUndefined();
  });

  it('records once and classifies retries without changing the stored observation', () => {
    expect(resolveVerificationObservationRecord(observation.executionId, undefined, observation)).toEqual({
      status: 'recorded',
    });
    expect(resolveVerificationObservationRecord(observation.executionId, observation, observation)).toEqual({
      status: 'idempotent',
    });
    expect(
      resolveVerificationObservationRecord(observation.executionId, observation, {
        ...observation,
        fingerprint: 'b'.repeat(64),
      }),
    ).toEqual({ status: 'conflict', reason: 'fingerprint_mismatch' });
    expect(resolveVerificationObservationRecord('exec-other', undefined, observation)).toEqual({
      status: 'conflict',
      reason: 'execution_mismatch',
    });
  });

  it('allows a later verification execution to replace an earlier execution observation', () => {
    const nextObservation = {
      executionId: 'exec-observation-2',
      fingerprint: 'b'.repeat(64),
      observedAt: observation.observedAt + 1,
    };

    expect(resolveVerificationObservationRecord(nextObservation.executionId, observation, nextObservation)).toEqual({
      status: 'recorded',
    });
  });
});

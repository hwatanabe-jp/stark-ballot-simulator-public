import { describe, expect, it } from 'vitest';
import {
  parseVerificationResultRecord,
  type VerificationResultRecord,
} from '@stark-ballot/application/finalize/finalization-result-store';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const record: VerificationResultRecord = {
  sessionId: asSessionId('session-verification-result'),
  finalizationId: asFinalizationId('finalization-verification-result'),
  verificationResult: {
    status: 'not_run',
  },
};

describe('verification result record admission', () => {
  it('round-trips the exact record separately from finalization authority', () => {
    expect(parseVerificationResultRecord(record)).toEqual(record);
  });

  it('rejects unknown keys and unsafe lifecycle identities', () => {
    expect(parseVerificationResultRecord({ ...record, s3BundleKey: 'adapter-owned' })).toBeUndefined();
    expect(parseVerificationResultRecord({ ...record, finalizationId: '../unsafe' })).toBeUndefined();
    expect(parseVerificationResultRecord({ ...record, sessionId: '' })).toBeUndefined();
  });
});

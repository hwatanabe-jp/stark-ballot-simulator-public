import { describe, expect, it } from 'vitest';
import { VerificationResourceResponseSchema } from '@stark-ballot/api-contract/schemas/verification';
import type { VerificationReadFailure } from '@stark-ballot/application/verification/prepare-verification-read';
import { buildVerificationReadFailureResponse } from './verificationReadFailureResponse';

const finalizationId = 'finalization-verification-read';

describe('buildVerificationReadFailureResponse', () => {
  it.each([
    [
      { availability: 'unavailable', reason: 'finalization_not_current' },
      'Requested finalization is not the current finalized authority',
    ],
    [{ availability: 'corrupt', reason: 'invalid_artifact' }, 'Finalized verification authority is invalid'],
    [
      { availability: 'corrupt', reason: 'incomplete_session_authority' },
      'Session verification authority is incomplete',
    ],
    [
      { availability: 'corrupt', reason: 'voter_evidence_mismatch' },
      'Recorded voter evidence does not match the current session authority',
    ],
  ] satisfies readonly (readonly [VerificationReadFailure, string])[])(
    'returns an exact fail-closed resource for $0.reason',
    async (failure, message) => {
      const response = buildVerificationReadFailureResponse(finalizationId, failure);
      const parsed = VerificationResourceResponseSchema.safeParse(await response.json());

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw parsed.error;
      }
      expect(parsed.data.data).toEqual({
        ...failure,
        finalizationId,
        message,
      });
      expect(parsed.data.data).not.toHaveProperty('artifactState');
      expect(parsed.data.data).not.toHaveProperty('contractGeneration');
    },
  );
});

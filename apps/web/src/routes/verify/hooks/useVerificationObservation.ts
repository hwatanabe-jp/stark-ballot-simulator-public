'use client';

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { apiFetch } from '@stark-ballot/web/api/apiFetch';
import { resolveApiUrl } from '@stark-ballot/web/api/apiBaseUrl';
import { getSessionAuthHeaders, getSessionDataForIdentity, type SessionIdentity } from '@stark-ballot/web/session';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import { buildVerificationObservationPayload, type VerificationPayload } from '../lib/verification-data';

interface UseVerificationObservationOptions {
  data: VerificationPayload | null;
  sequenceComplete: boolean;
  hasCheckPending: boolean;
  serverValidated: boolean;
  verificationStatus: VerificationStatus;
  sessionIdentityRef: MutableRefObject<SessionIdentity | null>;
}

function isTerminalVerificationStatus(status: VerificationStatus): boolean {
  return status === 'success' || status === 'failed' || status === 'dev_mode';
}

function observationFingerprint(
  sessionId: string,
  payload: NonNullable<ReturnType<typeof buildVerificationObservationPayload>>,
): string {
  const statuses = payload.castChecks;
  return [
    sessionId,
    payload.verificationExecutionId,
    statuses.cast_receipt_present,
    statuses.cast_choice_range,
    statuses.cast_random_format,
    statuses.cast_commitment_match,
  ].join(':');
}

export function useVerificationObservation({
  data,
  sequenceComplete,
  hasCheckPending,
  serverValidated,
  verificationStatus,
  sessionIdentityRef,
}: UseVerificationObservationOptions): void {
  const submittedFingerprintsRef = useRef(new Set<string>());
  const inFlightFingerprintsRef = useRef(new Set<string>());

  useEffect(() => {
    if (
      !data ||
      !sequenceComplete ||
      hasCheckPending ||
      !serverValidated ||
      !isTerminalVerificationStatus(verificationStatus)
    ) {
      return;
    }

    const session = getSessionDataForIdentity(sessionIdentityRef.current);
    const payload = buildVerificationObservationPayload(data);
    if (!session || !payload) {
      return;
    }

    const fingerprint = observationFingerprint(session.sessionId, payload);
    if (submittedFingerprintsRef.current.has(fingerprint) || inFlightFingerprintsRef.current.has(fingerprint)) {
      return;
    }
    inFlightFingerprintsRef.current.add(fingerprint);

    void (async () => {
      try {
        const response = await apiFetch(resolveApiUrl('/api/verification/observation'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getSessionAuthHeaders(session),
          },
          body: JSON.stringify(payload),
        });
        const isNonRetryableClientError =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 425 &&
          response.status !== 429;
        if (response.ok || isNonRetryableClientError) {
          submittedFingerprintsRef.current.add(fingerprint);
        }
      } catch {
        // Final verification observation is best-effort and must not alter the verdict shown to the user.
      } finally {
        inFlightFingerprintsRef.current.delete(fingerprint);
      }
    })();
  }, [data, hasCheckPending, sequenceComplete, serverValidated, sessionIdentityRef, verificationStatus]);
}

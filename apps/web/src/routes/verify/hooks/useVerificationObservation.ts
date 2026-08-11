'use client';

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { ApiClientError } from '@stark-ballot/web/api/client';
import { recordVerificationObservation } from '@stark-ballot/web/api/verification';
import { getSessionDataForIdentity, type SessionIdentity } from '@stark-ballot/web/session';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import type { VerificationPayload } from '../lib/verification-data';
import {
  buildVerificationObservationSubmission,
  type VerificationObservationSubmission,
} from '../lib/verification-observation';

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

function observationFingerprint(sessionId: string, submission: VerificationObservationSubmission): string {
  const statuses = submission.request.castChecks;
  return [
    sessionId,
    submission.finalizationId,
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
    const submission = buildVerificationObservationSubmission(data);
    if (!session || !submission) {
      return;
    }

    const fingerprint = observationFingerprint(session.sessionId, submission);
    if (submittedFingerprintsRef.current.has(fingerprint) || inFlightFingerprintsRef.current.has(fingerprint)) {
      return;
    }
    inFlightFingerprintsRef.current.add(fingerprint);

    void (async () => {
      try {
        await recordVerificationObservation(session, submission.finalizationId, submission.request);
        submittedFingerprintsRef.current.add(fingerprint);
      } catch (error) {
        const status = error instanceof ApiClientError ? error.status : 0;
        const isNonRetryableClientError =
          status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
        if (isNonRetryableClientError) {
          submittedFingerprintsRef.current.add(fingerprint);
        }
        // Final verification observation is best-effort and must not alter the verdict shown to the user.
      } finally {
        inFlightFingerprintsRef.current.delete(fingerprint);
      }
    })();
  }, [data, hasCheckPending, sequenceComplete, serverValidated, sessionIdentityRef, verificationStatus]);
}

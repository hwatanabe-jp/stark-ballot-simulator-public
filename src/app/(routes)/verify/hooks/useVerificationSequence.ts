'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import {
  getSessionDataForIdentity,
  isSessionReplaced,
  isSessionReplacedForIdentity,
  type SessionIdentity,
} from '@/lib/session';
import type { VerificationStatus } from '@/types/server';
import { saveKnowledgeData } from '@/lib/knowledge';
import { toCanonicalRfc6962Proof } from '@/lib/merkle/rfc6962-proof';
import type { KnowledgeData, VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';
import { STARK_POLL_INTERVAL_MS, STARK_POLL_TIMEOUT_MS } from '@/lib/verification/stark-verification-polling';
import { isVerificationClientInvalidationError } from '@/lib/verification/client-api-errors';
import { resolveStarkStatus } from '../lib/verification-data';
import { STARK_TIMEOUT_ERROR } from '../lib/stark-timeout';
import type { VerificationPayload } from '../lib/verification-data';

const SESSION_ERROR_KEY = 'pages.verify.sessionError';
const SESSION_REPLACED_ERROR_KEY = 'pages.verify.sessionReplaced';

interface UseVerificationSequenceOptions {
  data: VerificationPayload | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  fetchVerificationRef: MutableRefObject<() => Promise<VerificationPayload>>;
  triggerStarkVerificationRun?: () => Promise<void>;
  onError: (message: string) => void;
  verificationStartedRef: MutableRefObject<boolean>;
  sessionIdentityRef: MutableRefObject<SessionIdentity | null>;
}

interface UseVerificationSequenceResult {
  verificationStarted: boolean;
  visibleStepCount: number;
  sequenceComplete: boolean;
  stepStatusMap: Record<VerificationStepId, { status: VerificationStepStatus; error?: string }>;
  startVerification: () => Promise<void>;
}

const buildVerificationKnowledge = (data: VerificationPayload): Partial<KnowledgeData> => {
  const updates: Partial<KnowledgeData> = {};

  if (data.voteReceipt) {
    const receipt = data.voteReceipt;
    const inputCommitment = data.inputCommitment ?? receipt.inputCommitment;
    updates['user.voteReceipt'] = {
      voteId: receipt.voteId,
      commitment: receipt.commitment,
      bulletinIndex: receipt.bulletinIndex,
      bulletinRootAtCast: receipt.bulletinRootAtCast,
      timestamp: receipt.timestamp,
      ...(inputCommitment ? { inputCommitment } : {}),
    };
  }

  const proof = toCanonicalRfc6962Proof(data.userVote?.proof);
  if (proof) {
    updates['user.merklePath'] = proof;
  }

  return updates;
};

export function useVerificationSequence({
  data,
  t,
  fetchVerificationRef,
  triggerStarkVerificationRun,
  onError,
  verificationStartedRef,
  sessionIdentityRef,
}: UseVerificationSequenceOptions): UseVerificationSequenceResult {
  const resolveSessionErrorMessage = useCallback(
    (): string =>
      t(
        isSessionReplacedForIdentity(sessionIdentityRef.current) || isSessionReplaced()
          ? SESSION_REPLACED_ERROR_KEY
          : SESSION_ERROR_KEY,
      ),
    [sessionIdentityRef, t],
  );
  const [verificationStarted, setVerificationStarted] = useState(false);
  const [visibleStepCount, setVisibleStepCount] = useState(0);
  const [sequenceComplete, setSequenceComplete] = useState(false);
  const [stepStatusMap, setStepStatusMap] = useState<
    Record<VerificationStepId, { status: VerificationStepStatus; error?: string }>
  >(() => ({
    cast_as_intended: { status: 'pending' },
    recorded_as_cast: { status: 'pending' },
    counted_as_recorded: { status: 'pending' },
    stark_verification: { status: 'pending' },
  }));
  const verificationFlowRef = useRef(false);
  const sequenceAbortRef = useRef(false);
  const actualStarkStatus = resolveStarkStatus(data?.verificationStatus, data?.verificationReport);
  const actualStarkStatusRef = useRef(actualStarkStatus);

  useEffect(() => {
    verificationStartedRef.current = verificationStarted;
  }, [verificationStarted, verificationStartedRef]);

  useEffect(() => {
    actualStarkStatusRef.current = actualStarkStatus;
  }, [actualStarkStatus]);

  useEffect(() => {
    return () => {
      sequenceAbortRef.current = true;
    };
  }, []);

  const updateStepStatus = useCallback((id: VerificationStepId, status: VerificationStepStatus, error?: string) => {
    setStepStatusMap((prev) => ({
      ...prev,
      [id]: { status, ...(error ? { error } : {}) },
    }));
  }, []);

  const resetStepStatuses = useCallback(() => {
    setStepStatusMap({
      cast_as_intended: { status: 'pending' },
      recorded_as_cast: { status: 'pending' },
      counted_as_recorded: { status: 'pending' },
      stark_verification: { status: 'pending' },
    });
    setVisibleStepCount(0);
    setSequenceComplete(false);
  }, []);

  const pollStarkVerificationStatus = useCallback(async (): Promise<{
    status: VerificationStatus;
    error?: string;
    payload?: VerificationPayload;
  }> => {
    const session = getSessionDataForIdentity(sessionIdentityRef.current);
    if (!session) {
      return { status: 'failed', error: resolveSessionErrorMessage() };
    }

    const startedAt = Date.now();
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const shouldPoll = (status: VerificationStatus) => status === 'not_run' || status === 'running';
    const hasTimedOut = () => Date.now() - startedAt >= STARK_POLL_TIMEOUT_MS;
    let lastPayload: VerificationPayload | undefined;
    let startRequested = false;

    try {
      let currentStatus = actualStarkStatusRef.current;
      if (!shouldPoll(currentStatus)) {
        return { status: currentStatus, payload: lastPayload };
      }

      while (shouldPoll(currentStatus)) {
        if (sequenceAbortRef.current) {
          return { status: currentStatus, payload: lastPayload };
        }
        if (hasTimedOut()) {
          return { status: 'failed', error: STARK_TIMEOUT_ERROR, payload: lastPayload };
        }
        if (currentStatus === 'not_run' && !startRequested) {
          startRequested = true;
          try {
            await triggerStarkVerificationRun?.();
          } catch (error) {
            if (isVerificationClientInvalidationError(error)) {
              onError(error.message);
              return { status: 'failed', error: error.message, payload: lastPayload };
            }
            console.warn('[Verify] Failed to trigger STARK verification run', error);
          }
        }

        const refreshed = await fetchVerificationRef.current();
        lastPayload = refreshed;
        currentStatus = resolveStarkStatus(refreshed.verificationStatus, refreshed.verificationReport);
        actualStarkStatusRef.current = currentStatus;

        if (shouldPoll(currentStatus)) {
          await delay(STARK_POLL_INTERVAL_MS);
        }
      }

      return { status: currentStatus, payload: lastPayload };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isVerificationClientInvalidationError(error)) {
        onError(message);
      }
      return { status: 'failed', error: message, payload: lastPayload };
    }
  }, [fetchVerificationRef, onError, resolveSessionErrorMessage, sessionIdentityRef, triggerStarkVerificationRun]);

  const runVerificationSequence = useCallback(async () => {
    if (verificationFlowRef.current) {
      return;
    }

    try {
      const session = getSessionDataForIdentity(sessionIdentityRef.current);
      if (!session) {
        onError(resolveSessionErrorMessage());
        return;
      }

      if (!data) {
        onError(t('errors.generic'));
        return;
      }

      verificationFlowRef.current = true;
      sequenceAbortRef.current = false;
      setVerificationStarted(true);
      resetStepStatuses();

      const baseDelay = process.env.NODE_ENV === 'test' ? 0 : 600;
      const preparationDelay = process.env.NODE_ENV === 'test' ? 0 : 2000;
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const isAborted = () => sequenceAbortRef.current;

      // Wait for STARK to resolve before showing any steps (per TEMP-verify-ux-policy.md)
      let resolvedStarkStatus = actualStarkStatusRef.current;
      let resolvedStarkError: string | undefined;
      let resolvedPayload: VerificationPayload = data;
      if (resolvedStarkStatus === 'not_run' || resolvedStarkStatus === 'running') {
        const pollResult = await pollStarkVerificationStatus();
        resolvedStarkStatus = pollResult.status;
        resolvedStarkError = pollResult.error;
        if (pollResult.payload) {
          resolvedPayload = pollResult.payload;
        }
      }
      if (isAborted()) return;

      const knowledgeUpdates = buildVerificationKnowledge(resolvedPayload);
      if (Object.keys(knowledgeUpdates).length > 0) {
        saveKnowledgeData(knowledgeUpdates, {
          expectedSessionId: sessionIdentityRef.current?.sessionId,
        });
      }

      const finalizeStep = async (
        id: VerificationStepId,
        status: VerificationStepStatus,
        error?: string,
        delayMs: number = baseDelay,
      ) => {
        if (isAborted()) return;
        await delay(delayMs);
        if (isAborted()) return;
        updateStepStatus(id, status, error);
      };

      const resolveStepStatus = (stage: unknown): VerificationStepStatus => {
        if (!stage || typeof stage !== 'object') {
          return 'not_run';
        }
        if ('status' in stage && typeof stage.status === 'string') {
          return stage.status as VerificationStepStatus;
        }
        if ('passed' in stage && typeof stage.passed === 'boolean') {
          return stage.passed ? 'success' : 'failed';
        }
        return 'not_run';
      };

      const resolveStepError = (stage: unknown): string | undefined => {
        if (!stage || typeof stage !== 'object') {
          return undefined;
        }
        if ('error' in stage && typeof stage.error === 'string') {
          return stage.error;
        }
        return undefined;
      };

      if (isAborted()) return;
      await delay(preparationDelay);
      if (isAborted()) return;
      setVisibleStepCount(1);
      updateStepStatus('cast_as_intended', 'running');

      const apiSteps = resolvedPayload.verificationSteps;
      const apiStepResult = (id: VerificationStepId) => apiSteps?.find((step) => step.id === id);

      const castStage = apiSteps ? apiStepResult('cast_as_intended') : undefined;
      const recordedStage = apiSteps ? apiStepResult('recorded_as_cast') : undefined;
      const countedStage = apiSteps ? apiStepResult('counted_as_recorded') : undefined;
      const starkStage = apiSteps ? apiStepResult('stark_verification') : undefined;

      await finalizeStep('cast_as_intended', resolveStepStatus(castStage), resolveStepError(castStage));

      if (isAborted()) return;
      setVisibleStepCount(2);
      updateStepStatus('recorded_as_cast', 'running');
      await finalizeStep('recorded_as_cast', resolveStepStatus(recordedStage), resolveStepError(recordedStage));

      if (isAborted()) return;
      setVisibleStepCount(3);
      updateStepStatus('counted_as_recorded', 'running');
      await finalizeStep('counted_as_recorded', resolveStepStatus(countedStage), resolveStepError(countedStage));

      if (isAborted()) return;
      setVisibleStepCount(4);
      updateStepStatus('stark_verification', 'running');

      const starkImageIdStatus = resolvedPayload.verificationChecks?.find(
        (check) => check.id === 'stark_image_id_match',
      )?.status;
      const starkReceiptStatus = resolvedPayload.verificationChecks?.find(
        (check) => check.id === 'stark_receipt_verify',
      )?.status;
      const reportStatus = resolvedPayload.verificationReport?.status;
      const explicitProofSuccess =
        reportStatus === 'success' ||
        reportStatus === 'dev_mode' ||
        (starkReceiptStatus === 'success' && (starkImageIdStatus === undefined || starkImageIdStatus === 'success'));
      const explicitProofFailure =
        reportStatus === 'failed' ||
        starkImageIdStatus === 'failed' ||
        starkReceiptStatus === 'failed' ||
        (resolvedStarkStatus === 'failed' && !explicitProofSuccess);
      const starkStageStatus = starkStage ? resolveStepStatus(starkStage) : undefined;
      const starkStageError = starkStage ? resolveStepError(starkStage) : undefined;

      let mappedStarkStatus: VerificationStepStatus = 'not_run';
      let mappedStarkError: string | undefined;
      if (resolvedStarkError === STARK_TIMEOUT_ERROR) {
        mappedStarkStatus = 'failed';
        mappedStarkError = resolvedStarkError;
      } else if (starkStageStatus === 'success' || starkStageStatus === 'failed') {
        mappedStarkStatus = starkStageStatus;
        mappedStarkError = starkStageError;
      } else if (explicitProofFailure) {
        mappedStarkStatus = 'failed';
        mappedStarkError = resolvedStarkError;
      } else if (starkStageStatus) {
        mappedStarkStatus = starkStageStatus;
        mappedStarkError = starkStageError;
      } else if (explicitProofSuccess || resolvedStarkStatus === 'success' || resolvedStarkStatus === 'dev_mode') {
        mappedStarkStatus = 'success';
      }

      if (!isAborted()) {
        await finalizeStep('stark_verification', mappedStarkStatus, mappedStarkError);
        setSequenceComplete(true);
      }
    } catch (err) {
      console.error('[Verify] Verification sequence failed', err);
      sequenceAbortRef.current = true;
      onError(t('errors.generic'));
    } finally {
      verificationFlowRef.current = false;
    }
  }, [
    data,
    onError,
    pollStarkVerificationStatus,
    resetStepStatuses,
    resolveSessionErrorMessage,
    sessionIdentityRef,
    t,
    updateStepStatus,
  ]);

  return {
    verificationStarted,
    visibleStepCount,
    sequenceComplete,
    stepStatusMap,
    startVerification: runVerificationSequence,
  };
}

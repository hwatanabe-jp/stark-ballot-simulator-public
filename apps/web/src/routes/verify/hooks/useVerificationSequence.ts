'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import {
  getSessionDataForIdentity,
  isSessionReplaced,
  isSessionReplacedForIdentity,
  type SessionIdentity,
} from '@stark-ballot/web/session';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import { saveKnowledgeData } from '@stark-ballot/web/knowledge';
import { toCanonicalRfc6962Proof } from '@stark-ballot/merkle/rfc6962-proof';
import type { KnowledgeData, VerificationStepId, VerificationStepStatus } from '@stark-ballot/web/knowledge';
import {
  STARK_POLL_INTERVAL_MS,
  STARK_POLL_TIMEOUT_MS,
} from '@stark-ballot/web/verification/stark-verification-polling';
import { isVerificationClientInvalidationError } from '@stark-ballot/web/verification/client-api-errors';
import { resolveStarkStatus } from '../lib/verification-data';
import { STARK_TIMEOUT_ERROR } from '../lib/stark-timeout';
import type { VerificationPayload } from '../lib/verification-data';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const SESSION_ERROR_KEY = 'pages.verify.sessionError';
const SESSION_REPLACED_ERROR_KEY = 'pages.verify.sessionReplaced';

interface UseVerificationSequenceOptions {
  data: VerificationPayload | null;
  t: UseTranslationResult['t'];
  fetchVerificationRef: RefObject<() => Promise<VerificationPayload>>;
  triggerStarkVerificationRun?: () => Promise<void>;
  onError: (message: string) => void;
  verificationStartedRef: RefObject<boolean>;
  sessionIdentityRef: RefObject<SessionIdentity | null>;
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

type VerificationStepResult = { status: VerificationStepStatus; error?: string };
type VerificationStepMap = Record<VerificationStepId, VerificationStepResult>;

function pendingVerificationSteps(): VerificationStepMap {
  return {
    cast_as_intended: { status: 'pending' },
    recorded_as_cast: { status: 'pending' },
    counted_as_recorded: { status: 'pending' },
    stark_verification: { status: 'pending' },
  };
}

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

const resolvedStep = (stage: unknown) => {
  const error = resolveStepError(stage);
  return { status: resolveStepStatus(stage), ...(error ? { error } : {}) };
};

function isPendingStarkStatus(status: VerificationStatus): boolean {
  return status === 'not_run' || status === 'running';
}

function isSuccessfulStarkStatus(status: string | undefined): boolean {
  return status === 'success' || status === 'dev_mode';
}

function stepWithError(status: VerificationStepStatus, error: string | undefined): VerificationStepResult {
  return { status, ...(error ? { error } : {}) };
}

function publishVerificationKnowledge(payload: VerificationPayload, sessionId: string): void {
  const updates = buildVerificationKnowledge(payload);
  if (Object.keys(updates).length > 0) saveKnowledgeData(updates, { expectedSessionId: sessionId });
}

function verificationCheckStatus(payload: VerificationPayload, id: string) {
  return payload.verificationChecks?.find((check) => check.id === id)?.status;
}

function resolveProofEvidence(payload: VerificationPayload, resolvedStarkStatus: VerificationStatus) {
  const starkImageIdStatus = verificationCheckStatus(payload, 'stark_image_id_match');
  const starkReceiptStatus = verificationCheckStatus(payload, 'stark_receipt_verify');
  const reportStatus = payload.verificationReport?.status;
  const succeeded =
    isSuccessfulStarkStatus(reportStatus) ||
    (starkReceiptStatus === 'success' && (starkImageIdStatus === undefined || starkImageIdStatus === 'success'));
  const failed =
    reportStatus === 'failed' ||
    starkImageIdStatus === 'failed' ||
    starkReceiptStatus === 'failed' ||
    (resolvedStarkStatus === 'failed' && !succeeded);
  return { succeeded, failed };
}

function resolveStarkStep(
  starkStage: unknown,
  evidence: ReturnType<typeof resolveProofEvidence>,
  resolvedStarkStatus: VerificationStatus,
  resolvedStarkError: string | undefined,
): VerificationStepResult {
  const starkStageStatus = starkStage ? resolveStepStatus(starkStage) : undefined;
  const starkStageError = resolveStepError(starkStage);
  let mappedStarkStatus: VerificationStepStatus = 'not_run';
  let mappedStarkError: string | undefined;
  if (resolvedStarkError === STARK_TIMEOUT_ERROR) {
    mappedStarkStatus = 'failed';
    mappedStarkError = resolvedStarkError;
  } else if (starkStageStatus === 'success' || starkStageStatus === 'failed') {
    mappedStarkStatus = starkStageStatus;
    mappedStarkError = starkStageError;
  } else if (evidence.failed) {
    mappedStarkStatus = 'failed';
    mappedStarkError = resolvedStarkError;
  } else if (starkStageStatus) {
    mappedStarkStatus = starkStageStatus;
    mappedStarkError = starkStageError;
  } else if (evidence.succeeded || isSuccessfulStarkStatus(resolvedStarkStatus)) {
    mappedStarkStatus = 'success';
  }
  return stepWithError(mappedStarkStatus, mappedStarkError);
}

function resolveVerificationStepStatuses(
  resolvedPayload: VerificationPayload,
  resolvedStarkStatus: VerificationStatus,
  resolvedStarkError: string | undefined,
): VerificationStepMap {
  const apiSteps = resolvedPayload.verificationSteps;
  const apiStepResult = (id: VerificationStepId) => (apiSteps ? apiSteps.find((step) => step.id === id) : undefined);

  const castStage = apiStepResult('cast_as_intended');
  const recordedStage = apiStepResult('recorded_as_cast');
  const countedStage = apiStepResult('counted_as_recorded');
  const starkStage = apiStepResult('stark_verification');

  const evidence = resolveProofEvidence(resolvedPayload, resolvedStarkStatus);
  return {
    cast_as_intended: resolvedStep(castStage),
    recorded_as_cast: resolvedStep(recordedStage),
    counted_as_recorded: resolvedStep(countedStage),
    stark_verification: resolveStarkStep(starkStage, evidence, resolvedStarkStatus, resolvedStarkError),
  };
}

interface StarkSequencePollResult {
  status: VerificationStatus;
  error?: string;
  payload?: VerificationPayload;
}

type StarkSequencePollingContext = Pick<
  UseVerificationSequenceOptions,
  'fetchVerificationRef' | 'onError' | 'sessionIdentityRef'
> & {
  actualStarkStatusRef: RefObject<VerificationStatus>;
  sequenceAbortRef: RefObject<boolean>;
  resolveSessionErrorMessage: () => string;
  triggerStarkVerificationRun: UseVerificationSequenceOptions['triggerStarkVerificationRun'];
};

function recordSequencePollingFailure(
  error: unknown,
  abortRef: RefObject<boolean>,
  onError: (message: string) => void,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isVerificationClientInvalidationError(error)) {
    abortRef.current = true;
    onError(message);
  }
  return message;
}

async function requestStarkVerificationRun(
  triggerStarkVerificationRun: UseVerificationSequenceOptions['triggerStarkVerificationRun'],
  sequenceAbortRef: RefObject<boolean>,
  onError: UseVerificationSequenceOptions['onError'],
): Promise<string | undefined> {
  try {
    await triggerStarkVerificationRun?.();
  } catch (error) {
    if (isVerificationClientInvalidationError(error)) {
      sequenceAbortRef.current = true;
      onError(error.message);
      return error.message;
    }
    console.warn('[Verify] Failed to trigger STARK verification run', error);
  }
  return undefined;
}

async function pollSequenceStarkStatus({
  fetchVerificationRef,
  onError,
  sessionIdentityRef,
  actualStarkStatusRef,
  sequenceAbortRef,
  resolveSessionErrorMessage,
  triggerStarkVerificationRun,
}: StarkSequencePollingContext): Promise<StarkSequencePollResult> {
  const session = getSessionDataForIdentity(sessionIdentityRef.current);
  if (!session) {
    return { status: 'failed', error: resolveSessionErrorMessage() };
  }

  const startedAt = Date.now();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const hasTimedOut = () => Date.now() - startedAt >= STARK_POLL_TIMEOUT_MS;
  let lastPayload: VerificationPayload | undefined;
  let startRequested = false;

  const stoppedResult = (status: VerificationStatus) => {
    if (sequenceAbortRef.current) return { status, ...omitUndefinedProperties({ payload: lastPayload }) };
    if (hasTimedOut())
      return {
        status: 'failed' as const,
        error: STARK_TIMEOUT_ERROR,
        ...omitUndefinedProperties({ payload: lastPayload }),
      };
    return undefined;
  };

  try {
    let currentStatus = actualStarkStatusRef.current;
    while (isPendingStarkStatus(currentStatus)) {
      const stopped = stoppedResult(currentStatus);
      if (stopped) return stopped;
      if (currentStatus === 'not_run' && !startRequested) {
        startRequested = true;
        const invalidationMessage = await requestStarkVerificationRun(
          triggerStarkVerificationRun,
          sequenceAbortRef,
          onError,
        );
        if (invalidationMessage !== undefined) {
          return {
            status: 'failed',
            error: invalidationMessage,
            ...omitUndefinedProperties({ payload: lastPayload }),
          };
        }
      }

      const refreshed = await fetchVerificationRef.current();
      lastPayload = refreshed;
      currentStatus = resolveStarkStatus(refreshed.verificationStatus, refreshed.verificationReport);
      actualStarkStatusRef.current = currentStatus;

      if (isPendingStarkStatus(currentStatus)) {
        await delay(STARK_POLL_INTERVAL_MS);
      }
    }

    return { status: currentStatus, ...omitUndefinedProperties({ payload: lastPayload }) };
  } catch (error) {
    const message = recordSequencePollingFailure(error, sequenceAbortRef, onError);
    return { status: 'failed', error: message, ...omitUndefinedProperties({ payload: lastPayload }) };
  }
}

async function resolveSequenceStarkResult(payload: VerificationPayload, poll: () => Promise<StarkSequencePollResult>) {
  const result = await poll();
  return { status: result.status, error: result.error, payload: result.payload || payload };
}

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
  const [stepStatusMap, setStepStatusMap] = useState<VerificationStepMap>(pendingVerificationSteps);
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

  const resetStepStatuses = useCallback(() => {
    setStepStatusMap(pendingVerificationSteps());
    setVisibleStepCount(0);
    setSequenceComplete(false);
  }, []);

  const pollStarkVerificationStatus = useCallback(
    () =>
      pollSequenceStarkStatus({
        fetchVerificationRef,
        onError,
        sessionIdentityRef,
        actualStarkStatusRef,
        sequenceAbortRef,
        resolveSessionErrorMessage,
        triggerStarkVerificationRun,
      }),
    [fetchVerificationRef, onError, resolveSessionErrorMessage, sessionIdentityRef, triggerStarkVerificationRun],
  );

  const runVerificationSequence = useCallback(async () => {
    if (verificationFlowRef.current) {
      return;
    }

    try {
      const sessionIdentity = sessionIdentityRef.current;
      const session = getSessionDataForIdentity(sessionIdentity);
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

      const isAborted = () => sequenceAbortRef.current;

      // Publish the resolved stages together after the actual verifier wait.
      let resolved: { status: VerificationStatus; error: string | undefined; payload: VerificationPayload } = {
        status: actualStarkStatusRef.current,
        error: undefined,
        payload: data,
      };
      if (isPendingStarkStatus(resolved.status))
        resolved = await resolveSequenceStarkResult(data, pollStarkVerificationStatus);
      const { status: resolvedStarkStatus, error: resolvedStarkError, payload: resolvedPayload } = resolved;
      if (isAborted()) return;
      if (!getSessionDataForIdentity(sessionIdentity)) {
        onError(resolveSessionErrorMessage());
        return;
      }

      publishVerificationKnowledge(resolvedPayload, session.sessionId);

      if (!isAborted()) {
        setStepStatusMap(resolveVerificationStepStatuses(resolvedPayload, resolvedStarkStatus, resolvedStarkError));
        setVisibleStepCount(4);
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
  ]);

  return {
    verificationStarted,
    visibleStepCount,
    sequenceComplete,
    stepStatusMap,
    startVerification: runVerificationSequence,
  };
}

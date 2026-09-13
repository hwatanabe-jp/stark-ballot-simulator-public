import { ApiClientError } from '@stark-ballot/web/api/client';
import { getVerification } from '@stark-ballot/web/api/verification';
import { captureSessionIdentity, clearSession, getSessionData } from '@stark-ballot/web/session';
import {
  clearClientFinalizedProjection,
  clearClientSessionAuthority,
} from '@stark-ballot/web/finalize/client-finalization-boundary';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import {
  isCapabilityLossErrorCode,
  isFailClosedFinalizationErrorCode,
} from '@stark-ballot/api-contract/errors/apiErrorGuards';
import { VERIFICATION_STATUS_VALUES, type VerificationStatus } from '@stark-ballot/verification/shared/types';

import { isBrowserTestMode } from '@stark-ballot/runtime-config/env/browserRuntime';
import type { VerificationResource } from '@stark-ballot/api-contract/schemas/verification';
import { readStandardApiErrorCode, readStandardApiErrorMessage } from '@stark-ballot/web/api/responseAdmission';

export const STARK_POLL_INTERVAL_MS = isBrowserTestMode() ? 50 : 500;
export const STARK_POLL_TIMEOUT_MS = isBrowserTestMode() ? 500 : 30_000;

const ALLOWED_STATUS_SET = new Set<VerificationStatus>(VERIFICATION_STATUS_VALUES);

export type StarkVerificationSnapshot = {
  sessionId: string;
  finalizationId: string;
  status: VerificationStatus;
  payload: VerificationResource;
  receivedAt: number;
};

type StarkVerificationListener = (snapshot: StarkVerificationSnapshot) => void;

type PollingState = {
  sessionId: string;
  finalizationId: string;
  intervalMs: number;
  timeoutMs: number;
  startedAt: number;
  cancelled: boolean;
  timeoutId?: number;
};

type PollingOptions = {
  sessionId: string;
  finalizationId: string;
  intervalMs?: number;
  timeoutMs?: number;
};

class StarkPollingError extends Error {
  readonly fatal: boolean;
  readonly code?: string;

  constructor(message: string, fatal: boolean, code?: string) {
    super(message);
    this.name = 'StarkPollingError';
    this.fatal = fatal;
    if (code !== undefined) {
      this.code = code;
    }
  }
}

let pollingState: PollingState | null = null;
let latestSnapshot: StarkVerificationSnapshot | null = null;
const listeners = new Set<StarkVerificationListener>();

function notifySnapshot(snapshot: StarkVerificationSnapshot): void {
  latestSnapshot = snapshot;
  for (const listener of listeners) {
    listener(snapshot);
  }
}

function normalizeStatus(value: unknown): VerificationStatus | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (ALLOWED_STATUS_SET.has(value as VerificationStatus)) {
    return value as VerificationStatus;
  }
  return undefined;
}

function resolveStatusFromPayload(payload: VerificationResource): VerificationStatus {
  if (payload.availability !== 'available') {
    return 'failed';
  }
  const verificationStatus = normalizeStatus(payload.verifierResult.status);
  if (verificationStatus === 'running' || verificationStatus === 'not_run') {
    return verificationStatus;
  }
  const reportStatus = normalizeStatus(payload.verifierResult.report?.status);
  if (reportStatus) {
    return reportStatus;
  }
  return verificationStatus ?? 'not_run';
}

async function fetchVerificationPayload(sessionId: string, finalizationId: string): Promise<VerificationResource> {
  const session = getSessionData();
  if (!session || session.sessionId !== sessionId) {
    throw new StarkPollingError('Verification session authority is unavailable', true, 'SESSION_NOT_FOUND');
  }
  const finalization = resolveCanonicalFinalizationPayload(session.finalizeResult);
  if (!finalization || finalization.finalizationId !== finalizationId) {
    throw new StarkPollingError('Verification finalization authority is unavailable', true, 'FINALIZATION_ID_MISMATCH');
  }

  try {
    return await getVerification(session, finalizationId);
  } catch (error) {
    if (error instanceof StarkPollingError) {
      throw error;
    }
    if (error instanceof ApiClientError) {
      const errorCode = readStandardApiErrorCode(error.responseBody);
      const fatal = error.status === 401 || error.status === 403 || error.status === 404;
      const resolvedMessage = readStandardApiErrorMessage(error.responseBody) ?? errorCode ?? error.statusText;
      const message = resolvedMessage || 'Verification API error';
      throw new StarkPollingError(message, fatal, errorCode);
    }
    throw error;
  }
}

function scheduleNextPoll(state: PollingState, poll: () => Promise<void>): void {
  if (state.cancelled) {
    return;
  }
  const intervalMs = resolveNextInterval(state.intervalMs);
  state.timeoutId = window.setTimeout(() => {
    void poll();
  }, intervalMs);
}

function clearPollingState(state: PollingState): void {
  if (state.timeoutId) {
    window.clearTimeout(state.timeoutId);
  }
  state.cancelled = true;
}

function isPollingActive(state: PollingState | null): boolean {
  return Boolean(state && !state.cancelled);
}

function finalizePolling(state: PollingState): void {
  clearPollingState(state);
  if (pollingState === state) {
    pollingState = null;
  }
}

function hasActiveSession(sessionId: string, finalizationId: string): boolean {
  const session = getSessionData();
  const finalization = resolveCanonicalFinalizationPayload(session?.finalizeResult);
  return Boolean(
    session && session.sessionId === sessionId && finalization && finalization.finalizationId === finalizationId,
  );
}

function clearClientStateForFatalPollingError(sessionId: string, error: StarkPollingError): void {
  const session = getSessionData();
  if (!session || session.sessionId !== sessionId) {
    return;
  }

  const identity = captureSessionIdentity(session);
  if (isFailClosedFinalizationErrorCode(error.code)) {
    clearClientFinalizedProjection(identity);
    return;
  }

  if (isCapabilityLossErrorCode(error.code) || error.code === 'SESSION_NOT_FOUND') {
    clearClientSessionAuthority(identity);
    return;
  }

  clearSession();
}

function resolveNextInterval(baseIntervalMs: number): number {
  let nextInterval = baseIntervalMs;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    nextInterval = Math.max(nextInterval, 5000);
  }
  if (typeof document !== 'undefined' && document.hidden) {
    nextInterval = Math.max(nextInterval, 2000);
  }
  return nextInterval;
}

/**
 * Start polling the verification resource for the given session until STARK verification completes or times out.
 * Stops automatically when the session disappears, a terminal status arrives, or a fatal error occurs.
 * Applies a slower interval when the tab is hidden or offline to reduce background load.
 */
export function startStarkVerificationPolling(options: PollingOptions): void {
  if (
    !options.sessionId ||
    typeof options.sessionId !== 'string' ||
    !options.finalizationId ||
    typeof options.finalizationId !== 'string'
  ) {
    return;
  }
  if (typeof window === 'undefined') {
    return;
  }
  if (!hasActiveSession(options.sessionId, options.finalizationId)) {
    return;
  }

  if (
    pollingState &&
    pollingState.sessionId === options.sessionId &&
    pollingState.finalizationId === options.finalizationId &&
    isPollingActive(pollingState)
  ) {
    return;
  }

  if (pollingState) {
    clearPollingState(pollingState);
  }
  if (
    latestSnapshot &&
    (latestSnapshot.sessionId !== options.sessionId || latestSnapshot.finalizationId !== options.finalizationId)
  ) {
    latestSnapshot = null;
  }

  const state: PollingState = {
    sessionId: options.sessionId,
    finalizationId: options.finalizationId,
    intervalMs: options.intervalMs ?? STARK_POLL_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? STARK_POLL_TIMEOUT_MS,
    startedAt: Date.now(),
    cancelled: false,
  };
  pollingState = state;

  const poll = async () => {
    if (state.cancelled || pollingState !== state) {
      return;
    }
    if (!hasActiveSession(state.sessionId, state.finalizationId)) {
      finalizePolling(state);
      return;
    }
    if (Date.now() - state.startedAt >= state.timeoutMs) {
      finalizePolling(state);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      scheduleNextPoll(state, poll);
      return;
    }

    try {
      const payload = await fetchVerificationPayload(state.sessionId, state.finalizationId);
      const status = resolveStatusFromPayload(payload);
      notifySnapshot({
        sessionId: state.sessionId,
        finalizationId: state.finalizationId,
        status,
        payload,
        receivedAt: Date.now(),
      });

      if (status === 'running' || status === 'not_run') {
        scheduleNextPoll(state, poll);
        return;
      }

      finalizePolling(state);
    } catch (error) {
      const fatal = error instanceof StarkPollingError ? error.fatal : false;
      if (fatal) {
        if (error instanceof StarkPollingError) {
          clearClientStateForFatalPollingError(state.sessionId, error);
        }
        finalizePolling(state);
        return;
      }
      scheduleNextPoll(state, poll);
    }
  };

  void poll();
}

/**
 * Stop any in-flight STARK verification polling.
 */
export function stopStarkVerificationPolling(): void {
  if (!pollingState) {
    return;
  }
  finalizePolling(pollingState);
}

/**
 * Subscribe to verification snapshots emitted by the background poller.
 */
export function subscribeStarkVerificationSnapshot(listener: StarkVerificationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Return the most recent snapshot from the background poller, if any.
 */
export function getStarkVerificationSnapshot(): StarkVerificationSnapshot | null {
  return latestSnapshot;
}

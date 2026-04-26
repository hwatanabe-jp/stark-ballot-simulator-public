import { apiFetch } from '@/lib/api/apiFetch';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { captureSessionIdentity, clearSessionData, getSessionAuthHeaders, getSessionData } from '@/lib/session';
import {
  clearClientFinalizedProjection,
  clearClientSessionAuthority,
} from '@/lib/finalize/client-finalization-boundary';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import { getRecordProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { isCapabilityLossErrorCode, isFailClosedFinalizationErrorCode } from '@/lib/errors/apiErrorGuards';
import type { VerificationStatus } from '@/types/server';

export const STARK_POLL_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 50 : 500;
export const STARK_POLL_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 500 : 30_000;

const ALLOWED_STATUSES: VerificationStatus[] = ['success', 'failed', 'dev_mode', 'not_run', 'running'];
const ALLOWED_STATUS_SET = new Set<VerificationStatus>(ALLOWED_STATUSES);

export type StarkVerificationSnapshot = {
  sessionId: string;
  status: VerificationStatus;
  payload: unknown;
  receivedAt: number;
};

type StarkVerificationListener = (snapshot: StarkVerificationSnapshot) => void;

type PollingState = {
  sessionId: string;
  intervalMs: number;
  timeoutMs: number;
  startedAt: number;
  cancelled: boolean;
  timeoutId?: number;
};

type PollingOptions = {
  sessionId: string;
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
    this.code = code;
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

function resolveStatusFromPayload(payload: unknown): VerificationStatus {
  if (!isRecord(payload)) {
    return 'not_run';
  }
  const verificationStatus = normalizeStatus(getStringProperty(payload, 'verificationStatus'));
  if (verificationStatus === 'running' || verificationStatus === 'not_run') {
    return verificationStatus;
  }
  const report = getRecordProperty(payload, 'verificationReport');
  const reportStatus = normalizeStatus(getStringProperty(report, 'status'));
  if (reportStatus) {
    return reportStatus;
  }
  return verificationStatus ?? 'not_run';
}

async function fetchVerificationPayload(sessionId: string): Promise<unknown> {
  const session = getSessionData();
  if (!session || session.sessionId !== sessionId) {
    throw new StarkPollingError('Verification session authority is unavailable', true, 'SESSION_NOT_FOUND');
  }

  const response = await apiFetch(resolveApiUrl('/api/verify'), {
    headers: getSessionAuthHeaders(session),
  });

  let rawBody: unknown = {};
  try {
    rawBody = await response.json();
  } catch {
    rawBody = {};
  }

  const errorCode = isRecord(rawBody) ? getStringProperty(rawBody, 'error') : undefined;
  if (response.ok && isFailClosedFinalizationErrorCode(errorCode)) {
    const message = getStringProperty(rawBody, 'message') ?? errorCode;
    throw new StarkPollingError(message || 'Verification API error', true, errorCode);
  }

  const payloadSource = isRecord(rawBody) ? (getRecordProperty(rawBody, 'data') ?? rawBody) : rawBody;

  if (!response.ok) {
    const fatal = response.status === 401 || response.status === 403 || response.status === 404;
    const message = (errorCode ?? response.statusText) || 'Verification API error';
    throw new StarkPollingError(message, fatal, errorCode);
  }

  return payloadSource;
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

function hasActiveSession(sessionId: string): boolean {
  const session = getSessionData();
  return Boolean(
    session && session.sessionId === sessionId && resolveCanonicalFinalizationPayload(session.finalizeResult),
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

  clearSessionData();
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
 * Start polling /api/verify for the given session until STARK verification completes or times out.
 * Stops automatically when the session disappears, a terminal status arrives, or a fatal error occurs.
 * Applies a slower interval when the tab is hidden or offline to reduce background load.
 */
export function startStarkVerificationPolling(options: PollingOptions): void {
  if (!options.sessionId || typeof options.sessionId !== 'string') {
    return;
  }
  if (typeof window === 'undefined') {
    return;
  }
  if (!hasActiveSession(options.sessionId)) {
    return;
  }

  if (pollingState && pollingState.sessionId === options.sessionId && isPollingActive(pollingState)) {
    return;
  }

  if (pollingState) {
    clearPollingState(pollingState);
  }

  const state: PollingState = {
    sessionId: options.sessionId,
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
    if (!hasActiveSession(state.sessionId)) {
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
      const payload = await fetchVerificationPayload(state.sessionId);
      const status = resolveStatusFromPayload(payload);
      notifySnapshot({
        sessionId: state.sessionId,
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

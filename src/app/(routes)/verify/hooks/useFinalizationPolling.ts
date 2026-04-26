'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clearSessionData, getSessionAuthHeaders, getSessionData } from '@/lib/session';
import { getStringProperty, isRecord } from '@/lib/utils/guards';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { apiFetch } from '@/lib/api/apiFetch';
import {
  fetchFinalizationStatus,
  FinalizationStatusError,
  resolveFinalizationStatusErrorCode,
  type FinalizationStatusResponse,
} from '@/lib/finalize/finalization-status-client';
import {
  clearClientFinalizedProjection,
  hasFailClosedFinalizationStatus,
} from '@/lib/finalize/client-finalization-boundary';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import type { FinalizationState } from '@/types/server';
import { safeJsonParse, isAbortError } from '../lib/verification-utils';
import { isFinalizationState } from '../lib/finalization';

const SESSION_ERROR_KEY = 'pages.verify.sessionError';
const STATUS_POLL_MIN_DELAY_MS = 1000;
const STATUS_POLL_MAX_DELAY_MS = 5000;

interface UseFinalizationPollingOptions {
  t: (key: string, vars?: Record<string, string | number>) => string;
  triggerFetch: () => void;
  setLoading: (value: boolean) => void;
  onMissingSession?: () => void;
}

interface UseFinalizationPollingResult {
  finalizationState: FinalizationState | null;
  finalizationUpdatedAt: number | null;
  statusVariant: 'info' | 'error' | 'success';
  statusMessage: string | null;
  stepFunctionsDetails: FinalizationStatusResponse['stepFunctions'];
  cancelStatus: 'idle' | 'pending' | 'success' | 'error';
  cancelError: string | null;
  handleCancelFinalization: () => Promise<void>;
}

export function useFinalizationPolling({
  t,
  triggerFetch,
  setLoading,
  onMissingSession,
}: UseFinalizationPollingOptions): UseFinalizationPollingResult {
  const [stepFunctionsDetails, setStepFunctionsDetails] = useState<FinalizationStatusResponse['stepFunctions']>(null);
  const [statusVariant, setStatusVariant] = useState<'info' | 'error' | 'success'>('info');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [finalizationState, setFinalizationState] = useState<FinalizationState | null>(null);
  const [finalizationUpdatedAt, setFinalizationUpdatedAt] = useState<number | null>(null);
  const [cancelStatus, setCancelStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [cancelError, setCancelError] = useState<string | null>(null);

  const lastFetchedExecutionRef = useRef<string | null>(null);
  const syncFetchTriggeredRef = useRef<boolean>(false);
  const pollingDisabledRef = useRef(false);
  const statusAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (finalizationState && (finalizationState.status === 'pending' || finalizationState.status === 'running')) {
      if (cancelStatus === 'success' || cancelStatus === 'error') {
        setCancelStatus('idle');
        setCancelError(null);
      }
    }
  }, [finalizationState, cancelStatus]);

  useEffect(() => {
    const session = getSessionData();
    if (!session) {
      onMissingSession?.();
      setLoading(false);
      return;
    }

    if (pollingDisabledRef.current) {
      return;
    }

    const cancelledRef: { current: boolean } = { current: false };
    let timeoutId: number | null = null;
    let delayMs = STATUS_POLL_MIN_DELAY_MS;
    const setUnsupportedResultFailure = () => {
      setStatusVariant('error');
      setStatusMessage(
        t('pages.verify.finalization.messages.failed', {
          code: 'UNSUPPORTED_RESULT',
          message: t('errors.generic'),
        }),
      );
      setLoading(false);
    };

    const stopPolling = () => {
      if (pollingDisabledRef.current) {
        return;
      }
      pollingDisabledRef.current = true;
      cancelledRef.current = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (statusAbortRef.current) {
        statusAbortRef.current.abort();
        statusAbortRef.current = null;
      }
    };

    const scheduleNext = () => {
      if (cancelledRef.current || pollingDisabledRef.current) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        void poll();
      }, delayMs);
      delayMs = Math.min(Math.floor(delayMs * 1.5), STATUS_POLL_MAX_DELAY_MS);
    };

    const poll = async () => {
      if (cancelledRef.current || pollingDisabledRef.current) {
        return;
      }

      const controller = new AbortController();
      statusAbortRef.current = controller;

      try {
        const status = await fetchFinalizationStatus(session.sessionId, {
          signal: controller.signal,
          authHeaders: getSessionAuthHeaders(session),
        });
        statusAbortRef.current = null;
        const state = status.finalizationState ?? null;
        if (hasFailClosedFinalizationStatus(status)) {
          clearClientFinalizedProjection();
          setStepFunctionsDetails(null);
          setFinalizationState(state);
          setFinalizationUpdatedAt(Date.now());
          setStatusVariant('error');
          setStatusMessage(state?.status === 'failed' ? state.error.message : t('errors.generic'));
          setLoading(false);
          stopPolling();
          return;
        }
        const supportedFinalizationResult = resolveCanonicalFinalizationPayload(status.finalizationResult);
        const hasFinalizationResult = Boolean(supportedFinalizationResult);
        const hasUnsupportedFinalizationResult = Boolean(status.finalizationResult) && !supportedFinalizationResult;
        const shouldFetchVerification =
          (state?.status === 'succeeded' && hasFinalizationResult) || (state === null && hasFinalizationResult);
        setStepFunctionsDetails(status.stepFunctions ?? null);
        setFinalizationState(state);
        setFinalizationUpdatedAt(Date.now());

        if (shouldFetchVerification) {
          const fetchKey = state?.executionId ?? 'sync';
          if (lastFetchedExecutionRef.current !== fetchKey) {
            lastFetchedExecutionRef.current = fetchKey;
            triggerFetch();
          }
        }

        if (!state) {
          if (hasUnsupportedFinalizationResult) {
            clearClientFinalizedProjection();
            setUnsupportedResultFailure();
            stopPolling();
            return;
          }
          if (shouldFetchVerification) {
            setStatusVariant('success');
            setStatusMessage(
              t('pages.verify.finalization.messages.succeeded', {
                time: t('common.unknown'),
              }),
            );
            stopPolling();
            return;
          }

          setStatusVariant('info');
          setStatusMessage(t('pages.verify.finalization.messages.waiting'));
          scheduleNext();
          return;
        }

        switch (state.status) {
          case 'pending': {
            setStatusVariant('info');
            setStatusMessage(
              t('pages.verify.finalization.messages.queued', {
                time: new Date(state.queuedAt).toLocaleString(),
              }),
            );
            scheduleNext();
            break;
          }
          case 'running': {
            setStatusVariant('info');
            setStatusMessage(
              t('pages.verify.finalization.messages.running', {
                time: new Date(state.startedAt).toLocaleString(),
              }),
            );
            scheduleNext();
            break;
          }
          case 'succeeded': {
            if (!hasFinalizationResult) {
              clearClientFinalizedProjection();
              setUnsupportedResultFailure();
              stopPolling();
              break;
            }
            setStatusVariant('success');
            setStatusMessage(
              t('pages.verify.finalization.messages.succeeded', {
                time: new Date(state.completedAt).toLocaleString(),
              }),
            );
            if (shouldFetchVerification) {
              stopPolling();
              break;
            }
            scheduleNext();
            break;
          }
          case 'failed': {
            setStatusVariant('error');
            setStatusMessage(
              t('pages.verify.finalization.messages.failed', {
                code: state.error.code,
                message: state.error.message,
              }),
            );
            setLoading(false);
            stopPolling();
            break;
          }
          case 'timeout': {
            setStatusVariant('error');
            setStatusMessage(t('pages.verify.finalization.messages.timeout'));
            setLoading(false);
            stopPolling();
            break;
          }
          default: {
            scheduleNext();
            break;
          }
        }
      } catch (err) {
        statusAbortRef.current = null;
        if (isAbortError(err)) {
          return;
        }

        if (err instanceof FinalizationStatusError) {
          if (resolveFinalizationStatusErrorCode(err) === 'SESSION_NOT_FOUND') {
            clearSessionData();
            onMissingSession?.();
            setStatusVariant('error');
            setStatusMessage(t(SESSION_ERROR_KEY));
            setStepFunctionsDetails(null);
            setLoading(false);
            stopPolling();
            return;
          }

          if (err.status === 404) {
            console.info('[Verify] Async finalization is disabled (mock mode). Polling stopped.');
            if (!syncFetchTriggeredRef.current) {
              syncFetchTriggeredRef.current = true;
              triggerFetch();
            }
            setStatusVariant('info');
            setStatusMessage(t('pages.verify.finalization.messages.asyncDisabled'));
            setStepFunctionsDetails(null);
            stopPolling();
            return;
          }

          if (err.status >= 500) {
            console.warn(`[Verify] Status polling received ${err.status}, retrying...`);
            scheduleNext();
            return;
          }

          setStatusVariant('error');
          setStatusMessage(
            t('pages.verify.finalization.messages.statusError', {
              status: err.status,
            }),
          );
          setLoading(false);
          stopPolling();
          return;
        }

        console.warn('[Verify] Status polling error', err);
        scheduleNext();
      }
    };

    void poll();

    return () => {
      cancelledRef.current = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      if (statusAbortRef.current) {
        statusAbortRef.current.abort();
        statusAbortRef.current = null;
      }
    };
  }, [t, triggerFetch, setLoading, onMissingSession]);

  const handleCancelFinalization = useCallback(async () => {
    if (!finalizationState || (finalizationState.status !== 'pending' && finalizationState.status !== 'running')) {
      return;
    }
    const session = getSessionData();
    if (!session) {
      setCancelStatus('error');
      setCancelError(t(SESSION_ERROR_KEY));
      return;
    }

    setCancelStatus('pending');
    setCancelError(null);

    try {
      const response = await apiFetch(resolveApiUrl('/api/finalize/cancel'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getSessionAuthHeaders(session),
        },
        body: JSON.stringify({ executionId: finalizationState.executionId }),
      });

      const rawPayload = await response.text();
      const parsedPayload = safeJsonParse(rawPayload);
      if (!parsedPayload.ok && response.ok) {
        throw new Error('Failed to parse cancel response');
      }
      const payload = parsedPayload.ok ? parsedPayload.value : null;

      if (!response.ok) {
        const reason = getStringProperty(payload, 'error') ?? response.statusText;
        throw new Error(reason);
      }

      if (isRecord(payload) && isFinalizationState(payload.state)) {
        setFinalizationState(payload.state);
        setFinalizationUpdatedAt(Date.now());
      }

      setCancelStatus('success');
      setStatusVariant('error');
      setStatusMessage(t('pages.verify.finalization.cancelled'));
      setLoading(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCancelStatus('error');
      setCancelError(`${t('pages.verify.finalization.cancelErrorPrefix')} ${message}`);
    }
  }, [finalizationState, setLoading, t]);

  return {
    finalizationState,
    finalizationUpdatedAt,
    statusVariant,
    statusMessage,
    stepFunctionsDetails,
    cancelStatus,
    cancelError,
    handleCancelFinalization,
  };
}

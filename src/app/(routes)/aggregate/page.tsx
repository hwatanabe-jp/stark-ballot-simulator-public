'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { FinalizeButton, ProgressDisplay, TamperScenarioSelector, type ScenarioId } from '@/components/aggregate';
import { useTranslation } from '@/lib/hooks';
import {
  captureSessionIdentity,
  clearSessionData,
  getSessionData,
  getSessionDataForIdentity,
  getSessionAuthHeaders,
  isSessionReplacedForIdentity,
  isSessionReplaced,
  saveSessionDataForIdentity,
  SESSION_STORAGE_KEY,
} from '@/lib/session';
import { getKnowledgeValue, mergeKnowledgeFromApi, saveKnowledgeData, VERIFICATION_GATED_KEYS } from '@/lib/knowledge';
import { TurnstileWidget } from '@/components/security/TurnstileWidget';
import {
  clearClientFinalizedProjection,
  hasFailClosedFinalizationStatus,
} from '@/lib/finalize/client-finalization-boundary';
import {
  projectClientFinalizationSnapshotForKnowledge,
  resolveCanonicalFinalizationPayload,
  type ClientFinalizationSnapshot,
} from '@/lib/finalize/client-finalization-result';
import { getRecordProperty, getStringProperty, getNumberProperty } from '@/lib/utils/guards';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import {
  fetchFinalizationStatus,
  resolveFinalizationStatusErrorCode,
  type FinalizationStatusResponse,
} from '@/lib/finalize/finalization-status-client';
import { apiFetch } from '@/lib/api/apiFetch';

type FinalizationPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed';

interface QueueInfo {
  position?: number;
  depth?: number;
  concurrencyLimit?: number;
  estimatedStartAt?: number;
  estimatedDurationMs?: number;
  estimatedCompletionAt?: number;
}

const RESULT_TRANSITION_DELAY_MS = 500;

const isFinalizationResultReady = (status: FinalizationStatusResponse): boolean => {
  if (!status.finalizationResult) {
    return false;
  }
  const state = status.finalizationState;
  if (!state) {
    return true;
  }
  return state.status === 'succeeded';
};

export default function AggregatePage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId | null>(
    () => getKnowledgeValue('scenarioId') ?? null,
  );
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<FinalizationPhase>('idle');
  const [queueInfo, setQueueInfo] = useState<QueueInfo>({});
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const navigationTimeoutRef = useRef<number | null>(null);
  const [expectedSessionIdentity] = useState(() => captureSessionIdentity(getSessionData()));
  const expectedSessionIdentityRef = useRef(expectedSessionIdentity);
  const expectedSessionId = expectedSessionIdentity?.sessionId;

  const getExpectedSession = useCallback(
    () => getSessionDataForIdentity(expectedSessionIdentityRef.current),
    [expectedSessionIdentityRef],
  );

  const resolveSessionErrorMessage = useCallback(
    (): string =>
      isSessionReplacedForIdentity(expectedSessionIdentityRef.current) || isSessionReplaced()
        ? t('pages.aggregate.errors.sessionReplaced')
        : t('pages.aggregate.errors.sessionNotFound'),
    [t],
  );

  const scheduleResultNavigation = useCallback(
    (finalizationResult: ClientFinalizationSnapshot): void => {
      setPhase('succeeded');
      mergeKnowledgeFromApi('result', projectClientFinalizationSnapshotForKnowledge(finalizationResult), {
        omitKeys: VERIFICATION_GATED_KEYS,
        expectedSessionId,
      });
      saveSessionDataForIdentity(expectedSessionIdentityRef.current, {
        finalizeResult: finalizationResult,
        phase: 'verifying',
      });
      if (navigationTimeoutRef.current) {
        window.clearTimeout(navigationTimeoutRef.current);
      }
      navigationTimeoutRef.current = window.setTimeout(() => {
        router.push('/result');
      }, RESULT_TRANSITION_DELAY_MS);
    },
    [expectedSessionId, router],
  );

  const handleMissingFinalizeResult = useCallback(
    (context: string): void => {
      console.error(`[AggregatePage] Finalization result missing (${context}).`);
      setError(t('errors.generic'));
      setPhase('failed');
    },
    [t],
  );

  const handleMissingSession = useCallback((): void => {
    clearSessionData();
    setQueueInfo({});
    setQueuedAt(null);
    setStartedAt(null);
    setError(resolveSessionErrorMessage());
    setPhase('failed');
  }, [resolveSessionErrorMessage]);

  const handleFailClosedStatus = useCallback(
    (status: FinalizationStatusResponse): void => {
      clearClientFinalizedProjection(expectedSessionIdentityRef.current);
      setQueueInfo({});
      setQueuedAt(null);
      setStartedAt(null);
      setPhase('failed');

      const state = status.finalizationState;
      if (state?.status === 'failed') {
        setError(state.error.message || t('errors.generic'));
        return;
      }
      if (state?.status === 'timeout') {
        setError(t('pages.aggregate.errors.timeout'));
        return;
      }

      setError(t('errors.generic'));
    },
    [t],
  );

  const handleStatusFinalizeResult = useCallback(
    (finalizationResult: unknown, context: string): void => {
      const canonicalFinalizationResult = resolveCanonicalFinalizationPayload(finalizationResult);
      if (!canonicalFinalizationResult) {
        clearClientFinalizedProjection(expectedSessionIdentityRef.current);
        handleMissingFinalizeResult(context);
        return;
      }
      scheduleResultNavigation(canonicalFinalizationResult);
    },
    [handleMissingFinalizeResult, scheduleResultNavigation],
  );

  useEffect(() => {
    return () => {
      if (navigationTimeoutRef.current) {
        window.clearTimeout(navigationTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY) {
        return;
      }
      if (!isSessionReplacedForIdentity(expectedSessionIdentityRef.current)) {
        return;
      }
      setError(t('pages.aggregate.errors.sessionReplaced'));
      setPhase('failed');
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [t]);

  const scrollToBottom = useCallback((): void => {
    if (typeof window === 'undefined') {
      return;
    }
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';
    window.setTimeout(() => {
      try {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
      } catch {
        // no-op
      }
    }, 60);
  }, []);

  const handleScenarioChange = useCallback(
    (scenarioId: ScenarioId): void => {
      if (isSessionReplacedForIdentity(expectedSessionIdentityRef.current)) {
        setError(t('pages.aggregate.errors.sessionReplaced'));
        setPhase('failed');
        return;
      }
      setSelectedScenario(scenarioId);
      saveKnowledgeData({ scenarioId }, { expectedSessionId });
      scrollToBottom();
    },
    [expectedSessionId, scrollToBottom, t],
  );

  useEffect(() => {
    const sessionData = getExpectedSession();
    if (!sessionData?.sessionId) {
      if (isSessionReplacedForIdentity(expectedSessionIdentityRef.current)) {
        setError(t('pages.aggregate.errors.sessionReplaced'));
        setPhase('failed');
      }
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const restoreFinalization = async () => {
      try {
        if (!getExpectedSession()) {
          setError(t('pages.aggregate.errors.sessionReplaced'));
          setPhase('failed');
          return;
        }

        const status = await fetchFinalizationStatus(sessionData.sessionId, {
          signal: controller.signal,
          authHeaders: getSessionAuthHeaders(sessionData),
        });
        if (cancelled) {
          return;
        }
        if (!getExpectedSession()) {
          setError(t('pages.aggregate.errors.sessionReplaced'));
          setPhase('failed');
          return;
        }

        if (hasFailClosedFinalizationStatus(status)) {
          handleFailClosedStatus(status);
          return;
        }

        if (isFinalizationResultReady(status)) {
          handleStatusFinalizeResult(status.finalizationResult, 'status-restore');
          return;
        }

        const state = status.finalizationState;
        if (!state) {
          return;
        }

        switch (state.status) {
          case 'pending':
            setPhase('queued');
            setQueuedAt(state.queuedAt);
            setStartedAt(null);
            setError(null);
            if (status.queue) {
              setQueueInfo({
                position: status.queue.position,
                depth: status.queue.depth,
                concurrencyLimit: status.queue.concurrencyLimit,
                estimatedStartAt: status.queue.estimatedStartAt,
                estimatedDurationMs: status.queue.estimatedDurationMs,
                estimatedCompletionAt: status.queue.estimatedCompletionAt,
              });
            } else {
              setQueueInfo({});
            }
            saveSessionDataForIdentity(expectedSessionIdentityRef.current, { phase: 'finalizing' });
            break;
          case 'running':
            setPhase('running');
            setQueuedAt(state.queuedAt);
            setStartedAt(state.startedAt);
            setError(null);
            if (status.queue) {
              setQueueInfo({
                position: status.queue.position,
                depth: status.queue.depth,
                concurrencyLimit: status.queue.concurrencyLimit,
                estimatedStartAt: status.queue.estimatedStartAt,
                estimatedDurationMs: status.queue.estimatedDurationMs,
                estimatedCompletionAt: status.queue.estimatedCompletionAt,
              });
            } else {
              setQueueInfo({});
            }
            saveSessionDataForIdentity(expectedSessionIdentityRef.current, { phase: 'finalizing' });
            break;
          case 'succeeded':
            handleStatusFinalizeResult(status.finalizationResult, 'status-succeeded');
            return;
          case 'failed':
            setPhase('failed');
            setError(state.error.message || t('errors.generic'));
            return;
          case 'timeout':
            setPhase('failed');
            setError(t('pages.aggregate.errors.timeout'));
            return;
        }
      } catch (err) {
        if (!cancelled && resolveFinalizationStatusErrorCode(err) === 'SESSION_NOT_FOUND') {
          handleMissingSession();
          return;
        }
        if (!cancelled) {
          console.error('[AggregatePage] Restore status error:', err);
        }
      }
    };

    void restoreFinalization();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [getExpectedSession, handleFailClosedStatus, handleMissingSession, handleStatusFinalizeResult, t]);

  // Poll for finalization status when in queued/running phase
  useEffect(() => {
    if (phase !== 'queued' && phase !== 'running') {
      return;
    }

    const controller = new AbortController();
    let timeoutId: number | null = null;
    const isPollingStopped = (): boolean => controller.signal.aborted;
    const sessionData = getExpectedSession();
    if (!sessionData?.sessionId) {
      timeoutId = window.setTimeout(() => {
        if (isPollingStopped()) {
          return;
        }
        setError(resolveSessionErrorMessage());
        setPhase('failed');
      }, 0);
      return () => {
        controller.abort();
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
      };
    }

    const poll = async () => {
      if (isPollingStopped()) return;
      if (!getExpectedSession()) {
        setError(t('pages.aggregate.errors.sessionReplaced'));
        setPhase('failed');
        return;
      }

      try {
        const status = await fetchFinalizationStatus(sessionData.sessionId, {
          signal: controller.signal,
          authHeaders: getSessionAuthHeaders(sessionData),
        });
        if (isPollingStopped()) return;
        if (!getExpectedSession()) {
          setError(t('pages.aggregate.errors.sessionReplaced'));
          setPhase('failed');
          return;
        }

        if (hasFailClosedFinalizationStatus(status)) {
          handleFailClosedStatus(status);
          return;
        }

        const state = status.finalizationState;
        if (!state) {
          // No async state - check if result is available
          if (isFinalizationResultReady(status)) {
            handleStatusFinalizeResult(status.finalizationResult, 'status-no-state');
          }
          return;
        }

        // Update phase and timing info
        switch (state.status) {
          case 'pending':
            setPhase('queued');
            setQueuedAt(state.queuedAt);
            if (status.queue) {
              setQueueInfo({
                position: status.queue.position,
                depth: status.queue.depth,
                concurrencyLimit: status.queue.concurrencyLimit,
                estimatedStartAt: status.queue.estimatedStartAt,
                estimatedDurationMs: status.queue.estimatedDurationMs,
                estimatedCompletionAt: status.queue.estimatedCompletionAt,
              });
            } else {
              // Clear queue info when unavailable (avoid stale UI)
              setQueueInfo({});
            }
            break;
          case 'running':
            setPhase('running');
            setQueuedAt(state.queuedAt);
            setStartedAt(state.startedAt);
            if (status.queue) {
              setQueueInfo({
                position: status.queue.position,
                depth: status.queue.depth,
                concurrencyLimit: status.queue.concurrencyLimit,
                estimatedStartAt: status.queue.estimatedStartAt,
                estimatedDurationMs: status.queue.estimatedDurationMs,
                estimatedCompletionAt: status.queue.estimatedCompletionAt,
              });
            }
            break;
          case 'succeeded':
            handleStatusFinalizeResult(status.finalizationResult, 'status-succeeded');
            return;
          case 'failed':
            setPhase('failed');
            setError(state.error.message || t('errors.generic'));
            return;
          case 'timeout':
            setPhase('failed');
            setError(t('pages.aggregate.errors.timeout'));
            return;
        }

        // Continue polling
        timeoutId = window.setTimeout(() => void poll(), 1500);
      } catch (err) {
        if (isPollingStopped()) {
          return;
        }
        if (resolveFinalizationStatusErrorCode(err) === 'SESSION_NOT_FOUND') {
          handleMissingSession();
          return;
        }
        console.error('[AggregatePage] Poll error:', err);
        timeoutId = window.setTimeout(() => void poll(), 3000);
      }
    };

    void poll();

    return () => {
      controller.abort();
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    getExpectedSession,
    handleFailClosedStatus,
    handleMissingSession,
    handleStatusFinalizeResult,
    phase,
    resolveSessionErrorMessage,
    t,
  ]);

  const handleFinalize = useCallback(async () => {
    const sessionData = getExpectedSession();
    if (!sessionData?.sessionId) {
      setError(resolveSessionErrorMessage());
      setPhase('failed');
      return;
    }

    if (!selectedScenario) {
      setError(t('pages.aggregate.errors.scenarioRequired'));
      return;
    }

    if (!turnstileToken) {
      setError(t('errors.captchaFailed'));
      return;
    }

    setPhase('submitting');
    setError(null);

    try {
      // scenarioId is stored for API continuity (hidden in Knowledge Panel)

      const scenarioId = selectedScenario;
      const response = await apiFetch(resolveApiUrl('/api/finalize'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getSessionAuthHeaders(sessionData),
        },
        body: JSON.stringify({ scenarioId, turnstileToken }),
      });

      if (!response.ok) {
        let errorPayload: unknown = null;
        try {
          errorPayload = await response.json();
        } catch {
          errorPayload = null;
        }
        const errorCode = getStringProperty(errorPayload, 'error');
        if (errorCode === 'CAPTCHA_FAILED') {
          setError(t('errors.captchaFailed'));
          setTurnstileToken(null);
          setPhase('idle');
          return;
        }
        throw new Error(errorCode ?? 'Unknown error');
      }

      const resultPayload: unknown = await response.json();

      // Check for async (202) vs sync (200) response
      if (response.status === 202) {
        // Async response - extract queue info and start polling
        const state = getRecordProperty(resultPayload, 'state');
        const queue = getRecordProperty(resultPayload, 'queue');

        setQueuedAt(getNumberProperty(state, 'queuedAt') ?? Date.now());
        if (queue) {
          setQueueInfo({
            position: getNumberProperty(queue, 'position'),
            depth: getNumberProperty(queue, 'depth'),
            concurrencyLimit: getNumberProperty(queue, 'concurrencyLimit'),
            estimatedStartAt: getNumberProperty(queue, 'estimatedStartAt'),
            estimatedDurationMs: getNumberProperty(queue, 'estimatedDurationMs') ?? 360000,
            estimatedCompletionAt: getNumberProperty(queue, 'estimatedCompletionAt'),
          });
        } else {
          // Fallback when queue is null
          setQueueInfo({
            estimatedDurationMs: 360000,
          });
        }
        setPhase('queued');
      } else {
        // Sync response - save result and navigate
        const resultData = getRecordProperty(resultPayload, 'data');
        handleStatusFinalizeResult(resultData, 'sync');
      }
    } catch (err) {
      console.error('[AggregatePage] Finalize error:', err);
      setError(err instanceof Error ? err.message : t('errors.generic'));
      setPhase('failed');
    }
  }, [getExpectedSession, selectedScenario, turnstileToken, t, handleStatusFinalizeResult, resolveSessionErrorMessage]);

  const isProcessing = phase !== 'idle' && phase !== 'failed';
  const showProgress = phase === 'queued' || phase === 'running' || phase === 'succeeded';

  // Map phase to ProgressDisplay status
  const progressStatus =
    phase === 'queued' ? 'pending' : phase === 'running' ? 'running' : phase === 'succeeded' ? 'succeeded' : 'pending';
  const progressTitle =
    phase === 'succeeded'
      ? t('pages.aggregate.progress.title.completed')
      : t('pages.aggregate.progress.title.processing');
  const progressDescription =
    phase === 'succeeded'
      ? t('pages.aggregate.progress.description.completed')
      : t('pages.aggregate.progress.description.processing');

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="font-display text-[var(--text-display)] font-bold text-ink-900 mb-3 tracking-[var(--tracking-display)] leading-[var(--leading-display)]">
          {t('pages.aggregate.title')}
        </h1>
        {!showProgress && (
          <p className="font-secondary text-text-secondary leading-relaxed">{t('pages.aggregate.description')}</p>
        )}
      </div>

      {/* Progress Display (shown during finalization) */}
      {showProgress && (
        <Card className="mb-6 animate-fade-in">
          <CardHeader>
            <CardTitle className="font-primary text-xl">{progressTitle}</CardTitle>
            <CardDescription>{progressDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProgressDisplay
              status={progressStatus}
              queuedAt={queuedAt}
              startedAt={startedAt}
              estimatedDurationMs={queueInfo.estimatedDurationMs}
              queuePosition={queueInfo.position}
              queueDepth={queueInfo.depth}
              concurrencyLimit={queueInfo.concurrencyLimit}
              estimatedStartAt={queueInfo.estimatedStartAt}
              estimatedCompletionAt={queueInfo.estimatedCompletionAt}
            />
          </CardContent>
        </Card>
      )}

      {/* Scenario Selector (hidden during processing) */}
      {!showProgress && (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="font-primary text-xl text-ink-800">
                {t('pages.aggregate.scenarios.cardTitle')}
              </CardTitle>
              <CardDescription>{t('pages.aggregate.scenarios.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <TamperScenarioSelector
                value={selectedScenario}
                onChange={handleScenarioChange}
                disabled={isProcessing}
              />
            </CardContent>
          </Card>

          {/* Turnstile CAPTCHA */}
          <div className="mb-6 flex justify-center">
            <TurnstileWidget action="finalize" onTokenChange={setTurnstileToken} disabled={isProcessing} />
          </div>

          {/* Error Display */}
          {error && (
            <div className="mb-6 animate-fade-in">
              <Badge variant="error" size="medium" className="w-full justify-center py-3">
                {error}
              </Badge>
            </div>
          )}

          {/* Submit Button */}
          <FinalizeButton
            onClick={() => {
              void handleFinalize();
            }}
            disabled={!selectedScenario || !turnstileToken || isProcessing}
            loading={phase === 'submitting'}
            className="py-4 text-lg"
          />
        </>
      )}
    </div>
  );
}

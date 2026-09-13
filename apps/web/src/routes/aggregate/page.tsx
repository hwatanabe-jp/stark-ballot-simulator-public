'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FinalizeButton,
  ProgressDisplay,
  TamperScenarioSelector,
  type ScenarioId,
} from '@stark-ballot/web/components/aggregate';
import { useTranslation } from '@stark-ballot/web/hooks';
import {
  captureSessionIdentity,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  isSessionReplaced,
  saveSessionDataForIdentity,
  SESSION_STORAGE_KEY,
} from '@stark-ballot/web/session';
import {
  getKnowledgeValue,
  mergeKnowledgeFromApi,
  saveKnowledgeData,
  VERIFICATION_GATED_KEYS,
} from '@stark-ballot/web/knowledge';
import { TurnstileWidget } from '@stark-ballot/web/components/security/TurnstileWidget';
import { isBrowserTurnstileRequiredForAction } from '@stark-ballot/web/components/security/turnstilePolicy';
import {
  clearClientFinalizedProjection,
  clearClientSessionAuthority,
} from '@stark-ballot/web/finalize/client-finalization-boundary';
import {
  projectFinalizationResourceToClientSnapshot,
  projectClientFinalizationSnapshotForKnowledge,
  type ClientFinalizationSnapshot,
} from '@stark-ballot/web/finalize/client-finalization-result';
import {
  fetchCurrentFinalization,
  resolveFinalizationStatusErrorCode,
  startFinalization,
} from '@stark-ballot/web/api/finalizations';
import type { FinalizationResource, FinalizationQueue } from '@stark-ballot/api-contract/schemas/finalizations';
import { resolveApiClientErrorCode } from '@stark-ballot/web/api/client';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import '@stark-ballot/web/components/aggregate/AggregationViews.css';

type FinalizationPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'succeeded' | 'failed';

interface QueueInfo {
  concurrencyLimit?: number;
  estimatedDurationMs?: number;
}

const RESULT_TRANSITION_DELAY_MS = 500;

const toQueueInfo = (queue: FinalizationQueue): QueueInfo =>
  omitUndefinedProperties({
    concurrencyLimit: queue.concurrencyLimit,
    estimatedDurationMs: queue.estimatedDurationMs,
  });

const knowledgeOptions = (expectedSessionId: string | undefined, omitKeys?: typeof VERIFICATION_GATED_KEYS) =>
  omitUndefinedProperties({
    omitKeys,
    expectedSessionId,
  });

export default function AggregatePage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useAppRouter();
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId | null>(
    () => getKnowledgeValue('scenarioId') ?? null,
  );
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const requireFinalizeTurnstile = isBrowserTurnstileRequiredForAction('finalize');
  const [expectedSessionIdentity] = useState(() => captureSessionIdentity(getSessionData()));
  const [error, setError] = useState<string | null>(() =>
    isSessionReplacedForIdentity(expectedSessionIdentity) || isSessionReplaced()
      ? t('pages.aggregate.errors.sessionReplaced')
      : null,
  );
  const [phase, setPhase] = useState<FinalizationPhase>(error ? 'failed' : 'idle');
  const [queueInfo, setQueueInfo] = useState<QueueInfo>({});
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const navigationTimeoutRef = useRef<number | null>(null);
  const submissionControllerRef = useRef<AbortController | null>(null);
  const expectedSessionId = expectedSessionIdentity?.sessionId;

  const getExpectedSession = useCallback(
    () => getSessionDataForIdentity(expectedSessionIdentity),
    [expectedSessionIdentity],
  );

  const resolveSessionErrorMessage = useCallback(
    (): string =>
      isSessionReplacedForIdentity(expectedSessionIdentity) || isSessionReplaced()
        ? t('pages.aggregate.errors.sessionReplaced')
        : t('pages.aggregate.errors.sessionNotFound'),
    [expectedSessionIdentity, t],
  );

  const scheduleResultNavigation = useCallback(
    (finalizationResult: ClientFinalizationSnapshot): void => {
      setPhase('succeeded');
      mergeKnowledgeFromApi(
        projectClientFinalizationSnapshotForKnowledge(finalizationResult),
        knowledgeOptions(expectedSessionId, VERIFICATION_GATED_KEYS),
      );
      saveSessionDataForIdentity(expectedSessionIdentity, {
        finalizeResult: finalizationResult,
        phase: 'verifying',
      });
      if (navigationTimeoutRef.current) {
        window.clearTimeout(navigationTimeoutRef.current);
      }
      navigationTimeoutRef.current = window.setTimeout(() => {
        if (!getExpectedSession()) {
          setError(resolveSessionErrorMessage());
          setPhase('failed');
          return;
        }
        router.push('/result');
      }, RESULT_TRANSITION_DELAY_MS);
    },
    [expectedSessionId, expectedSessionIdentity, getExpectedSession, resolveSessionErrorMessage, router],
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
    clearClientSessionAuthority(expectedSessionIdentity);
    setQueueInfo({});
    setStartedAt(null);
    setError(resolveSessionErrorMessage());
    setPhase('failed');
  }, [expectedSessionIdentity, resolveSessionErrorMessage]);

  const handleTerminalFailure = useCallback(
    (resource: Extract<FinalizationResource, { status: 'failed' | 'timeout' }>): void => {
      clearClientFinalizedProjection(expectedSessionIdentity);
      setQueueInfo({});
      setStartedAt(null);
      setPhase('failed');

      if (resource.status === 'failed') {
        setError(resource.error.message || t('errors.generic'));
        return;
      }
      setError(t('pages.aggregate.errors.timeout'));
    },
    [expectedSessionIdentity, t],
  );

  const handleSucceededResource = useCallback(
    (resource: Extract<FinalizationResource, { status: 'succeeded' }>, context: string): void => {
      const canonicalFinalizationResult = projectFinalizationResourceToClientSnapshot(resource);
      if (!canonicalFinalizationResult) {
        clearClientFinalizedProjection(expectedSessionIdentity);
        handleMissingFinalizeResult(context);
        return;
      }
      scheduleResultNavigation(canonicalFinalizationResult);
    },
    [expectedSessionIdentity, handleMissingFinalizeResult, scheduleResultNavigation],
  );

  const applyFinalizationResource = useCallback(
    (resource: FinalizationResource): void => {
      const queue = resource.runtimeDiagnostics.queue;
      switch (resource.status) {
        case 'pending':
          setPhase('queued');
          setStartedAt(null);
          setQueueInfo(queue ? toQueueInfo(queue) : {});
          setError(null);
          saveSessionDataForIdentity(expectedSessionIdentity, { phase: 'finalizing' });
          return;
        case 'running':
          setPhase('running');
          setStartedAt(resource.startedAtMs);
          setQueueInfo(queue ? toQueueInfo(queue) : {});
          setError(null);
          saveSessionDataForIdentity(expectedSessionIdentity, { phase: 'finalizing' });
          return;
        case 'succeeded':
          handleSucceededResource(resource, 'current-finalization');
          return;
        case 'failed':
        case 'timeout':
          handleTerminalFailure(resource);
          return;
      }
    },
    [expectedSessionIdentity, handleSucceededResource, handleTerminalFailure],
  );

  useEffect(() => {
    return () => {
      submissionControllerRef.current?.abort();
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
      if (!isSessionReplacedForIdentity(expectedSessionIdentity)) {
        return;
      }
      setError(t('pages.aggregate.errors.sessionReplaced'));
      setPhase('failed');
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [expectedSessionIdentity, t]);

  const handleScenarioChange = useCallback(
    (scenarioId: ScenarioId): void => {
      if (isSessionReplacedForIdentity(expectedSessionIdentity)) {
        setError(t('pages.aggregate.errors.sessionReplaced'));
        setPhase('failed');
        return;
      }
      setSelectedScenario(scenarioId);
      saveKnowledgeData({ scenarioId }, knowledgeOptions(expectedSessionId));
    },
    [expectedSessionId, expectedSessionIdentity, t],
  );

  useEffect(() => {
    const sessionData = getExpectedSession();
    if (!sessionData?.sessionId) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const restoreFinalization = async () => {
      try {
        const resource = await fetchCurrentFinalization(sessionData, {
          signal: controller.signal,
        });
        if (cancelled) {
          return;
        }
        if (!getExpectedSession()) {
          setError(t('pages.aggregate.errors.sessionReplaced'));
          setPhase('failed');
          return;
        }

        if (!resource) {
          return;
        }
        applyFinalizationResource(resource);
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
  }, [applyFinalizationResource, getExpectedSession, handleMissingSession, t]);

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
        const resource = await fetchCurrentFinalization(sessionData, {
          signal: controller.signal,
        });
        if (isPollingStopped()) return;
        if (!getExpectedSession()) {
          setError(t('pages.aggregate.errors.sessionReplaced'));
          setPhase('failed');
          return;
        }

        if (!resource) {
          return;
        }
        applyFinalizationResource(resource);
        if (resource.status === 'succeeded' || resource.status === 'failed' || resource.status === 'timeout') {
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
  }, [getExpectedSession, applyFinalizationResource, handleMissingSession, phase, resolveSessionErrorMessage, t]);

  const handleFinalize = useCallback(async () => {
    if (submissionControllerRef.current) return;
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

    if (requireFinalizeTurnstile && !turnstileToken) {
      setError(t('errors.captchaFailed'));
      return;
    }

    const controller = new AbortController();
    submissionControllerRef.current = controller;
    setPhase('submitting');
    setError(null);

    try {
      // scenarioId is stored for API continuity (hidden in Knowledge Panel)

      const scenarioId = selectedScenario;
      let result;
      try {
        result = await startFinalization(
          sessionData,
          {
            scenarioId,
            ...(turnstileToken ? { turnstileToken } : {}),
          },
          { signal: controller.signal },
        );
      } catch (requestError) {
        if (controller.signal.aborted) return;
        const errorCode = resolveApiClientErrorCode(requestError);
        if (errorCode === 'CAPTCHA_FAILED') {
          setError(t('errors.captchaFailed'));
          setTurnstileToken(null);
          setPhase('idle');
          return;
        }
        throw requestError;
      }

      if (controller.signal.aborted) return;
      if (!getExpectedSession()) {
        setError(resolveSessionErrorMessage());
        setPhase('failed');
        return;
      }
      applyFinalizationResource(result.data);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('[AggregatePage] Finalize error:', err);
      setError(err instanceof Error ? err.message : t('errors.generic'));
      setPhase('failed');
    } finally {
      if (submissionControllerRef.current === controller) submissionControllerRef.current = null;
    }
  }, [
    getExpectedSession,
    selectedScenario,
    turnstileToken,
    requireFinalizeTurnstile,
    t,
    applyFinalizationResource,
    resolveSessionErrorMessage,
  ]);

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
    <div className="aggregate-page">
      <div className="page-intro">
        <h1 className="page-title">{t('pages.aggregate.title')}</h1>
        {!showProgress && <p>{t('pages.aggregate.description')}</p>}
      </div>

      {showProgress && (
        <section className="aggregate-progress" aria-labelledby="aggregate-progress-title">
          <div className="aggregate-section-heading">
            <h2 id="aggregate-progress-title">{progressTitle}</h2>
            <p>{progressDescription}</p>
          </div>
          <ProgressDisplay
            status={progressStatus}
            startedAt={startedAt}
            {...omitUndefinedProperties({
              estimatedDurationMs: queueInfo.estimatedDurationMs,
              concurrencyLimit: queueInfo.concurrencyLimit,
            })}
          />
        </section>
      )}

      {!showProgress && (
        <div className="aggregate-controls">
          <section aria-labelledby="aggregate-scenarios-title">
            <div className="aggregate-section-heading">
              <h2 id="aggregate-scenarios-title">{t('pages.aggregate.scenarios.cardTitle')}</h2>
              <p>{t('pages.aggregate.scenarios.description')}</p>
            </div>
            <TamperScenarioSelector value={selectedScenario} onChange={handleScenarioChange} disabled={isProcessing} />
          </section>

          {requireFinalizeTurnstile && (
            <div className="aggregate-captcha">
              <TurnstileWidget action="finalize" onTokenChange={setTurnstileToken} disabled={isProcessing} />
            </div>
          )}

          {error && (
            <p className="aggregate-error" role="alert">
              {error}
            </p>
          )}

          <div className="aggregate-actions">
            <FinalizeButton
              onClick={() => {
                void handleFinalize();
              }}
              disabled={!selectedScenario || (requireFinalizeTurnstile && !turnstileToken) || isProcessing}
              loading={phase === 'submitting'}
              className="aggregate-start"
            />
          </div>
        </div>
      )}
    </div>
  );
}

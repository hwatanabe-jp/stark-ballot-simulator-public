'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@stark-ballot/web/components/ui/Card';
import { Badge } from '@stark-ballot/web/components/ui/Badge';
import {
  FinalizeButton,
  ProgressDisplay,
  TamperScenarioSelector,
  type ScenarioId,
} from '@stark-ballot/web/components/aggregate';
import { useTranslation } from '@stark-ballot/web/hooks';
import {
  captureSessionIdentity,
  clearSession,
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
import { clearClientFinalizedProjection } from '@stark-ballot/web/finalize/client-finalization-boundary';
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
      mergeKnowledgeFromApi(
        'result',
        projectClientFinalizationSnapshotForKnowledge(finalizationResult),
        knowledgeOptions(expectedSessionId, VERIFICATION_GATED_KEYS),
      );
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
    clearSession();
    setQueueInfo({});
    setQueuedAt(null);
    setStartedAt(null);
    setError(resolveSessionErrorMessage());
    setPhase('failed');
  }, [resolveSessionErrorMessage]);

  const handleTerminalFailure = useCallback(
    (resource: Extract<FinalizationResource, { status: 'failed' | 'timeout' }>): void => {
      clearClientFinalizedProjection(expectedSessionIdentityRef.current);
      setQueueInfo({});
      setQueuedAt(null);
      setStartedAt(null);
      setPhase('failed');

      if (resource.status === 'failed') {
        setError(resource.error.message || t('errors.generic'));
        return;
      }
      setError(t('pages.aggregate.errors.timeout'));
    },
    [t],
  );

  const handleSucceededResource = useCallback(
    (resource: Extract<FinalizationResource, { status: 'succeeded' }>, context: string): void => {
      const canonicalFinalizationResult = projectFinalizationResourceToClientSnapshot(resource);
      if (!canonicalFinalizationResult) {
        clearClientFinalizedProjection(expectedSessionIdentityRef.current);
        handleMissingFinalizeResult(context);
        return;
      }
      scheduleResultNavigation(canonicalFinalizationResult);
    },
    [handleMissingFinalizeResult, scheduleResultNavigation],
  );

  const applyFinalizationResource = useCallback(
    (resource: FinalizationResource): void => {
      const queue = resource.runtimeDiagnostics.queue;
      switch (resource.status) {
        case 'pending':
          setPhase('queued');
          setQueuedAt(resource.queuedAtMs);
          setStartedAt(null);
          setQueueInfo(queue ? toQueueInfo(queue) : {});
          setError(null);
          saveSessionDataForIdentity(expectedSessionIdentityRef.current, { phase: 'finalizing' });
          return;
        case 'running':
          setPhase('running');
          setQueuedAt(resource.queuedAtMs);
          setStartedAt(resource.startedAtMs);
          setQueueInfo(queue ? toQueueInfo(queue) : {});
          setError(null);
          saveSessionDataForIdentity(expectedSessionIdentityRef.current, { phase: 'finalizing' });
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
    [handleSucceededResource, handleTerminalFailure],
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
      saveKnowledgeData({ scenarioId }, knowledgeOptions(expectedSessionId));
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

    setPhase('submitting');
    setError(null);

    try {
      // scenarioId is stored for API continuity (hidden in Knowledge Panel)

      const scenarioId = selectedScenario;
      let result;
      try {
        result = await startFinalization(sessionData, {
          scenarioId,
          ...(turnstileToken ? { turnstileToken } : {}),
        });
      } catch (requestError) {
        const errorCode = resolveApiClientErrorCode(requestError);
        if (errorCode === 'CAPTCHA_FAILED') {
          setError(t('errors.captchaFailed'));
          setTurnstileToken(null);
          setPhase('idle');
          return;
        }
        throw requestError;
      }

      applyFinalizationResource(result.data);
    } catch (err) {
      console.error('[AggregatePage] Finalize error:', err);
      setError(err instanceof Error ? err.message : t('errors.generic'));
      setPhase('failed');
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
              {...omitUndefinedProperties({
                estimatedDurationMs: queueInfo.estimatedDurationMs,
                concurrencyLimit: queueInfo.concurrencyLimit,
              })}
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

          {requireFinalizeTurnstile && (
            <div className="mb-6 flex justify-center">
              <TurnstileWidget action="finalize" onTokenChange={setTurnstileToken} disabled={isProcessing} />
            </div>
          )}

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
            disabled={!selectedScenario || (requireFinalizeTurnstile && !turnstileToken) || isProcessing}
            loading={phase === 'submitting'}
            className="py-4 text-lg"
          />
        </>
      )}
    </div>
  );
}

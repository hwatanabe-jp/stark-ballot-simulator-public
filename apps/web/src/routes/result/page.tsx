'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@stark-ballot/web/components/ui/Button';
import '@stark-ballot/web/components/aggregate/AggregationViews.css';
import { useTranslation } from '@stark-ballot/web/hooks';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import type { SessionIdentity } from '@stark-ballot/web/session';
import {
  captureSessionIdentity,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  saveSessionDataForIdentity,
  SESSION_STORAGE_KEY,
} from '@stark-ballot/web/session';
import { fetchCurrentFinalization, resolveFinalizationStatusErrorCode } from '@stark-ballot/web/api/finalizations';
import type { FinalizationResource } from '@stark-ballot/api-contract/schemas/finalizations';
import { runVerification } from '@stark-ballot/web/api/verification';
import {
  clearKnowledge,
  getKnowledgeValue,
  mergeKnowledgeFromApi,
  saveKnowledgeData,
  VERIFICATION_GATED_KEYS,
  type KnowledgeData,
} from '@stark-ballot/web/knowledge';
import { clearSession } from '@stark-ballot/web/session';
import {
  clearClientSessionAuthority,
  clearClientFinalizedProjection,
} from '@stark-ballot/web/finalize/client-finalization-boundary';
import {
  projectFinalizationResourceToClientSnapshot,
  type ClientFinalizationSnapshot,
  projectClientFinalizationSnapshotForKnowledge,
  resolveCanonicalFinalizationPayload,
  resolveClientFinalizationVerificationStatus,
} from '@stark-ballot/web/finalize/client-finalization-result';
import { startStarkVerificationPolling } from '@stark-ballot/web/verification/stark-verification-polling';
import { isCapabilityLossErrorCode } from '@stark-ballot/api-contract/errors/apiErrorGuards';
import type { VoteChoice, SessionData } from '@stark-ballot/web/session/types';
import { VOTE_CHOICES } from '@stark-ballot/verification/shared/constants';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

type TallyCounts = Record<VoteChoice, number>;

function saveResultCountKnowledge(
  finalizeResult: ClientFinalizationSnapshot,
  expectedSessionIdentity: SessionIdentity | null,
): void {
  // Save additional knowledge data from result
  const knowledgeUpdates: KnowledgeData = {
    missingSlots: finalizeResult.missingSlots,
    invalidPresentedSlots: finalizeResult.invalidPresentedSlots,
    rejectedRecords: finalizeResult.rejectedRecords,
    validVotes: finalizeResult.journal.validVotes,
    excludedSlots: finalizeResult.excludedSlots,
    totalExpected: finalizeResult.totalExpected,
  };

  // Set initial proof bundle status only if not already downloaded
  const currentBundleStatus = getKnowledgeValue('proofBundleStatus');
  if (!currentBundleStatus) {
    knowledgeUpdates['proofBundleStatus'] = 'not_downloaded';
  }

  if (Object.keys(knowledgeUpdates).length > 0) {
    saveKnowledgeData(knowledgeUpdates, {
      ...omitUndefinedProperties({ expectedSessionId: expectedSessionIdentity?.sessionId }),
    });
  }
}

function startResultVerification(
  sessionData: SessionData,
  finalizationSnapshot: ClientFinalizationSnapshot,
  expectedSessionIdentity: SessionIdentity | null,
): void {
  const sessionId = sessionData.sessionId;
  const verificationStatus = resolveClientFinalizationVerificationStatus(finalizationSnapshot);
  const shouldTriggerVerification = !verificationStatus || verificationStatus === 'not_run';
  const shouldStartPolling = shouldTriggerVerification || verificationStatus === 'running';

  if (sessionId) {
    saveSessionDataForIdentity(expectedSessionIdentity, { verificationRequestedAt: Date.now() });
    if (shouldTriggerVerification) {
      void runVerification(sessionData, finalizationSnapshot.finalizationId).catch((err) => {
        console.warn('[ResultPage] Failed to start STARK verification', err);
      });
    }
    if (shouldStartPolling) {
      startStarkVerificationPolling({
        sessionId,
        finalizationId: finalizationSnapshot.finalizationId,
      });
    }
  }
}

type ResultRestoration = { kind: 'handled' } | { kind: 'restored'; snapshot: ClientFinalizationSnapshot | null };

export default function ResultPage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useAppRouter();
  const [expectedSessionIdentity] = useState(() => captureSessionIdentity(getSessionData()));
  const [tallyCounts, setTallyCounts] = useState<TallyCounts | null>(null);
  const [totalVotes, setTotalVotes] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isNavigating, setIsNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getExpectedSession = useCallback(
    () => getSessionDataForIdentity(expectedSessionIdentity),
    [expectedSessionIdentity],
  );

  const resolveSessionErrorMessage = useCallback(
    (): string =>
      isSessionReplacedForIdentity(expectedSessionIdentity)
        ? t('pages.result.errors.sessionReplaced')
        : t('pages.result.errors.sessionNotFound'),
    [expectedSessionIdentity, t],
  );

  const handleMissingSession = useCallback((): void => {
    clearClientSessionAuthority(expectedSessionIdentity);
    setError(resolveSessionErrorMessage());
    setIsLoading(false);
  }, [expectedSessionIdentity, resolveSessionErrorMessage]);

  const handleTerminalResource = useCallback(
    (resource: Extract<FinalizationResource, { status: 'failed' | 'timeout' }>): void => {
      clearClientFinalizedProjection(expectedSessionIdentity);
      if (resource.status === 'failed') {
        setError(resource.error.message || t('errors.generic'));
      } else {
        setError(t('errors.generic'));
      }
      setIsLoading(false);
    },
    [expectedSessionIdentity, t],
  );

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY) {
        return;
      }
      if (!isSessionReplacedForIdentity(expectedSessionIdentity)) {
        return;
      }
      setError(t('pages.result.errors.sessionReplaced'));
      setIsLoading(false);
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [expectedSessionIdentity, t]);

  useEffect(() => {
    const controller = new AbortController();
    const canApplyResponse = (): boolean => {
      if (controller.signal.aborted) return false;
      if (getExpectedSession()) return true;
      setError(resolveSessionErrorMessage());
      setIsLoading(false);
      return false;
    };

    const admitRestoredResource = (resource: FinalizationResource | null): ResultRestoration => {
      let finalizeResult: ClientFinalizationSnapshot | null = null;
      if (resource?.status === 'failed' || resource?.status === 'timeout') {
        handleTerminalResource(resource);
        return { kind: 'handled' };
      }
      if (resource?.status === 'succeeded') {
        finalizeResult = projectFinalizationResourceToClientSnapshot(resource);
        if (!finalizeResult) {
          clearClientFinalizedProjection(expectedSessionIdentity);
        }
      } else if (resource) {
        clearClientFinalizedProjection(expectedSessionIdentity);
      }
      return { kind: 'restored', snapshot: finalizeResult };
    };
    const handleRestorationError = (err: unknown): boolean => {
      if (!canApplyResponse()) return true;
      const errorCode = resolveFinalizationStatusErrorCode(err);
      if (errorCode === 'SESSION_NOT_FOUND') {
        handleMissingSession();
        return true;
      }
      if (isCapabilityLossErrorCode(errorCode)) {
        clearClientSessionAuthority(expectedSessionIdentity);
        setError(resolveSessionErrorMessage());
        setIsLoading(false);
        return true;
      }
      console.error('[ResultPage] Failed to restore finalization result:', err);
      return false;
    };
    const publishRestoredSnapshot = (finalizeResult: ClientFinalizationSnapshot | null): void => {
      if (!finalizeResult) {
        setError(t('pages.result.errors.noResult'));
        setIsLoading(false);
        return;
      }

      saveSessionDataForIdentity(expectedSessionIdentity, { finalizeResult, phase: 'verifying' });

      mergeKnowledgeFromApi(projectClientFinalizationSnapshotForKnowledge(finalizeResult), {
        omitKeys: VERIFICATION_GATED_KEYS,
        ...omitUndefinedProperties({ expectedSessionId: expectedSessionIdentity?.sessionId }),
      });

      setTallyCounts({ ...finalizeResult.tally.counts });
      setTotalVotes(finalizeResult.tally.totalVotes);

      saveResultCountKnowledge(finalizeResult, expectedSessionIdentity);

      setIsLoading(false);
    };
    const restoreFinalizationResult = async (session: SessionData): Promise<void> => {
      let restored: ResultRestoration;
      try {
        const resource = await fetchCurrentFinalization(session, { signal: controller.signal });
        if (!canApplyResponse()) return;
        restored = admitRestoredResource(resource);
      } catch (error) {
        if (handleRestorationError(error)) return;
        restored = { kind: 'restored', snapshot: null };
      }
      if (restored.kind === 'handled') return;
      publishRestoredSnapshot(restored.snapshot);
    };

    const loadResult = async () => {
      try {
        const sessionData = getExpectedSession();
        if (!sessionData?.sessionId) {
          setError(resolveSessionErrorMessage());
          setIsLoading(false);
          return;
        }

        await restoreFinalizationResult(sessionData);
      } catch (err) {
        if (!canApplyResponse()) return;
        console.error('[ResultPage] Error loading result:', err);
        setError(t('errors.generic'));
        setIsLoading(false);
      }
    };

    void loadResult();
    return () => controller.abort();
  }, [
    expectedSessionIdentity,
    getExpectedSession,
    handleMissingSession,
    handleTerminalResource,
    resolveSessionErrorMessage,
    t,
  ]);

  const handleVerify = () => {
    if (isNavigating) return;
    setIsNavigating(true);
    const sessionData = getExpectedSession();
    if (!sessionData?.sessionId) {
      setError(resolveSessionErrorMessage());
      setIsNavigating(false);
      return;
    }
    const finalizationSnapshot = resolveCanonicalFinalizationPayload(sessionData.finalizeResult);
    if (!finalizationSnapshot) {
      setError(t('pages.result.errors.noResult'));
      setIsNavigating(false);
      return;
    }
    startResultVerification(sessionData, finalizationSnapshot, expectedSessionIdentity);

    router.push('/verify');
  };

  const handleReset = () => {
    clearSession();
    clearKnowledge();
    router.push('/');
  };

  return (
    <ResultView
      t={t}
      tallyCounts={tallyCounts}
      totalVotes={totalVotes}
      isLoading={isLoading}
      isNavigating={isNavigating}
      error={error}
      handleReset={handleReset}
      handleVerify={handleVerify}
    />
  );
}

interface ResultViewProps {
  t: UseTranslationResult['t'];
  tallyCounts: TallyCounts | null;
  totalVotes: number;
  isLoading: boolean;
  isNavigating: boolean;
  error: string | null;
  handleReset: () => void;
  handleVerify: () => void;
}

function ResultView({
  t,
  tallyCounts,
  totalVotes,
  isLoading,
  isNavigating,
  error,
  handleReset,
  handleVerify,
}: ResultViewProps): React.ReactElement {
  // Calculate max count for bar scaling
  const maxCount = tallyCounts ? Math.max(...Object.values(tallyCounts), 1) : 1;

  if (isLoading) {
    return (
      <div className="result-loading" role="status">
        {t('pages.result.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="result-error">
        <p role="alert">{error}</p>
        <Button variant="secondary" onClick={handleReset}>
          {t('actions.reset')}
        </Button>
      </div>
    );
  }

  return (
    <div className="result-page">
      <div className="page-intro">
        <h1 className="page-title">{t('pages.result.title')}</h1>
        <p>{t('pages.result.description')}</p>
      </div>

      <section className="result-tally" aria-labelledby="result-tally-title">
        <div className="result-section-heading">
          <h2 id="result-tally-title">{t('pages.result.tally.title')}</h2>
          <p data-testid="total-votes">{t('pages.result.tally.totalVotes', { total: totalVotes })}</p>
        </div>
        <dl className="result-tally-list">
          {VOTE_CHOICES.map((choice) => {
            const count = tallyCounts?.[choice] ?? 0;
            const barWidth = (count / maxCount) * 100;
            return (
              <div key={choice} className="result-tally-row">
                <dt className="result-tally-choice">{choice}</dt>
                <dd className="result-tally-value">
                  <span className="result-tally-count" data-testid={`tally-value-${choice}`}>
                    {count}
                  </span>
                  <div className="result-tally-track" aria-hidden="true">
                    <div className="result-tally-bar" style={{ width: `${barWidth}%` }} />
                  </div>
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <div className="result-actions">
        <p className="result-notice">
          <span aria-hidden="true">ⓘ</span>
          <span>{t('pages.result.noticeNotVerified')}</span>
        </p>
        <Button
          variant="verify"
          onClick={handleVerify}
          disabled={isNavigating}
          className="result-verify"
          data-testid="start-verification"
        >
          {t('pages.result.startVerification')}
        </Button>
      </div>
    </div>
  );
}

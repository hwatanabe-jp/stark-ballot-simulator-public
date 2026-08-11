'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@stark-ballot/web/components/ui/Card';
import { Badge } from '@stark-ballot/web/components/ui/Badge';
import { useTranslation } from '@stark-ballot/web/hooks';
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
} from '@stark-ballot/web/knowledge';
import { clearSession } from '@stark-ballot/web/session';
import {
  clearClientSessionAuthority,
  clearClientFinalizedProjection,
} from '@stark-ballot/web/finalize/client-finalization-boundary';
import {
  projectFinalizationResourceToClientSnapshot,
  projectClientFinalizationSnapshotForKnowledge,
  resolveCanonicalFinalizationPayload,
  resolveClientFinalizationVerificationStatus,
} from '@stark-ballot/web/finalize/client-finalization-result';
import { startStarkVerificationPolling } from '@stark-ballot/web/verification/stark-verification-polling';
import { isCapabilityLossErrorCode } from '@stark-ballot/api-contract/errors/apiErrorGuards';
import type { VoteChoice } from '@stark-ballot/web/session/types';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const VOTE_CHOICES: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];

interface TallyCounts {
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
}

export default function ResultPage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useAppRouter();
  const expectedSessionIdentityRef = useRef(captureSessionIdentity(getSessionData()));
  const [tallyCounts, setTallyCounts] = useState<TallyCounts | null>(null);
  const [totalVotes, setTotalVotes] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isNavigating, setIsNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getExpectedSession = useCallback(
    () => getSessionDataForIdentity(expectedSessionIdentityRef.current),
    [expectedSessionIdentityRef],
  );

  const resolveSessionErrorMessage = useCallback(
    (): string =>
      isSessionReplacedForIdentity(expectedSessionIdentityRef.current)
        ? t('pages.result.errors.sessionReplaced')
        : t('pages.result.errors.sessionNotFound'),
    [t],
  );

  const handleMissingSession = useCallback((): void => {
    clearSession();
    setError(resolveSessionErrorMessage());
    setIsLoading(false);
  }, [resolveSessionErrorMessage]);

  const handleTerminalResource = useCallback(
    (resource: Extract<FinalizationResource, { status: 'failed' | 'timeout' }>): void => {
      clearClientFinalizedProjection(expectedSessionIdentityRef.current);
      if (resource.status === 'failed') {
        setError(resource.error.message || t('errors.generic'));
      } else {
        setError(t('errors.generic'));
      }
      setIsLoading(false);
    },
    [t],
  );

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY) {
        return;
      }
      if (!isSessionReplacedForIdentity(expectedSessionIdentityRef.current)) {
        return;
      }
      setError(t('pages.result.errors.sessionReplaced'));
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [t]);

  useEffect(() => {
    const loadResult = async () => {
      try {
        const sessionData = getExpectedSession();
        if (!sessionData?.sessionId) {
          setError(resolveSessionErrorMessage());
          setIsLoading(false);
          return;
        }

        let finalizeResult = null;
        try {
          const resource = await fetchCurrentFinalization(sessionData);
          if (resource?.status === 'failed' || resource?.status === 'timeout') {
            handleTerminalResource(resource);
            return;
          }
          if (resource?.status === 'succeeded') {
            finalizeResult = projectFinalizationResourceToClientSnapshot(resource);
            if (!finalizeResult) {
              clearClientFinalizedProjection(expectedSessionIdentityRef.current);
            }
          } else if (resource) {
            clearClientFinalizedProjection(expectedSessionIdentityRef.current);
          }
        } catch (err) {
          const errorCode = resolveFinalizationStatusErrorCode(err);
          if (errorCode === 'SESSION_NOT_FOUND') {
            handleMissingSession();
            return;
          }
          if (isCapabilityLossErrorCode(errorCode)) {
            clearClientSessionAuthority(expectedSessionIdentityRef.current);
            setError(resolveSessionErrorMessage());
            setIsLoading(false);
            return;
          }
          console.error('[ResultPage] Failed to restore finalization result:', err);
        }

        if (!finalizeResult) {
          setError(t('pages.result.errors.noResult'));
          setIsLoading(false);
          return;
        }

        saveSessionDataForIdentity(expectedSessionIdentityRef.current, { finalizeResult, phase: 'verifying' });

        mergeKnowledgeFromApi('result', projectClientFinalizationSnapshotForKnowledge(finalizeResult), {
          omitKeys: VERIFICATION_GATED_KEYS,
          ...omitUndefinedProperties({ expectedSessionId: expectedSessionIdentityRef.current?.sessionId }),
        });

        setTallyCounts({ ...finalizeResult.tally.counts });
        setTotalVotes(finalizeResult.tally.totalVotes);

        // Save additional knowledge data from result
        const knowledgeUpdates: Record<string, unknown> = {
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
            ...omitUndefinedProperties({ expectedSessionId: expectedSessionIdentityRef.current?.sessionId }),
          });
        }

        setIsLoading(false);
      } catch (err) {
        console.error('[ResultPage] Error loading result:', err);
        setError(t('errors.generic'));
        setIsLoading(false);
      }
    };

    void loadResult();
  }, [getExpectedSession, handleMissingSession, handleTerminalResource, resolveSessionErrorMessage, t]);

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
    const sessionId = sessionData.sessionId;
    const verificationStatus = resolveClientFinalizationVerificationStatus(finalizationSnapshot);
    const shouldTriggerVerification = !verificationStatus || verificationStatus === 'not_run';
    const shouldStartPolling = shouldTriggerVerification || verificationStatus === 'running';

    if (sessionId) {
      saveSessionDataForIdentity(expectedSessionIdentityRef.current, { verificationRequestedAt: Date.now() });
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

    router.push('/verify');
  };

  const handleReset = () => {
    clearSession();
    clearKnowledge();
    router.push('/');
  };

  // Calculate max count for bar scaling
  const maxCount = tallyCounts ? Math.max(...(Object.values(tallyCounts) as number[]), 1) : 1;

  // Loading state
  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="animate-pulse text-text-secondary font-secondary">{t('pages.result.loading')}</div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
        <Card className="border-vermillion-200 bg-vermillion-50/30">
          <CardContent className="py-8 text-center">
            <Badge variant="error" size="large" className="mb-4">
              {error}
            </Badge>
            <div className="mt-6">
              <Button variant="secondary" onClick={handleReset}>
                {t('actions.reset')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="font-display text-[var(--text-display)] font-bold text-ink-900 mb-3 tracking-[var(--tracking-display)] leading-[var(--leading-display)]">
          {t('pages.result.title')}
        </h1>
        <p className="font-secondary text-text-secondary leading-relaxed">{t('pages.result.description')}</p>
      </div>

      {/* Result Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="font-primary text-xl text-ink-800">{t('pages.result.tally.title')}</CardTitle>
          <CardDescription data-testid="total-votes">
            {t('pages.result.tally.totalVotes', { total: totalVotes })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Compact Tally Grid - A→E fixed order */}
          <div className="flex justify-center gap-2 sm:gap-3 lg:gap-4">
            {VOTE_CHOICES.map((choice, index) => {
              const count = tallyCounts?.[choice] ?? 0;
              const barWidth = (count / maxCount) * 100;

              return (
                <div
                  key={choice}
                  className="flex-1 min-w-[56px] max-w-[100px] flex flex-col items-center py-3 px-2 rounded-lg border transition-all duration-500 animate-slide-in-up bg-paper-cream border-ink-200"
                  style={{ animationDelay: `${index * 80}ms` }}
                >
                  {/* Choice Label */}
                  <span className="font-secondary text-sm font-medium mb-1 text-ink-600">{choice}</span>

                  {/* Vote Count */}
                  <span
                    className="font-mono font-semibold leading-tight text-lg text-ink-700"
                    data-testid={`tally-value-${choice}`}
                  >
                    {count}
                  </span>

                  {/* Proportional Ink Underline */}
                  <div className="w-full h-0.5 mt-2 bg-ink-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-700 ease-out bg-ink-400"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Verification Status Notice - Compact */}
      <div className="mb-6 flex items-center justify-center gap-2 text-text-secondary">
        <span className="text-ink-500 text-base">ⓘ</span>
        <p className="font-secondary text-sm">{t('pages.result.noticeNotVerified')}</p>
      </div>

      {/* Action Button */}
      <div className="flex justify-center">
        <Button
          variant="verify"
          onClick={handleVerify}
          disabled={isNavigating}
          className="px-8 py-4 text-lg"
          data-testid="start-verification"
        >
          {t('pages.result.startVerification')}
        </Button>
      </div>
    </div>
  );
}

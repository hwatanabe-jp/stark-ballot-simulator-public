'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useTranslation } from '@/lib/hooks';
import { apiFetch } from '@/lib/api/apiFetch';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import {
  captureSessionIdentity,
  getSessionAuthHeaders,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  saveSessionDataForIdentity,
  SESSION_STORAGE_KEY,
} from '@/lib/session';
import {
  fetchFinalizationStatus,
  resolveFinalizationStatusErrorCode,
  type FinalizationStatusResponse,
} from '@/lib/finalize/finalization-status-client';
import {
  clearKnowledge,
  getKnowledgeValue,
  mergeKnowledgeFromApi,
  saveKnowledgeData,
  VERIFICATION_GATED_KEYS,
} from '@/lib/knowledge';
import { clearSessionData } from '@/lib/session';
import {
  clearClientSessionAuthority,
  clearClientFinalizedProjection,
  hasFailClosedFinalizationStatus,
} from '@/lib/finalize/client-finalization-boundary';
import {
  projectClientFinalizationSnapshotForKnowledge,
  resolveCanonicalFinalizationPayload,
  resolveClientFinalizationVerificationStatus,
} from '@/lib/finalize/client-finalization-result';
import { startStarkVerificationPolling } from '@/lib/verification/stark-verification-polling';
import { isCapabilityLossErrorCode } from '@/lib/errors/apiErrorGuards';
import { getRecordProperty, getNumberProperty, isRecord } from '@/lib/utils/guards';
import type { VoteChoice } from '@/lib/session/types';

const VOTE_CHOICES: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];

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

interface TallyCounts {
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
}

export default function ResultPage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
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
    clearSessionData();
    setError(resolveSessionErrorMessage());
    setIsLoading(false);
  }, [resolveSessionErrorMessage]);

  const handleFailClosedStatus = useCallback(
    (status: FinalizationStatusResponse): void => {
      clearClientFinalizedProjection(expectedSessionIdentityRef.current);
      const state = status.finalizationState;
      if (state?.status === 'failed') {
        setError(state.error.message || t('errors.generic'));
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
          const status = await fetchFinalizationStatus(sessionData.sessionId, {
            authHeaders: getSessionAuthHeaders(sessionData),
          });
          if (hasFailClosedFinalizationStatus(status)) {
            handleFailClosedStatus(status);
            return;
          }

          const restoredFinalizeResult = resolveCanonicalFinalizationPayload(status.finalizationResult);
          if (isFinalizationResultReady(status) && restoredFinalizeResult) {
            finalizeResult = restoredFinalizeResult;
          } else if (status.finalizationResult) {
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
          expectedSessionId: expectedSessionIdentityRef.current?.sessionId,
        });

        // Extract tally data
        const tally = getRecordProperty(finalizeResult, 'tally');
        const counts = tally ? getRecordProperty(tally, 'counts') : null;

        if (counts && isRecord(counts)) {
          const tallyData: TallyCounts = {
            A: getNumberProperty(counts, 'A') ?? 0,
            B: getNumberProperty(counts, 'B') ?? 0,
            C: getNumberProperty(counts, 'C') ?? 0,
            D: getNumberProperty(counts, 'D') ?? 0,
            E: getNumberProperty(counts, 'E') ?? 0,
          };
          setTallyCounts(tallyData);
        }

        // Extract other result data
        const total = tally
          ? getNumberProperty(tally, 'totalVotes')
          : getNumberProperty(finalizeResult, 'totalExpected');
        if (total !== undefined) {
          setTotalVotes(total);
        }

        // Save additional knowledge data from result
        const knowledgeUpdates: Record<string, unknown> = {};
        const journal = getRecordProperty(finalizeResult, 'journal');

        const missingSlots =
          getNumberProperty(finalizeResult, 'missingSlots') ??
          (journal ? getNumberProperty(journal, 'missingSlots') : undefined);
        if (missingSlots !== undefined) knowledgeUpdates.missingSlots = missingSlots;

        const invalidPresentedSlots =
          getNumberProperty(finalizeResult, 'invalidPresentedSlots') ??
          (journal ? getNumberProperty(journal, 'invalidPresentedSlots') : undefined);
        if (invalidPresentedSlots !== undefined) knowledgeUpdates.invalidPresentedSlots = invalidPresentedSlots;

        const rejectedRecords =
          getNumberProperty(finalizeResult, 'rejectedRecords') ??
          (journal ? getNumberProperty(journal, 'rejectedRecords') : undefined);
        if (rejectedRecords !== undefined) knowledgeUpdates['rejectedRecords'] = rejectedRecords;

        const validVotes =
          getNumberProperty(finalizeResult, 'validVotes') ??
          (journal ? getNumberProperty(journal, 'validVotes') : undefined);
        if (validVotes !== undefined) knowledgeUpdates.validVotes = validVotes;

        const excludedSlots =
          getNumberProperty(finalizeResult, 'excludedSlots') ??
          (journal ? getNumberProperty(journal, 'excludedSlots') : undefined);
        if (excludedSlots !== undefined) knowledgeUpdates.excludedSlots = excludedSlots;

        const totalExpected =
          getNumberProperty(finalizeResult, 'totalExpected') ??
          (journal ? getNumberProperty(journal, 'totalExpected') : undefined);
        if (totalExpected !== undefined) knowledgeUpdates['totalExpected'] = totalExpected;

        // Set initial proof bundle status only if not already downloaded
        const currentBundleStatus = getKnowledgeValue('proofBundleStatus');
        if (!currentBundleStatus) {
          knowledgeUpdates['proofBundleStatus'] = 'not_downloaded';
        }

        if (Object.keys(knowledgeUpdates).length > 0) {
          saveKnowledgeData(knowledgeUpdates, {
            expectedSessionId: expectedSessionIdentityRef.current?.sessionId,
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
  }, [getExpectedSession, handleFailClosedStatus, handleMissingSession, resolveSessionErrorMessage, t]);

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
        void apiFetch(resolveApiUrl('/api/verification/run'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getSessionAuthHeaders(sessionData),
          },
          body: JSON.stringify({}),
        })
          .then((response) => {
            if (!response.ok) {
              console.warn('[ResultPage] Failed to start STARK verification', response.statusText);
            }
          })
          .catch((err) => {
            console.warn('[ResultPage] Failed to start STARK verification', err);
          });
      }
      if (shouldStartPolling) {
        startStarkVerificationPolling({ sessionId });
      }
    }

    router.push('/verify');
  };

  const handleReset = () => {
    clearSessionData();
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

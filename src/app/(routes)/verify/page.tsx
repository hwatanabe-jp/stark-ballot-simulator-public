'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/lib/hooks';
import {
  captureSessionIdentity,
  getSessionAuthHeaders,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  isSessionReplaced,
  SESSION_STORAGE_KEY,
  updateLastActivityForIdentity,
  SESSION_HEARTBEAT_INTERVAL_MS,
} from '@/lib/session';
import { setProofBundleStatus } from '@/lib/knowledge';
import { useKnowledgeHighlight } from '@/components/knowledge';
import { UnifiedVerificationCard } from '@/components/verification/UnifiedVerificationCard';
import { InlineAlert } from '@/components/ui/InlineAlert';
import { Button } from '@/components/ui/Button';
import { apiFetch } from '@/lib/api/apiFetch';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { resolveConfiguredSthSources } from '@/lib/verification/sth-verifier';
import { detectTampering } from '@/lib/verification/tamperDetection';
import type { TamperDetectionResult } from '@/lib/verification/types';
import type { VerificationCheckId } from '@/lib/verification/verification-checks';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import {
  deriveVerificationSummary,
  type VerificationSummaryContext,
  type VerificationSummaryStatus,
  type VerificationSummaryTone,
} from '@/lib/verification/verification-summary';
import {
  isVerificationClientInvalidationError,
  readResponseJsonSafely,
  resolveVerificationClientApiError,
} from '@/lib/verification/client-api-errors';
import { useVerificationData } from './hooks/useVerificationData';
import { useVerificationSequence } from './hooks/useVerificationSequence';
import {
  buildBundleCandidates,
  buildDetectionReceipt,
  buildDetectionVote,
  resolveStarkStatus,
} from './lib/verification-data';
import { downloadBundle } from './lib/download';
import { resolveHighlightedKnowledge } from './lib/verification-highlights';
import { isStarkTimeoutError } from './lib/stark-timeout';

type OverallStatusOverride = {
  status: 'verified' | 'failed' | 'warning';
  message: string;
  subMessage?: string;
};

const HARD_FAILURE_CHECKS: VerificationCheckId[] = [
  'recorded_consistency_proof',
  'counted_missing_indices_zero',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'stark_receipt_verify',
];

const SUMMARY_MAIN_MESSAGE_KEYS: Record<VerificationSummaryStatus, string> = {
  fully_verified: 'pages.verify.resultSummary.fullyVerifiedMain',
  in_progress: 'pages.verify.resultSummary.inProgressMain',
  missing_evidence: 'pages.verify.resultSummary.missingEvidenceMain',
  verified_with_limitations: 'pages.verify.resultSummary.verifiedWithLimitationsMain',
  user_vote_excluded: 'pages.verify.resultSummary.userVoteExcludedMain',
  votes_excluded: 'pages.verify.resultSummary.votesExcludedMain',
  votes_excluded_unknown: 'pages.verify.resultSummary.votesExcludedUnknownMain',
  recorded_integrity_failed: 'pages.verify.resultSummary.recordedIntegrityFailedMain',
  published_tally_mismatch: 'pages.verify.resultSummary.publishedTallyMismatchMain',
  counted_integrity_failed: 'pages.verify.resultSummary.countedIntegrityFailedMain',
  cast_integrity_failed: 'pages.verify.resultSummary.castIntegrityFailedMain',
  proof_verification_failed: 'pages.verify.resultSummary.proofVerificationFailedMain',
};

const SUMMARY_SUB_MESSAGE_KEYS: Partial<Record<VerificationSummaryStatus, string>> = {
  fully_verified: 'pages.verify.resultSummary.fullyVerifiedSub',
  in_progress: 'pages.verify.resultSummary.inProgressSub',
  user_vote_excluded: 'pages.verify.resultSummary.userVoteExcludedSub',
  votes_excluded: 'pages.verify.resultSummary.votesExcludedSub',
  votes_excluded_unknown: 'pages.verify.resultSummary.votesExcludedUnknownSub',
  published_tally_mismatch: 'pages.verify.resultSummary.publishedTallyMismatchSub',
  counted_integrity_failed: 'pages.verify.resultSummary.countedIntegrityFailedSub',
  proof_verification_failed: 'pages.verify.resultSummary.proofVerificationFailedSub',
};

const SUMMARY_TONE_CONFIG: Record<VerificationSummaryTone, { status: 'verified' | 'failed' | 'warning' }> = {
  verified: { status: 'verified' },
  warning: { status: 'warning' },
  failed: { status: 'failed' },
};

export default function VerifyPage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const verificationStartedRef = useRef(false);
  const expectedSessionIdentityRef = useRef(captureSessionIdentity(getSessionData()));
  const [downloadState, setDownloadState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [_tamperResult, setTamperResult] = useState<TamperDetectionResult | null>(null);
  const [tamperError, setTamperError] = useState<string | null>(null);
  void _tamperResult; // Keep state for async effect, value unused after unified card refactor
  const { setHighlightedKeys } = useKnowledgeHighlight();

  const getExpectedSession = useCallback(
    () => getSessionDataForIdentity(expectedSessionIdentityRef.current),
    [expectedSessionIdentityRef],
  );

  const resolveSessionErrorMessage = useCallback(
    (): string =>
      t(
        isSessionReplacedForIdentity(expectedSessionIdentityRef.current) || isSessionReplaced()
          ? 'pages.verify.sessionReplaced'
          : 'pages.verify.sessionError',
      ),
    [t],
  );

  const { data, setData, loading, setLoading, serverValidated, error, setError, fetchVerificationRef, triggerFetch } =
    useVerificationData({
      t,
      sessionIdentityRef: expectedSessionIdentityRef,
    });

  const handleFatalVerificationInvalidation = useCallback(
    (error: unknown): void => {
      if (!isVerificationClientInvalidationError(error)) {
        return;
      }
      setData(null);
      setError(error.message);
    },
    [setData, setError],
  );

  const triggerStarkVerificationRun = useCallback(async () => {
    const session = getExpectedSession();
    if (!session) {
      throw new Error(resolveSessionErrorMessage());
    }

    const response = await apiFetch(resolveApiUrl('/api/verification/run'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getSessionAuthHeaders(session),
      },
      body: JSON.stringify({}),
    });

    const rawBody = await readResponseJsonSafely(response);

    if (!response.ok) {
      const resolvedError = resolveVerificationClientApiError({
        rawBody,
        responseStatus: response.status,
        responseStatusText: response.statusText,
        sessionIdentity: expectedSessionIdentityRef.current,
        resolveSessionErrorMessage,
        fallbackMessage: `Verification run request failed: ${response.status}`,
      });
      handleFatalVerificationInvalidation(resolvedError);
      throw resolvedError;
    }
  }, [getExpectedSession, handleFatalVerificationInvalidation, resolveSessionErrorMessage]);

  const initialFetchRef = useRef(false);
  useEffect(() => {
    if (initialFetchRef.current) {
      return;
    }
    initialFetchRef.current = true;
    triggerFetch();
  }, [triggerFetch]);

  useEffect(() => {
    const setIsolationError = () => {
      setError(resolveSessionErrorMessage());
      setLoading(false);
    };

    if (!getExpectedSession()) {
      setIsolationError();
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY) {
        return;
      }
      if (!isSessionReplacedForIdentity(expectedSessionIdentityRef.current)) {
        return;
      }
      setIsolationError();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [getExpectedSession, resolveSessionErrorMessage, setError, setLoading]);

  const { verificationStarted, visibleStepCount, sequenceComplete, stepStatusMap, startVerification } =
    useVerificationSequence({
      data,
      t,
      fetchVerificationRef,
      triggerStarkVerificationRun,
      onError: (message) => setError(message),
      verificationStartedRef,
      sessionIdentityRef: expectedSessionIdentityRef,
    });

  const actualStarkStatus = resolveStarkStatus(data?.verificationStatus, data?.verificationReport);
  const directAccessBlocked = useMemo(() => {
    if (loading || error || !data) {
      return false;
    }
    if (verificationStarted) {
      return false;
    }
    const session = getExpectedSession();
    const hasContinuationAuthority =
      typeof session?.verificationRequestedAt === 'number' &&
      Boolean(resolveCanonicalFinalizationPayload(session.finalizeResult));
    return !hasContinuationAuthority && actualStarkStatus === 'not_run';
  }, [getExpectedSession, loading, error, data, verificationStarted, actualStarkStatus]);

  useEffect(() => {
    if (loading || error || !data || !serverValidated) {
      return;
    }
    if (verificationStartedRef.current || verificationStarted) {
      return;
    }
    if (directAccessBlocked) {
      return;
    }
    void startVerification();
  }, [loading, error, data, serverValidated, verificationStarted, startVerification, directAccessBlocked]);

  useEffect(() => {
    updateLastActivityForIdentity(expectedSessionIdentityRef.current);
    const interval = window.setInterval(() => {
      updateLastActivityForIdentity(expectedSessionIdentityRef.current);
    }, SESSION_HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  const stepBlueprints = useMemo(
    () => [
      {
        id: 'cast_as_intended' as const,
        title: t('pages.verify.stepsCard.categories.castAsIntended.title'),
        description: t('pages.verify.stepsCard.categories.castAsIntended.description'),
        highlightedKnowledge: resolveHighlightedKnowledge('cast_as_intended', data?.verificationSteps),
      },
      {
        id: 'recorded_as_cast' as const,
        title: t('pages.verify.stepsCard.categories.recordedAsCast.title'),
        description: t('pages.verify.stepsCard.categories.recordedAsCast.description'),
        highlightedKnowledge: resolveHighlightedKnowledge('recorded_as_cast', data?.verificationSteps),
      },
      {
        id: 'counted_as_recorded' as const,
        title: t('pages.verify.stepsCard.categories.countedAsRecorded.title'),
        description: t('pages.verify.stepsCard.categories.countedAsRecorded.description'),
        highlightedKnowledge: resolveHighlightedKnowledge('counted_as_recorded', data?.verificationSteps),
      },
      {
        id: 'stark_verification' as const,
        title: t('pages.verify.stepsCard.categories.starkVerification.title'),
        description: t('pages.verify.stepsCard.categories.starkVerification.description'),
        highlightedKnowledge: resolveHighlightedKnowledge('stark_verification', data?.verificationSteps),
      },
    ],
    [data?.verificationSteps, t],
  );

  useEffect(() => {
    if (!verificationStarted) {
      setHighlightedKeys([]);
      return;
    }

    const runningStepId = Object.entries(stepStatusMap).find(([, state]) => state.status === 'running')?.[0];
    const activeStep =
      stepBlueprints.find((step) => step.id === runningStepId) ??
      stepBlueprints[Math.max(0, Math.min(visibleStepCount - 1, stepBlueprints.length - 1))];
    setHighlightedKeys(activeStep.highlightedKnowledge);
  }, [verificationStarted, stepStatusMap, stepBlueprints, visibleStepCount, setHighlightedKeys]);

  useEffect(() => {
    return () => {
      setHighlightedKeys([]);
    };
  }, [setHighlightedKeys]);

  useEffect(() => {
    const cancelledRef: { current: boolean } = { current: false };

    void (async () => {
      if (!data) {
        setTamperResult(null);
        setTamperError(null);
        return;
      }

      const receipt = buildDetectionReceipt(data);
      const vote = buildDetectionVote(data, getExpectedSession());
      if (!receipt || !vote) {
        setTamperResult(null);
        setTamperError(null);
        return;
      }

      try {
        const result = await detectTampering(receipt, vote, {
          expectedTotalVotes: data.totalExpected,
          scenarios: data.scenarioId ? [data.scenarioId] : undefined,
        });
        if (!cancelledRef.current) {
          setTamperResult(result);
          setTamperError(null);
        }
      } catch (err) {
        if (!cancelledRef.current) {
          const message = err instanceof Error ? err.message : String(err);
          setTamperResult(null);
          setTamperError(message);
        }
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [data, getExpectedSession]);

  const bundleCandidates = useMemo(
    () => buildBundleCandidates(data, getExpectedSession()?.sessionId),
    [data, getExpectedSession],
  );
  const handleDownload = useCallback(async () => {
    const candidate = bundleCandidates.at(0);
    if (!candidate) {
      setDownloadError(t('pages.verify.download.missingBundle'));
      setDownloadState('error');
      return;
    }

    setDownloadError(null);
    setDownloadState('loading');

    try {
      const session = getExpectedSession();
      if (!session) {
        throw new Error(resolveSessionErrorMessage());
      }
      await downloadBundle(candidate, {
        authHeaders: getSessionAuthHeaders(session),
        sessionIdentity: expectedSessionIdentityRef.current,
        resolveSessionErrorMessage,
      });
      setDownloadState('success');
      setProofBundleStatus('downloaded');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      handleFatalVerificationInvalidation(error);
      setDownloadState('error');
      setDownloadError(message);
    }
  }, [bundleCandidates, getExpectedSession, handleFatalVerificationInvalidation, resolveSessionErrorMessage, t]);

  const sthSourcesConfigured = useMemo(() => resolveConfiguredSthSources().length > 0, []);
  const { verificationChecksById, hasCheckPending, hasStarkReceiptCheck } = useMemo(() => {
    const checks = data?.verificationChecks;
    if (!checks || checks.length === 0) {
      return {
        verificationChecksById: null,
        hasCheckPending: false,
        hasStarkReceiptCheck: false,
      };
    }
    const map = new Map<VerificationCheckId, string>();
    let pending = false;
    let hasStarkReceipt = false;
    for (const check of checks) {
      if (!map.has(check.id)) {
        map.set(check.id, check.status);
      }
      if (check.id === 'stark_receipt_verify') {
        hasStarkReceipt = true;
      }
      if (check.status === 'pending' || check.status === 'running') {
        pending = true;
      }
    }
    return {
      verificationChecksById: map,
      hasCheckPending: pending,
      hasStarkReceiptCheck: hasStarkReceipt,
    };
  }, [data?.verificationChecks]);
  const hasVerificationChecks = Boolean(verificationChecksById && verificationChecksById.size > 0);
  const sthThirdPartyStatus = verificationChecksById?.get('recorded_sth_third_party');
  const starkImageIdStatus = verificationChecksById?.get('stark_image_id_match');
  const starkReceiptStatus = verificationChecksById?.get('stark_receipt_verify');
  const starkReportStatus = data?.verificationReport?.status;

  const starkTimeoutDetected = useMemo(
    () => isStarkTimeoutError(stepStatusMap.stark_verification.error),
    [stepStatusMap.stark_verification.error],
  );
  const starkSequenceFailureMessage = useMemo(() => {
    if (stepStatusMap.stark_verification.status !== 'failed') {
      return undefined;
    }
    const message = stepStatusMap.stark_verification.error;
    if (!message || isStarkTimeoutError(message)) {
      return undefined;
    }
    return message;
  }, [stepStatusMap.stark_verification.error, stepStatusMap.stark_verification.status]);
  const explicitProofSuccessSignal = useMemo(
    () =>
      starkReportStatus === 'success' ||
      starkReportStatus === 'dev_mode' ||
      (starkReceiptStatus === 'success' && (starkImageIdStatus === undefined || starkImageIdStatus === 'success')),
    [starkImageIdStatus, starkReceiptStatus, starkReportStatus],
  );
  const explicitProofFailureDetected = useMemo(
    () =>
      starkReportStatus === 'failed' ||
      starkImageIdStatus === 'failed' ||
      starkReceiptStatus === 'failed' ||
      (actualStarkStatus === 'failed' && !explicitProofSuccessSignal),
    [actualStarkStatus, explicitProofSuccessSignal, starkImageIdStatus, starkReceiptStatus, starkReportStatus],
  );
  const explicitProofSuccessDetected = useMemo(() => {
    if (explicitProofFailureDetected) {
      return false;
    }
    if (explicitProofSuccessSignal) {
      return true;
    }
    if (!hasStarkReceiptCheck && (actualStarkStatus === 'success' || actualStarkStatus === 'dev_mode')) {
      return true;
    }
    return false;
  }, [actualStarkStatus, explicitProofFailureDetected, explicitProofSuccessSignal, hasStarkReceiptCheck]);
  const starkGateStatus = useMemo<'success' | 'failed' | 'pending'>(() => {
    if (starkTimeoutDetected) {
      return 'failed';
    }
    if (starkSequenceFailureMessage) {
      return 'failed';
    }
    if (explicitProofFailureDetected) {
      return 'failed';
    }
    if (explicitProofSuccessDetected) {
      return 'success';
    }
    return 'pending';
  }, [explicitProofFailureDetected, explicitProofSuccessDetected, starkSequenceFailureMessage, starkTimeoutDetected]);
  const starkReceiptFailed = hasStarkReceiptCheck ? starkReceiptStatus === 'failed' : actualStarkStatus === 'failed';
  const hardFailureDetected =
    hasVerificationChecks &&
    (HARD_FAILURE_CHECKS.some((checkId) => {
      if (checkId === 'stark_receipt_verify') {
        return starkReceiptFailed;
      }
      return verificationChecksById?.get(checkId) === 'failed';
    }) ||
      (sthSourcesConfigured && sthThirdPartyStatus === 'failed'));

  const summaryContext = useMemo<VerificationSummaryContext>(
    () => ({
      missingSlots: data?.missingSlots,
      invalidPresentedSlots: data?.invalidPresentedSlots,
      rejectedRecords: data?.rejectedRecords,
      excludedSlots: data?.excludedSlots,
      sthSourcesConfigured,
    }),
    [data?.excludedSlots, data?.invalidPresentedSlots, data?.missingSlots, data?.rejectedRecords, sthSourcesConfigured],
  );

  const summaryOverride = useMemo<OverallStatusOverride | null>(() => {
    const checks = data?.verificationChecks;
    if (!checks || checks.length === 0) {
      return null;
    }
    const summary = deriveVerificationSummary(checks, summaryContext);
    if (!summary) {
      return null;
    }
    const toneConfig = SUMMARY_TONE_CONFIG[summary.tone];
    const mainKey = SUMMARY_MAIN_MESSAGE_KEYS[summary.status];
    const subKey = summary.messageKey ?? SUMMARY_SUB_MESSAGE_KEYS[summary.status];
    return {
      status: toneConfig.status,
      message: t(mainKey),
      subMessage: subKey ? t(subKey) : undefined,
    };
  }, [data?.verificationChecks, summaryContext, t]);

  const explicitServerFailureOverride = useMemo<OverallStatusOverride | null>(() => {
    if (!data) {
      return null;
    }
    if (starkTimeoutDetected) {
      return {
        status: 'failed',
        message: t('pages.verify.status.timeout'),
      };
    }
    if (starkSequenceFailureMessage) {
      return {
        status: 'failed',
        message: t('pages.verify.failed'),
        subMessage: starkSequenceFailureMessage,
      };
    }
    if (explicitProofFailureDetected) {
      return {
        status: 'failed',
        message: t('pages.verify.resultSummary.proofVerificationFailedMain'),
        subMessage: t('pages.verify.resultSummary.proofVerificationFailedSub'),
      };
    }
    return null;
  }, [data, explicitProofFailureDetected, starkSequenceFailureMessage, starkTimeoutDetected, t]);

  const overallStatusOverride = useMemo<OverallStatusOverride | null>(() => {
    if (explicitServerFailureOverride) {
      return explicitServerFailureOverride;
    }
    if (summaryOverride) {
      return summaryOverride;
    }
    if (hasVerificationChecks) {
      if (hardFailureDetected) {
        return {
          status: 'failed',
          message: t('pages.verify.failed'),
        };
      }
      if (hasCheckPending) {
        return {
          status: 'warning',
          message: t('pages.verify.status.partial'),
        };
      }
      return null;
    }
    return null;
  }, [explicitServerFailureOverride, hasCheckPending, hasVerificationChecks, hardFailureDetected, summaryOverride, t]);

  const showResults = verificationStarted && sequenceComplete && !hasCheckPending;
  const showBotTab = data?.scenarioId === 'S3' || data?.scenarioId === 'S4';
  const botTabTooltip = t('verification.tabs.botDisabledTooltip');
  const verificationContent = (
    <>
      <UnifiedVerificationCard
        summary={
          showResults && overallStatusOverride
            ? {
                status:
                  overallStatusOverride.status === 'verified'
                    ? 'verified'
                    : overallStatusOverride.status === 'warning'
                      ? 'warning'
                      : 'failed',
                message: overallStatusOverride.message,
                subMessage: overallStatusOverride.subMessage,
              }
            : null
        }
        verificationChecks={data?.verificationChecks}
        starkGateStatus={starkGateStatus}
        visibleStepCount={visibleStepCount}
        sequenceComplete={sequenceComplete}
        stepStatusMap={stepStatusMap}
        download={{
          available: bundleCandidates.length > 0,
          status: downloadState,
          error: downloadError,
          onDownload: () => {
            void handleDownload();
          },
        }}
      />

      {showResults && tamperError && <InlineAlert message={tamperError} variant="error" />}
    </>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 md:px-6 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="font-display text-[var(--text-display)] font-bold text-ink-900 mb-3 tracking-[var(--tracking-display)] leading-[var(--leading-display)]">
          {t('pages.verify.title')}
        </h1>
        <p className="font-secondary text-text-secondary leading-relaxed">{t('pages.verify.subtitle')}</p>
      </div>

      {loading && <InlineAlert message={t('pages.verify.loading')} variant="info" />}

      {!loading && error && <InlineAlert message={error} variant="error" />}

      {!loading && !error && data && directAccessBlocked && (
        <div className="space-y-4">
          <InlineAlert message={t('pages.verify.directAccess')} variant="error" />
          <Button variant="secondary" onClick={() => router.push('/result')}>
            {t('pages.verify.actions.backToResult')}
          </Button>
        </div>
      )}

      {!loading && !error && data && !verificationStarted && !directAccessBlocked && (
        <InlineAlert message={t('pages.verify.loading')} variant="info" />
      )}

      {!loading && !error && data && verificationStarted && (
        <>
          {showBotTab ? (
            <div className="space-y-4">
              <div className="flex border-be border-paper-border" role="tablist">
                <button
                  type="button"
                  id="tab-my"
                  role="tab"
                  aria-selected="true"
                  className="relative px-4 py-2.5 text-sm font-medium text-ink-900 border-be-2 border-ink-700 -mbe-px transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-500"
                >
                  {t('verification.tabs.my')}
                </button>
                <button
                  type="button"
                  id="tab-bot"
                  role="tab"
                  aria-selected="false"
                  aria-disabled="true"
                  tabIndex={-1}
                  title={botTabTooltip}
                  className="relative px-4 py-2.5 text-sm font-medium text-text-disabled cursor-not-allowed transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-500"
                >
                  {t('verification.tabs.bot')}
                </button>
              </div>
              <div role="tabpanel" aria-labelledby="tab-my">
                {verificationContent}
              </div>
            </div>
          ) : (
            verificationContent
          )}
        </>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@stark-ballot/web/hooks';
import type { TranslationKey } from '@stark-ballot/web/i18n';
import {
  captureSessionIdentity,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  isSessionReplaced,
  SESSION_STORAGE_KEY,
  updateLastActivityForIdentity,
  SESSION_HEARTBEAT_INTERVAL_MS,
} from '@stark-ballot/web/session';
import { setProofBundleStatus } from '@stark-ballot/web/knowledge';
import { VERIFY_MY_KNOWLEDGE_KEYS } from '@stark-ballot/web/knowledge';
import {
  UnifiedVerificationCard,
  type UnifiedVerificationCardProps,
} from '@stark-ballot/web/components/verification/UnifiedVerificationCard';
import { InlineAlert } from '@stark-ballot/web/components/ui/InlineAlert';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { ApiClientError } from '@stark-ballot/web/api/client';
import { runVerification } from '@stark-ballot/web/api/verification';
import { downloadBundle, fetchVerificationReport } from '@stark-ballot/web/api/artifacts';
import { readBrowserPublicEnv } from '@stark-ballot/runtime-config/env/browserPublic';
import { resolveConfiguredSthSources } from '@stark-ballot/web/verification/sthSources';
import { detectTampering } from '@stark-ballot/verification/tamper-detection';
import type { VerificationSummaryStatus } from '@stark-ballot/verification/summary';
import {
  deriveVerificationPresentationPolicy,
  type VerificationDisplayStatus,
} from '@stark-ballot/verification/presentation-policy';
import {
  isVerificationClientInvalidationError,
  resolveVerificationClientApiError,
} from '@stark-ballot/web/verification/client-api-errors';
import { useVerificationData } from './hooks/useVerificationData';
import { useVerificationObservation } from './hooks/useVerificationObservation';
import { useVerificationSequence } from './hooks/useVerificationSequence';
import {
  buildDetectionReceipt,
  buildDetectionVote,
  resolveBundleCandidate,
  resolveReportCandidate,
  resolveStarkStatus,
} from './lib/verification-data';
import { resolveEligibleRenderedVerificationStatus } from './lib/verification-presentation';
import { isStarkTimeoutError } from './lib/stark-timeout';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';

type OverallStatusOverride = {
  status: VerificationDisplayStatus;
  message: string;
  subMessage?: string;
};

const SUMMARY_MAIN_MESSAGE_KEYS = {
  fully_verified: 'pages.verify.resultSummary.fullyVerifiedMain',
  demo_only: 'pages.verify.resultSummary.demoOnlyMain',
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
} satisfies Record<VerificationSummaryStatus, TranslationKey>;

const SUMMARY_SUB_MESSAGE_KEYS: Partial<Record<VerificationSummaryStatus, TranslationKey>> = {
  fully_verified: 'pages.verify.resultSummary.fullyVerifiedSub',
  demo_only: 'pages.verify.resultSummary.demoOnlySub',
  in_progress: 'pages.verify.resultSummary.inProgressSub',
  user_vote_excluded: 'pages.verify.resultSummary.userVoteExcludedSub',
  votes_excluded: 'pages.verify.resultSummary.votesExcludedSub',
  votes_excluded_unknown: 'pages.verify.resultSummary.votesExcludedUnknownSub',
  published_tally_mismatch: 'pages.verify.resultSummary.publishedTallyMismatchSub',
  counted_integrity_failed: 'pages.verify.resultSummary.countedIntegrityFailedSub',
  proof_verification_failed: 'pages.verify.resultSummary.proofVerificationFailedSub',
};

export default function VerifyPage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useAppRouter();
  const verificationStartedRef = useRef(false);
  const [expectedSessionIdentity] = useState(() => captureSessionIdentity(getSessionData()));
  const expectedSessionIdentityRef = useRef(expectedSessionIdentity);
  const expectedSessionId = expectedSessionIdentity?.sessionId;
  const [downloadState, setDownloadState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [tamperError, setTamperError] = useState<string | null>(null);

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

  const {
    data,
    setData,
    loading,
    setLoading,
    serverValidated,
    hasVerificationContinuationAuthority,
    error,
    setError,
    fetchVerificationRef,
    triggerFetch,
  } = useVerificationData({
    t,
    sessionIdentityRef: expectedSessionIdentityRef,
    initialSessionIdentity: expectedSessionIdentity,
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
    const finalization = resolveCanonicalFinalizationPayload(session.finalizeResult);
    if (!finalization) {
      throw new Error(resolveSessionErrorMessage());
    }

    try {
      await runVerification(session, finalization.finalizationId);
    } catch (error) {
      if (!(error instanceof ApiClientError)) {
        throw error;
      }
      const resolvedError = resolveVerificationClientApiError({
        rawBody: error.responseBody,
        responseStatus: error.status,
        responseStatusText: error.statusText,
        sessionIdentity: expectedSessionIdentityRef.current,
        resolveSessionErrorMessage,
        fallbackMessage: `Verification run request failed: ${error.status}`,
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
    return !hasVerificationContinuationAuthority && actualStarkStatus === 'not_run';
  }, [loading, error, data, verificationStarted, hasVerificationContinuationAuthority, actualStarkStatus]);

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

  useEffect(() => {
    const cancelledRef: { current: boolean } = { current: false };

    void (async () => {
      if (!data) {
        setTamperError(null);
        return;
      }

      const receipt = buildDetectionReceipt(data);
      const vote = buildDetectionVote(data, getExpectedSession());
      if (!receipt || !vote) {
        setTamperError(null);
        return;
      }

      try {
        await detectTampering(receipt, vote, {
          ...omitUndefinedProperties({ expectedTotalVotes: data.totalExpected }),
          ...omitUndefinedProperties({ scenarios: data.scenarioId ? [data.scenarioId] : undefined }),
        });
        if (!cancelledRef.current) {
          setTamperError(null);
        }
      } catch (err) {
        if (!cancelledRef.current) {
          const message = err instanceof Error ? err.message : String(err);
          setTamperError(message);
        }
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [data, getExpectedSession]);

  const bundleCandidate = useMemo(() => resolveBundleCandidate(data, expectedSessionId), [data, expectedSessionId]);
  const reportCandidate = useMemo(() => resolveReportCandidate(data, expectedSessionId), [data, expectedSessionId]);
  const handleDownload = useCallback(async () => {
    if (!bundleCandidate) {
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
      await downloadBundle(bundleCandidate, {
        identity: session,
        sessionIdentity: expectedSessionIdentityRef.current,
        resolveSessionErrorMessage,
      });
      if (reportCandidate) {
        await fetchVerificationReport(reportCandidate, {
          identity: session,
          sessionIdentity: expectedSessionIdentityRef.current,
          resolveSessionErrorMessage,
        });
      }
      setDownloadState('success');
      setProofBundleStatus('downloaded');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      handleFatalVerificationInvalidation(error);
      setDownloadState('error');
      setDownloadError(message);
    }
  }, [
    bundleCandidate,
    getExpectedSession,
    handleFatalVerificationInvalidation,
    reportCandidate,
    resolveSessionErrorMessage,
    t,
  ]);

  const sthSourcesConfigured = useMemo(() => resolveConfiguredSthSources(readBrowserPublicEnv).length > 0, []);
  const hasCheckPending =
    data?.verificationChecks?.some((check) => check.status === 'pending' || check.status === 'running') ?? false;

  useVerificationObservation({
    data,
    sequenceComplete,
    hasCheckPending,
    serverValidated,
    verificationStatus: actualStarkStatus,
    sessionIdentityRef: expectedSessionIdentityRef,
  });

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
  const presentationPolicy = useMemo(
    () =>
      deriveVerificationPresentationPolicy({
        availability: data ? 'available' : 'unavailable',
        ...(data ? { checks: data.verificationChecks } : {}),
        context: {
          ...omitUndefinedProperties({
            missingSlots: data?.missingSlots,
            invalidPresentedSlots: data?.invalidPresentedSlots,
            rejectedRecords: data?.rejectedRecords,
            excludedSlots: data?.excludedSlots,
            devModeEvidence:
              data?.verificationReport?.dev_mode_receipt === true || data?.verificationStatus === 'dev_mode',
          }),
          sthSourcesConfigured,
        },
        ...omitUndefinedProperties({
          verificationStatus: data?.verificationStatus,
          verificationReportStatus: data?.verificationReport?.status,
        }),
        explicitServerFailureStatus: starkTimeoutDetected || starkSequenceFailureMessage ? 'failed' : null,
        verificationStarted,
        sequenceComplete,
      }),
    [
      data,
      sequenceComplete,
      starkSequenceFailureMessage,
      starkTimeoutDetected,
      sthSourcesConfigured,
      verificationStarted,
    ],
  );
  const starkGateStatus = useMemo<'success' | 'failed' | 'pending'>(() => {
    if (starkTimeoutDetected || starkSequenceFailureMessage) {
      return 'failed';
    }
    const status = presentationPolicy.stageStatuses.stark_verification;
    if (status === 'success' || status === 'failed') {
      return status;
    }
    return 'pending';
  }, [presentationPolicy.stageStatuses.stark_verification, starkSequenceFailureMessage, starkTimeoutDetected]);

  const summaryOverride = useMemo<OverallStatusOverride | null>(() => {
    const summary = presentationPolicy.summary;
    const displayStatus = presentationPolicy.display.status;
    if (!summary || !displayStatus) {
      return null;
    }
    const mainKey = SUMMARY_MAIN_MESSAGE_KEYS[summary.status];
    const subKey = summary.messageKey ?? SUMMARY_SUB_MESSAGE_KEYS[summary.status];
    return {
      status: displayStatus,
      message: t(mainKey),
      ...omitUndefinedProperties({ subMessage: subKey ? t(subKey) : undefined }),
    };
  }, [presentationPolicy.display.status, presentationPolicy.summary, t]);

  const overallStatusOverride = useMemo<OverallStatusOverride | null>(() => {
    const status = presentationPolicy.display.status;
    const source = presentationPolicy.display.source;
    if (!status || !source) {
      return null;
    }
    if (source === 'summary' && summaryOverride) {
      return summaryOverride;
    }
    if (source === 'explicit_server_failure') {
      if (starkTimeoutDetected) {
        return { status, message: t('pages.verify.status.timeout') };
      }
      if (starkSequenceFailureMessage) {
        return {
          status,
          message: t('pages.verify.failed'),
          subMessage: starkSequenceFailureMessage,
        };
      }
      return {
        status,
        message: t('pages.verify.resultSummary.proofVerificationFailedMain'),
        subMessage: t('pages.verify.resultSummary.proofVerificationFailedSub'),
      };
    }
    if (source === 'pending') {
      return {
        status,
        message: t('pages.verify.status.partial'),
      };
    }
    return {
      status,
      message:
        source === 'unavailable' || source === 'corrupt' ? t('pages.verify.status.partial') : t('pages.verify.failed'),
    };
  }, [
    presentationPolicy.display.source,
    presentationPolicy.display.status,
    starkSequenceFailureMessage,
    starkTimeoutDetected,
    summaryOverride,
    t,
  ]);

  const showResults = presentationPolicy.display.readiness === 'ready';
  const renderedOverallStatus = resolveEligibleRenderedVerificationStatus(presentationPolicy);
  let summary: UnifiedVerificationCardProps['summary'] = null;
  if (renderedOverallStatus && overallStatusOverride) {
    const text = {
      message: overallStatusOverride.message,
      ...omitUndefinedProperties({ subMessage: overallStatusOverride.subMessage }),
    };
    if (renderedOverallStatus === 'verified') {
      if (presentationPolicy.fullyVerifiedLabelEligible) {
        summary = { ...text, status: renderedOverallStatus, verifiedPresentation: presentationPolicy };
      }
    } else {
      summary = { ...text, status: renderedOverallStatus };
    }
  }
  const showBotTab = data?.scenarioId === 'S3' || data?.scenarioId === 'S4';
  const botTabTooltip = t('verification.tabs.botDisabledTooltip');
  const verificationContent = (
    <>
      <UnifiedVerificationCard
        knowledgeFilterKeys={verificationStarted ? VERIFY_MY_KNOWLEDGE_KEYS : []}
        summary={summary}
        {...omitUndefinedProperties({ verificationChecks: data?.verificationChecks })}
        starkGateStatus={starkGateStatus}
        visibleStepCount={visibleStepCount}
        sequenceComplete={sequenceComplete}
        stepStatusMap={stepStatusMap}
        download={{
          available: bundleCandidate !== null,
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
    <div className="verify-page">
      {/* Page Header */}
      <div className="page-intro">
        <h1 className="page-title">{t('pages.verify.title')}</h1>
        <p className="font-secondary leading-relaxed text-text-secondary">{t('pages.verify.subtitle')}</p>
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
                  className="relative -mbe-px border-be-2 border-ink-700 px-4 py-2.5 font-medium text-sm text-ink-900 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-500"
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
                  className="relative cursor-not-allowed px-4 py-2.5 font-medium text-sm text-text-disabled transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-500"
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

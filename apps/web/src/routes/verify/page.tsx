'use client';

import { useMemo, type ReactNode } from 'react';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import { useTranslation } from '@stark-ballot/web/hooks';
import { VERIFY_MY_KNOWLEDGE_KEYS } from '@stark-ballot/web/knowledge';
import { UnifiedVerificationCard } from '@stark-ballot/web/components/verification/UnifiedVerificationCard';
import { InlineAlert } from '@stark-ballot/web/components/ui/InlineAlert';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { readPublicRuntimeEnv } from '@stark-ballot/runtime-config/env/public-runtime-config';
import { resolveConfiguredSthSources } from '@stark-ballot/web/verification/sthSources';
import { useVerificationObservation } from './hooks/useVerificationObservation';
import type { VerificationPayload } from './lib/verification-data';
import { useVerificationController } from './hooks/useVerificationController';
import { resolveVerificationPagePresentation } from './lib/verification-presentation';
import { useVerificationArtifacts } from './hooks/useVerificationArtifacts';
import { useVerificationTamperError } from './hooks/useVerificationTamperError';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

interface VerificationPageBodyProps {
  loading: boolean;
  error: string | null;
  data: VerificationPayload | null;
  directAccessBlocked: boolean;
  verificationStarted: boolean;
  showBotTab: boolean;
  verificationContent: ReactNode;
  t: UseTranslationResult['t'];
  router: ReturnType<typeof useAppRouter>;
}

function VerificationPageBody({
  loading,
  error,
  data,
  directAccessBlocked,
  verificationStarted,
  showBotTab,
  verificationContent,
  t,
  router,
}: VerificationPageBodyProps): ReactNode {
  if (loading) return <InlineAlert message={t('pages.verify.loading')} variant="info" />;
  if (error) return <InlineAlert message={error} variant="error" />;
  if (!data) return null;
  if (directAccessBlocked)
    return (
      <div className="space-y-4">
        <InlineAlert message={t('pages.verify.directAccess')} variant="error" />
        <Button variant="secondary" onClick={() => router.push('/result')}>
          {t('pages.verify.actions.backToResult')}
        </Button>
      </div>
    );
  if (!verificationStarted) return <InlineAlert message={t('pages.verify.loading')} variant="info" />;
  const botTabTooltip = t('verification.tabs.botDisabledTooltip');
  return showBotTab ? (
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
  );
}

export default function VerifyPage(): React.ReactElement {
  const { t } = useTranslation();
  const router = useAppRouter();
  const {
    expectedSessionIdentityRef,
    expectedSessionId,
    getExpectedSession,
    resolveSessionErrorMessage,
    data,
    loading,
    error,
    serverValidated,
    handleFatalVerificationInvalidation,
    verificationStarted,
    visibleStepCount,
    sequenceComplete,
    stepStatusMap,
    actualStarkStatus,
    hasCheckPending,
    showBotTab,
    verificationChecks,
    directAccessBlocked,
  } = useVerificationController(t);

  const tamperError = useVerificationTamperError(data, getExpectedSession);

  const download = useVerificationArtifacts({
    data,
    expectedSessionId,
    expectedSessionIdentityRef,
    getExpectedSession,
    resolveSessionErrorMessage,
    handleFatalVerificationInvalidation,
    t,
  });

  const sthSourcesConfigured = useMemo(() => resolveConfiguredSthSources(readPublicRuntimeEnv).length > 0, []);

  useVerificationObservation({
    data,
    sequenceComplete,
    hasCheckPending,
    serverValidated,
    verificationStatus: actualStarkStatus,
    sessionIdentityRef: expectedSessionIdentityRef,
  });

  const { showResults, summary, starkGateStatus } = useMemo(
    () =>
      resolveVerificationPagePresentation({
        data,
        starkStep: stepStatusMap.stark_verification,
        sthSourcesConfigured,
        verificationStarted,
        sequenceComplete,
        t,
      }),
    [data, stepStatusMap.stark_verification, sthSourcesConfigured, verificationStarted, sequenceComplete, t],
  );
  const verificationContent = (
    <>
      <UnifiedVerificationCard
        knowledgeFilterKeys={verificationStarted ? VERIFY_MY_KNOWLEDGE_KEYS : []}
        summary={summary}
        {...omitUndefinedProperties({ verificationChecks })}
        starkGateStatus={starkGateStatus}
        visibleStepCount={visibleStepCount}
        sequenceComplete={sequenceComplete}
        stepStatusMap={stepStatusMap}
        download={download}
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

      <VerificationPageBody
        loading={loading}
        error={error}
        data={data}
        directAccessBlocked={directAccessBlocked}
        verificationStarted={verificationStarted}
        showBotTab={showBotTab}
        verificationContent={verificationContent}
        t={t}
        router={router}
      />
    </div>
  );
}

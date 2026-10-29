import { useCallback, useMemo, useState, type RefObject } from 'react';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import type { SessionIdentity } from '@stark-ballot/web/session';
import type { SessionData } from '@stark-ballot/web/session/types';
import { setProofBundleStatus } from '@stark-ballot/web/knowledge';
import { downloadBundle, fetchVerificationReport } from '@stark-ballot/web/api/artifacts';
import { resolveBundleCandidate, resolveReportCandidate, type VerificationPayload } from '../lib/verification-data';

interface VerificationArtifactsOptions {
  data: VerificationPayload | null;
  expectedSessionId: string | undefined;
  expectedSessionIdentityRef: RefObject<SessionIdentity | null>;
  getExpectedSession: () => SessionData | null;
  resolveSessionErrorMessage: () => string;
  handleFatalVerificationInvalidation: (error: unknown) => void;
  t: UseTranslationResult['t'];
}

export function useVerificationArtifacts({
  data,
  expectedSessionId,
  expectedSessionIdentityRef,
  getExpectedSession,
  resolveSessionErrorMessage,
  handleFatalVerificationInvalidation,
  t,
}: VerificationArtifactsOptions) {
  const [downloadState, setDownloadState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [downloadError, setDownloadError] = useState<string | null>(null);
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
    expectedSessionIdentityRef,
    bundleCandidate,
    getExpectedSession,
    handleFatalVerificationInvalidation,
    reportCandidate,
    resolveSessionErrorMessage,
    t,
  ]);

  return {
    available: bundleCandidate !== null,
    status: downloadState,
    error: downloadError,
    onDownload: () => {
      void handleDownload();
    },
  };
}

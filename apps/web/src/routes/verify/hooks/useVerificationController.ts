import { useCallback, useEffect, useRef } from 'react';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import {
  isSessionReplacedForIdentity,
  SESSION_STORAGE_KEY,
  updateLastActivityForIdentity,
  SESSION_HEARTBEAT_INTERVAL_MS,
} from '@stark-ballot/web/session';
import { ApiClientError } from '@stark-ballot/web/api/client';
import { runVerification } from '@stark-ballot/web/api/verification';
import {
  isVerificationClientInvalidationError,
  resolveVerificationClientApiError,
} from '@stark-ballot/web/verification/client-api-errors';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import { resolveStarkStatus, type VerificationPayload } from '../lib/verification-data';
import { useVerificationData } from './useVerificationData';
import { useVerificationSequence } from './useVerificationSequence';
import { useVerificationSession } from './useVerificationSession';

function verificationViewFacts(data: VerificationPayload | null) {
  if (!data)
    return {
      actualStarkStatus: resolveStarkStatus(undefined, undefined),
      hasCheckPending: false,
      showBotTab: false,
      verificationChecks: undefined,
    };
  return {
    actualStarkStatus: resolveStarkStatus(data.verificationStatus, data.verificationReport),
    hasCheckPending:
      data.verificationChecks?.some((check) => check.status === 'pending' || check.status === 'running') ?? false,
    showBotTab: data.scenarioId === 'S3' || data.scenarioId === 'S4',
    verificationChecks: data.verificationChecks,
  };
}

interface VerificationAccessState {
  loading: boolean;
  error: string | null;
  data: VerificationPayload | null;
  verificationStarted: boolean;
  hasVerificationContinuationAuthority: boolean;
  actualStarkStatus: ReturnType<typeof resolveStarkStatus>;
}

function isDirectVerificationAccessBlocked(state: VerificationAccessState): boolean {
  if (state.loading || state.error || !state.data || state.verificationStarted) return false;
  return !state.hasVerificationContinuationAuthority && state.actualStarkStatus === 'not_run';
}

export function useVerificationController(t: UseTranslationResult['t']) {
  const verificationStartedRef = useRef(false);
  const {
    expectedSessionIdentity,
    expectedSessionIdentityRef,
    expectedSessionId,
    getExpectedSession,
    resolveSessionErrorMessage,
  } = useVerificationSession(t);

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
  }, [expectedSessionIdentityRef, getExpectedSession, handleFatalVerificationInvalidation, resolveSessionErrorMessage]);

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
  }, [expectedSessionIdentityRef, getExpectedSession, resolveSessionErrorMessage, setError, setLoading]);

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

  const { actualStarkStatus, hasCheckPending, showBotTab, verificationChecks } = verificationViewFacts(data);
  const directAccessBlocked = isDirectVerificationAccessBlocked({
    loading,
    error,
    data,
    verificationStarted,
    hasVerificationContinuationAuthority,
    actualStarkStatus,
  });

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
  }, [expectedSessionIdentityRef]);

  return {
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
  };
}

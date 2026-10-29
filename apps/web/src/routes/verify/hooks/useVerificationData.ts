'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import {
  getSessionDataForIdentity,
  isSessionReplaced,
  isSessionReplacedForIdentity,
  type SessionIdentity,
} from '@stark-ballot/web/session';
import {
  getKnowledgeValue,
  mergeKnowledgeFromApi,
  saveKnowledgeData,
  VERIFICATION_GATED_KEYS,
} from '@stark-ballot/web/knowledge';
import { getVerification } from '@stark-ballot/web/api/verification';
import { ApiClientError } from '@stark-ballot/web/api/client';
import {
  getStarkVerificationSnapshot,
  subscribeStarkVerificationSnapshot,
} from '@stark-ballot/web/verification/stark-verification-polling';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import {
  resolveVerificationClientApiError,
  resolveVerificationUnavailableError,
} from '@stark-ballot/web/verification/client-api-errors';
import type { VerificationPayload } from '../lib/verification-data';
import { projectVerificationResource, resolveBundleCandidate } from '../lib/verification-data';
import { admitVerificationResourceSnapshot } from '../lib/verification-response-admission';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { readPublicRuntimeEnv } from '@stark-ballot/runtime-config/env/public-runtime-config';
import { resolveConfiguredSthSources } from '@stark-ballot/web/verification/sthSources';

const SESSION_ERROR_KEY = 'pages.verify.sessionError';
const SESSION_REPLACED_ERROR_KEY = 'pages.verify.sessionReplaced';

interface UseVerificationDataOptions {
  t: UseTranslationResult['t'];
  sessionIdentityRef: RefObject<SessionIdentity | null>;
  initialSessionIdentity?: SessionIdentity | null;
}

interface UseVerificationDataResult {
  data: VerificationPayload | null;
  setData: Dispatch<SetStateAction<VerificationPayload | null>>;
  loading: boolean;
  setLoading: Dispatch<SetStateAction<boolean>>;
  serverValidated: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  fetchVerification: () => Promise<VerificationPayload>;
  fetchVerificationRef: RefObject<() => Promise<VerificationPayload>>;
  triggerFetch: () => void;
  hasVerificationContinuationAuthority: boolean;
}

const hasContinuationAuthority = (session: ReturnType<typeof getSessionDataForIdentity>): boolean =>
  typeof session?.verificationRequestedAt === 'number' &&
  Boolean(resolveCanonicalFinalizationPayload(session.finalizeResult));

function resolveFailClosedResourceError(
  availability: 'unavailable' | 'corrupt',
  message: string,
  sessionIdentity: SessionIdentity | null,
): Error {
  return resolveVerificationUnavailableError({
    code: availability === 'unavailable' ? 'VERIFICATION_UNAVAILABLE' : 'INVALID_VERIFICATION_ARTIFACT',
    message,
    sessionIdentity,
  });
}

function resolveInitialVerificationSnapshot(initialSessionIdentity: SessionIdentity | null) {
  const initialSnapshot = getStarkVerificationSnapshot();
  const session = initialSessionIdentity ? getSessionDataForIdentity(initialSessionIdentity) : null;
  const finalization = resolveCanonicalFinalizationPayload(session?.finalizeResult);
  if (
    !initialSnapshot ||
    session?.sessionId !== initialSnapshot.sessionId ||
    finalization?.finalizationId !== initialSnapshot.finalizationId
  ) {
    return { session, data: null, receivedAt: 0 };
  }
  const resource = admitVerificationResourceSnapshot(initialSnapshot.payload, finalization.finalizationId);
  const projection = projectVerificationResource(resource, session, {
    sthSourcesConfigured: resolveConfiguredSthSources(readPublicRuntimeEnv).length > 0,
  });
  return {
    session,
    data: projection.availability === 'available' ? projection.data : null,
    receivedAt: initialSnapshot.receivedAt,
  };
}

function saveVerificationKnowledge(
  parsed: VerificationPayload,
  sessionId: string,
  identity: SessionIdentity | null,
): void {
  // Save verification data to knowledge store
  mergeKnowledgeFromApi(
    { ...parsed },
    {
      omitKeys: VERIFICATION_GATED_KEYS,
      ...omitUndefinedProperties({ expectedSessionId: identity?.sessionId }),
    },
  );
  // Set proof bundle status when verification data is available
  if (resolveBundleCandidate(parsed, sessionId)) {
    const currentBundleStatus = getKnowledgeValue('proofBundleStatus');
    if (currentBundleStatus !== 'downloaded') {
      saveKnowledgeData(
        { proofBundleStatus: currentBundleStatus ?? 'not_downloaded' },
        omitUndefinedProperties({ expectedSessionId: identity?.sessionId }),
      );
    }
  }
}

export function useVerificationData({
  t,
  sessionIdentityRef,
  initialSessionIdentity = null,
}: UseVerificationDataOptions): UseVerificationDataResult {
  const resolveSessionErrorMessage = useCallback(
    (): string =>
      t(
        isSessionReplacedForIdentity(sessionIdentityRef.current) || isSessionReplaced()
          ? SESSION_REPLACED_ERROR_KEY
          : SESSION_ERROR_KEY,
      ),
    [sessionIdentityRef, t],
  );
  const initial = resolveInitialVerificationSnapshot(initialSessionIdentity);
  const [fetchTrigger, setFetchTrigger] = useState(0);
  const [loading, setLoading] = useState(true);
  const [serverValidated, setServerValidated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<VerificationPayload | null>(initial.data);
  const [hasVerificationContinuationAuthority, setHasVerificationContinuationAuthority] = useState(
    hasContinuationAuthority(initial.session),
  );
  const latestSnapshotAtRef = useRef(initial.receivedAt);

  useEffect(() => {
    const unsubscribe = subscribeStarkVerificationSnapshot((snapshot) => {
      const session = getSessionDataForIdentity(sessionIdentityRef.current);
      if (!session || session.sessionId !== snapshot.sessionId) {
        return;
      }
      const finalization = resolveCanonicalFinalizationPayload(session.finalizeResult);
      if (!finalization) {
        return;
      }
      if (!serverValidated) {
        return;
      }
      if (snapshot.receivedAt <= latestSnapshotAtRef.current) {
        return;
      }
      latestSnapshotAtRef.current = snapshot.receivedAt;
      if (snapshot.finalizationId !== finalization.finalizationId) {
        setData(null);
        setServerValidated(false);
        setError('Verification snapshot finalization identity mismatch');
        setLoading(false);
        return;
      }
      const resource = admitVerificationResourceSnapshot(snapshot.payload, finalization.finalizationId);
      const projection = projectVerificationResource(resource, session, {
        sthSourcesConfigured: resolveConfiguredSthSources(readPublicRuntimeEnv).length > 0,
      });
      if (projection.availability !== 'available') {
        setData(null);
        setServerValidated(false);
        setError(projection.message);
        setLoading(false);
        return;
      }
      setData(projection.data);
      setError(null);
      setLoading(false);
    });
    return unsubscribe;
  }, [serverValidated, sessionIdentityRef]);

  const fetchVerification = useCallback(async (): Promise<VerificationPayload> => {
    const session = getSessionDataForIdentity(sessionIdentityRef.current);
    if (!session) {
      setHasVerificationContinuationAuthority(false);
      throw new Error(resolveSessionErrorMessage());
    }
    setHasVerificationContinuationAuthority(hasContinuationAuthority(session));
    const finalization = resolveCanonicalFinalizationPayload(session.finalizeResult);
    if (!finalization) {
      setHasVerificationContinuationAuthority(false);
      throw new Error(resolveSessionErrorMessage());
    }

    let resource;
    try {
      resource = await getVerification(session, finalization.finalizationId);
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw resolveVerificationClientApiError({
          rawBody: error.responseBody,
          responseStatus: error.status,
          responseStatusText: error.statusText,
          sessionIdentity: sessionIdentityRef.current,
          resolveSessionErrorMessage,
          fallbackMessage: 'Verification API error',
        });
      }
      throw error;
    }

    const projection = projectVerificationResource(resource, session, {
      sthSourcesConfigured: resolveConfiguredSthSources(readPublicRuntimeEnv).length > 0,
    });
    if (projection.availability !== 'available') {
      throw resolveFailClosedResourceError(projection.availability, projection.message, sessionIdentityRef.current);
    }

    const parsed = projection.data;
    latestSnapshotAtRef.current = Math.max(latestSnapshotAtRef.current, Date.now());
    setServerValidated(true);
    saveVerificationKnowledge(parsed, session.sessionId, sessionIdentityRef.current);
    setData(parsed);
    setError(null);
    return parsed;
  }, [
    resolveSessionErrorMessage,
    sessionIdentityRef,
    setData,
    setError,
    setHasVerificationContinuationAuthority,
    setServerValidated,
  ]);

  const fetchVerificationRef = useRef(fetchVerification);

  useEffect(() => {
    fetchVerificationRef.current = fetchVerification;
  }, [fetchVerification]);

  useEffect(() => {
    if (fetchTrigger === 0) {
      return;
    }

    const cancelledRef: { current: boolean } = { current: false };
    void (async () => {
      try {
        setLoading(true);
        await fetchVerificationRef.current();
        setError(null);
      } catch (err) {
        if (!cancelledRef.current) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setData(null);
          setServerValidated(false);
          setHasVerificationContinuationAuthority(false);
        }
      } finally {
        if (!cancelledRef.current) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchTrigger]);

  const triggerFetch = useCallback(() => {
    setFetchTrigger((count) => count + 1);
  }, [setFetchTrigger]);

  return {
    data,
    setData,
    loading,
    setLoading,
    serverValidated,
    hasVerificationContinuationAuthority,
    error,
    setError,
    fetchVerification,
    fetchVerificationRef,
    triggerFetch,
  };
}

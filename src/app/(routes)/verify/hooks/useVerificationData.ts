'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  getSessionAuthHeaders,
  getSessionDataForIdentity,
  isSessionReplaced,
  isSessionReplacedForIdentity,
  type SessionIdentity,
} from '@/lib/session';
import { getKnowledgeValue, mergeKnowledgeFromApi, saveKnowledgeData, VERIFICATION_GATED_KEYS } from '@/lib/knowledge';
import { getRecordProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { apiFetch } from '@/lib/api/apiFetch';
import {
  getStarkVerificationSnapshot,
  subscribeStarkVerificationSnapshot,
} from '@/lib/verification/stark-verification-polling';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import { readResponseJsonSafely, resolveVerificationClientApiError } from '@/lib/verification/client-api-errors';
import type { VerificationPayload } from '../lib/verification-data';
import { applyLocalCastAsIntended, buildBundleCandidates, parseVerificationPayload } from '../lib/verification-data';

const SESSION_ERROR_KEY = 'pages.verify.sessionError';
const SESSION_REPLACED_ERROR_KEY = 'pages.verify.sessionReplaced';

interface UseVerificationDataOptions {
  t: (key: string, vars?: Record<string, string | number>) => string;
  sessionIdentityRef: MutableRefObject<SessionIdentity | null>;
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
  fetchVerificationRef: MutableRefObject<() => Promise<VerificationPayload>>;
  triggerFetch: () => void;
}

export function useVerificationData({ t, sessionIdentityRef }: UseVerificationDataOptions): UseVerificationDataResult {
  const resolveSessionErrorMessage = useCallback(
    (): string =>
      t(
        isSessionReplacedForIdentity(sessionIdentityRef.current) || isSessionReplaced()
          ? SESSION_REPLACED_ERROR_KEY
          : SESSION_ERROR_KEY,
      ),
    [sessionIdentityRef, t],
  );
  const initialSnapshot = getStarkVerificationSnapshot();
  let initialData: VerificationPayload | null = null;
  const initialSession = getSessionDataForIdentity(sessionIdentityRef.current);
  const initialFinalizationSnapshot = resolveCanonicalFinalizationPayload(initialSession?.finalizeResult);
  const initialSnapshotAt =
    initialSnapshot && initialSession?.sessionId === initialSnapshot.sessionId && initialFinalizationSnapshot
      ? initialSnapshot.receivedAt
      : 0;
  if (initialSnapshot && initialSession?.sessionId === initialSnapshot.sessionId && initialFinalizationSnapshot) {
    try {
      initialData = applyLocalCastAsIntended(parseVerificationPayload(initialSnapshot.payload), initialSession);
    } catch {
      initialData = null;
    }
  }
  const [fetchTrigger, setFetchTrigger] = useState(0);
  const [loading, setLoading] = useState(true);
  const [serverValidated, setServerValidated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<VerificationPayload | null>(initialData);
  const latestSnapshotAtRef = useRef(initialSnapshotAt);

  useEffect(() => {
    const unsubscribe = subscribeStarkVerificationSnapshot((snapshot) => {
      const session = getSessionDataForIdentity(sessionIdentityRef.current);
      if (!session || session.sessionId !== snapshot.sessionId) {
        return;
      }
      if (!resolveCanonicalFinalizationPayload(session.finalizeResult)) {
        return;
      }
      if (!serverValidated) {
        return;
      }
      if (snapshot.receivedAt <= latestSnapshotAtRef.current) {
        return;
      }
      try {
        const parsed = applyLocalCastAsIntended(parseVerificationPayload(snapshot.payload), session);
        latestSnapshotAtRef.current = snapshot.receivedAt;
        setData(parsed);
        setError(null);
        setLoading(false);
      } catch {
        // ignore malformed snapshot
      }
    });
    return unsubscribe;
  }, [serverValidated, sessionIdentityRef]);

  const fetchVerification = useCallback(async (): Promise<VerificationPayload> => {
    const session = getSessionDataForIdentity(sessionIdentityRef.current);
    if (!session) {
      throw new Error(resolveSessionErrorMessage());
    }

    const endpoint = resolveApiUrl('/api/verify');
    const response = await apiFetch(endpoint, {
      headers: getSessionAuthHeaders(session),
    });

    const rawBody = await readResponseJsonSafely(response);

    const maybeBoundaryError = getStringProperty(rawBody, 'error')
      ? resolveVerificationClientApiError({
          rawBody,
          responseStatus: response.status,
          responseStatusText: response.statusText,
          sessionIdentity: sessionIdentityRef.current,
          resolveSessionErrorMessage,
          fallbackMessage: 'Verification API error',
        })
      : null;

    if (response.ok && maybeBoundaryError?.invalidation === 'clear_finalized_projection') {
      throw maybeBoundaryError;
    }

    if (!response.ok) {
      throw (
        maybeBoundaryError ??
        resolveVerificationClientApiError({
          rawBody,
          responseStatus: response.status,
          responseStatusText: response.statusText,
          sessionIdentity: sessionIdentityRef.current,
          resolveSessionErrorMessage,
          fallbackMessage: 'Verification API error',
        })
      );
    }

    const bodyData = getRecordProperty(rawBody, 'data') ?? rawBody;
    const parsed = applyLocalCastAsIntended(parseVerificationPayload(bodyData), session);
    latestSnapshotAtRef.current = Math.max(latestSnapshotAtRef.current, Date.now());
    setServerValidated(true);
    // Save verification data to knowledge store
    if (isRecord(bodyData)) {
      mergeKnowledgeFromApi('verify', bodyData, {
        omitKeys: VERIFICATION_GATED_KEYS,
        expectedSessionId: sessionIdentityRef.current?.sessionId,
      });
      // Set proof bundle status when verification data is available
      if (buildBundleCandidates(parsed, session.sessionId).length > 0) {
        const currentBundleStatus = getKnowledgeValue('proofBundleStatus');
        if (currentBundleStatus !== 'downloaded') {
          saveKnowledgeData(
            { proofBundleStatus: currentBundleStatus ?? 'not_downloaded' },
            { expectedSessionId: sessionIdentityRef.current?.sessionId },
          );
        }
      }
    }
    setData(parsed);
    setError(null);
    return parsed;
  }, [resolveSessionErrorMessage, sessionIdentityRef]);

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
  }, []);

  return {
    data,
    setData,
    loading,
    setLoading,
    serverValidated,
    error,
    setError,
    fetchVerification,
    fetchVerificationRef,
    triggerFetch,
  };
}

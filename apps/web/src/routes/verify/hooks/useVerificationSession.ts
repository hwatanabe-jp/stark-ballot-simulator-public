import { useCallback, useRef, useState } from 'react';
import type { UseTranslationResult } from '@stark-ballot/web/hooks/useTranslation';
import {
  captureSessionIdentity,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  isSessionReplaced,
} from '@stark-ballot/web/session';

export function useVerificationSession(t: UseTranslationResult['t']) {
  const [expectedSessionIdentity] = useState(() => captureSessionIdentity(getSessionData()));
  const expectedSessionIdentityRef = useRef(expectedSessionIdentity);
  const expectedSessionId = expectedSessionIdentity?.sessionId;

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

  return {
    expectedSessionIdentity,
    expectedSessionIdentityRef,
    expectedSessionId,
    getExpectedSession,
    resolveSessionErrorMessage,
  };
}

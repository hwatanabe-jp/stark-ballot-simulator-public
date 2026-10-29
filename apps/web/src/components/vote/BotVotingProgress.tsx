'use client';

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import { InlineAlert } from '@stark-ballot/web/components/ui/InlineAlert';
import { useTranslation } from '@stark-ballot/web/hooks';
import {
  captureSessionIdentity,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  SESSION_STORAGE_KEY,
} from '@stark-ballot/web/session';
import { saveKnowledgeData } from '@stark-ballot/web/knowledge';
import { getProgress } from '@stark-ballot/web/api/progress';
import { resolveApiClientErrorCode } from '@stark-ballot/web/api/client';
import { isSessionUnavailableErrorCode } from '@stark-ballot/api-contract/errors/apiErrorGuards';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { BOT_COUNT as DEFAULT_BOT_VOTES_TOTAL } from '@stark-ballot/verification/shared/constants';
import './Vote.css';

interface BotVotingProgressProps {
  /** Callback when bot voting is complete */
  onComplete?: () => void;
  /** Auto-navigate to aggregate page */
  autoNavigate?: boolean;
}

function clearProgressInterval(intervalRef: RefObject<ReturnType<typeof setInterval> | null>): void {
  if (intervalRef.current) {
    clearInterval(intervalRef.current);
    intervalRef.current = null;
  }
}

export function BotVotingProgress({ onComplete, autoNavigate = true }: BotVotingProgressProps): React.ReactElement {
  const { t } = useTranslation();
  const router = useAppRouter();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasNavigated = useRef(false);
  const [expectedSessionIdentity] = useState(() => captureSessionIdentity(getSessionData()));
  const expectedSessionId = expectedSessionIdentity?.sessionId;

  const [sessionError, setSessionError] = useState<string | null>(null);

  const resolveSessionErrorMessage = useCallback((): string => {
    return isSessionReplacedForIdentity(expectedSessionIdentity)
      ? t('pages.vote.errors.sessionReplaced')
      : t('pages.vote.errors.sessionNotFound');
  }, [expectedSessionIdentity, t]);

  const getExpectedSession = useCallback(() => {
    return getSessionDataForIdentity(expectedSessionIdentity);
  }, [expectedSessionIdentity]);

  useEffect(() => {
    saveKnowledgeData(
      { botVotesStatus: { status: 'pending', total: DEFAULT_BOT_VOTES_TOTAL } },
      omitUndefinedProperties({ expectedSessionId }),
    );
  }, [expectedSessionId]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_STORAGE_KEY) {
        return;
      }
      if (!isSessionReplacedForIdentity(expectedSessionIdentity)) {
        return;
      }
      setSessionError(t('pages.vote.errors.sessionReplaced'));
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [expectedSessionIdentity, t]);

  // Poll for completion
  useEffect(() => {
    if (sessionError || hasNavigated.current) {
      return;
    }

    let active = true;
    let inFlight = false;
    const controller = new AbortController();
    const canFetchProgress = () => !inFlight && active && !hasNavigated.current;
    const applyProgress = (data: Awaited<ReturnType<typeof getProgress>>) => {
      // Check completion
      const { completed: completedFlag, count, total } = data;
      const completed = completedFlag || count >= total;

      if (completed && !hasNavigated.current) {
        hasNavigated.current = true;
        saveKnowledgeData(
          {
            botVotesStatus: {
              status: 'completed',
              total,
            },
          },
          omitUndefinedProperties({ expectedSessionId }),
        );

        clearProgressInterval(intervalRef);

        onComplete?.();

        if (autoNavigate) {
          if (!getExpectedSession()) {
            setSessionError(resolveSessionErrorMessage());
            return;
          }
          router.push('/aggregate');
        }
      }

      if (!completed && typeof total === 'number') {
        saveKnowledgeData(
          { botVotesStatus: { status: 'pending', total } },
          omitUndefinedProperties({ expectedSessionId }),
        );
      }
    };
    const handleProgressRequestError = (requestError: unknown) => {
      if (!active) return;
      const errorCode = resolveApiClientErrorCode(requestError);
      if (isSessionUnavailableErrorCode(errorCode)) {
        clearProgressInterval(intervalRef);
        setSessionError(resolveSessionErrorMessage());
      }
    };
    const fetchProgress = async () => {
      if (!canFetchProgress()) return;
      inFlight = true;
      try {
        const sessionData = getExpectedSession();
        if (!sessionData) {
          setSessionError(resolveSessionErrorMessage());
          return;
        }

        let data;
        try {
          data = await getProgress(sessionData, { signal: controller.signal });
        } catch (requestError) {
          handleProgressRequestError(requestError);
          return;
        }

        if (!active) return;
        if (!getExpectedSession()) {
          setSessionError(resolveSessionErrorMessage());
          return;
        }

        applyProgress(data);
      } catch (error) {
        // Continue polling on error
        if (active) console.error('[BotVotingProgress] Poll error:', error);
      } finally {
        inFlight = false;
      }
    };

    void fetchProgress();
    intervalRef.current = setInterval(() => {
      void fetchProgress();
    }, 1000);

    return () => {
      active = false;
      controller.abort();
      clearProgressInterval(intervalRef);
    };
  }, [
    autoNavigate,
    expectedSessionId,
    getExpectedSession,
    onComplete,
    resolveSessionErrorMessage,
    router,
    sessionError,
  ]);

  if (sessionError) {
    return (
      <div className="bot-voting-progress">
        <InlineAlert message={sessionError} variant="error" />
      </div>
    );
  }

  return (
    <div className="bot-voting-progress">
      <h1>{t('pages.vote.botVoting.title')}</h1>
      <p role="status">{t('pages.vote.botVoting.processing')}</p>
    </div>
  );
}

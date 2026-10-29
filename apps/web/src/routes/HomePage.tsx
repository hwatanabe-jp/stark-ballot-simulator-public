'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { Badge } from '@stark-ballot/web/components/ui/Badge';
import { Infographic } from '@stark-ballot/web/components/home';
import { InfographicProblemSolution } from '@stark-ballot/web/components/home/InfographicProblemSolution';
import { HomeIllustration } from '@stark-ballot/web/components/home/HomeIllustration';
import '@stark-ballot/web/components/home/Home.css';
import { useTranslation } from '@stark-ballot/web/hooks';
import { initializeSession } from '@stark-ballot/web/session';
import { clearKnowledge, mergeKnowledgeFromApi } from '@stark-ballot/web/knowledge';
import { TurnstileWidget } from '@stark-ballot/web/components/security/TurnstileWidget';
import { isBrowserTurnstileRequiredForAction } from '@stark-ballot/web/components/security/turnstilePolicy';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import { createSession } from '@stark-ballot/web/api/sessions';
import { resolveApiClientErrorCode } from '@stark-ballot/web/api/client';

export default function HomePage(): React.ReactElement {
  const router = useAppRouter();
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<
    'errors.sessionLimitExceeded' | 'errors.captchaFailed' | 'errors.generic' | null
  >(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const sessionRequestControllerRef = useRef<AbortController | null>(null);
  const requireSessionTurnstile = isBrowserTurnstileRequiredForAction('session');

  useEffect(() => () => sessionRequestControllerRef.current?.abort(), []);

  const handleCreationError = (err: unknown) => {
    const errorCode = resolveApiClientErrorCode(err);
    if (errorCode === 'SESSION_LIMIT_EXCEEDED') {
      setErrorKey('errors.sessionLimitExceeded');
    } else if (errorCode === 'CAPTCHA_FAILED') {
      setErrorKey('errors.captchaFailed');
      setTurnstileToken(null);
    } else {
      console.error('Session creation error:', err);
      setErrorKey('errors.generic');
    }
  };

  const handleStart = async () => {
    if (sessionRequestControllerRef.current || (requireSessionTurnstile && !turnstileToken)) return;
    const controller = new AbortController();
    sessionRequestControllerRef.current = controller;
    setIsLoading(true);
    setErrorKey(null);

    try {
      const session = await createSession(turnstileToken ? { turnstileToken } : {}, { signal: controller.signal });
      if (controller.signal.aborted) return;

      const { sessionId, electionId, capabilityToken, electionConfigHash, logId } = session;

      // Reset stale knowledge artifacts before binding to the new session.
      clearKnowledge();

      initializeSession({
        sessionId,
        capabilityToken,
        electionId,
        electionConfigHash,
        logId,
      });

      // Save session data to the knowledge store.
      mergeKnowledgeFromApi(session);

      // Navigate to vote page
      router.push('/vote');
    } catch (err) {
      if (controller.signal.aborted) return;
      handleCreationError(err);
      sessionRequestControllerRef.current = null;
      setIsLoading(false);
    }
  };

  return (
    <div className="home-page">
      <div className="home-hero">
        <div className="home-introduction">
          <h1>{t('infographic.problemSolution.heading')}</h1>
          <p>{t('pages.home.description')}</p>
        </div>
        <HomeIllustration />
        <div className="home-start">
          {requireSessionTurnstile && (
            <div className="home-turnstile">
              <TurnstileWidget onTokenChange={setTurnstileToken} action="session" disabled={isLoading} />
            </div>
          )}
          <Button
            variant="verify"
            onClick={() => {
              void handleStart();
            }}
            disabled={isLoading || (requireSessionTurnstile && !turnstileToken)}
            loading={isLoading}
          >
            {isLoading ? t('common.loading') : t('common.start')}
          </Button>
          {errorKey && (
            <div className="home-error">
              <Badge variant="error" size="medium">
                {t(errorKey)}
              </Badge>
            </div>
          )}
        </div>
      </div>
      <InfographicProblemSolution />
      <Infographic />
    </div>
  );
}

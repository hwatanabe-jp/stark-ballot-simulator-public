'use client';

import { useState } from 'react';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { Badge } from '@stark-ballot/web/components/ui/Badge';
import { Infographic } from '@stark-ballot/web/components/home';
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
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const requireSessionTurnstile = isBrowserTurnstileRequiredForAction('session');

  const handleStart = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Create session on server
      let session;
      try {
        session = await createSession(turnstileToken ? { turnstileToken } : {});
      } catch (requestError) {
        const errorCode = resolveApiClientErrorCode(requestError);
        if (errorCode === 'SESSION_LIMIT_EXCEEDED') {
          setError(t('errors.sessionLimitExceeded'));
          setIsLoading(false);
          return;
        }
        if (errorCode === 'CAPTCHA_FAILED') {
          setError(t('errors.captchaFailed'));
          setTurnstileToken(null);
          setIsLoading(false);
          return;
        }
        throw requestError;
      }

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
      mergeKnowledgeFromApi('session', { ...session });

      // Navigate to vote page
      router.push('/vote');
    } catch (err) {
      console.error('Session creation error:', err);
      setError(t('errors.generic'));
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full">
      <section className="w-full px-4 md:px-6 pbs-4 pbe-12">
        {/* Title + Description (centered, narrow) */}
        <div className="max-w-2xl mx-auto text-center">
          {/* Title with Noto Serif JP */}
          <h1 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-ink-900 mb-6 tracking-[var(--tracking-display)] leading-[var(--leading-display)]">
            {t('pages.home.welcome')}
          </h1>

          {/* Description */}
          <p className="font-primary text-lg text-text-secondary leading-relaxed max-w-xl mx-auto">
            {t('pages.home.description')}
          </p>
        </div>

        {/* Infographic (centered, compact) */}
        <div className="max-w-3xl mx-auto mt-10">
          <Infographic />
        </div>

        {/* CTA (centered, narrow) */}
        <div className="max-w-2xl mx-auto mt-10 text-center">
          {requireSessionTurnstile && (
            <div className="max-w-sm mx-auto mb-6">
              <TurnstileWidget onTokenChange={setTurnstileToken} action="session" disabled={isLoading} />
            </div>
          )}

          {/* CTA Button with vermillion stamp style */}
          <Button
            variant="verify"
            onClick={() => {
              void handleStart();
            }}
            disabled={isLoading || (requireSessionTurnstile && !turnstileToken)}
            loading={isLoading}
            className="px-10 py-4 text-lg"
          >
            {isLoading ? t('common.loading') : t('common.start')}
          </Button>

          {/* Error Display */}
          {error && (
            <div className="mt-6 animate-fade-in">
              <Badge variant="error" size="medium">
                {error}
              </Badge>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Button } from '@stark-ballot/web/components/ui/Button';
import { Badge } from '@stark-ballot/web/components/ui/Badge';
import { Infographic } from '@stark-ballot/web/components/home';
import { useTranslation } from '@stark-ballot/web/hooks';
import { generateSessionId, saveSessionData } from '@stark-ballot/web/session';
import { clearKnowledge, mergeKnowledgeFromApi } from '@stark-ballot/web/knowledge';
import { resolveApiUrl } from '@stark-ballot/web/api/apiBaseUrl';
import { apiFetch } from '@stark-ballot/web/api/apiFetch';
import { TurnstileWidget } from '@stark-ballot/web/components/security/TurnstileWidget';
import { isBrowserTurnstileRequiredForAction } from '@stark-ballot/web/components/security/turnstilePolicy';
import { useAppRouter } from '@stark-ballot/web/navigation/appNavigation';
import { SessionResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import {
  admitApiResponse,
  readApiJson,
  readStandardApiError,
  readStandardApiErrorCode,
} from '@stark-ballot/web/api/responseAdmission';

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
      const response = await apiFetch(resolveApiUrl('/api/session'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(turnstileToken ? { turnstileToken } : {}),
      });

      if (!response.ok) {
        const errorPayload = await readStandardApiError(response);
        const errorCode = readStandardApiErrorCode(errorPayload);
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
        throw new Error('Failed to create session');
      }

      const payload = admitApiResponse(SessionResponseSchema, await readApiJson(response), 'session create response');
      const { sessionId, electionId, capabilityToken, contractGeneration, electionConfigHash, logId } = payload.data;

      // Generate local session with server-provided ID
      generateSessionId(sessionId, capabilityToken, contractGeneration);
      saveSessionData({
        sessionId,
        capabilityToken,
        contractGeneration,
        electionId,
        electionConfigHash,
        logId,
      });

      // Reset stale knowledge artifacts before binding to the new session.
      clearKnowledge();

      // Save session data to the knowledge store.
      mergeKnowledgeFromApi('session', { ...payload.data });

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

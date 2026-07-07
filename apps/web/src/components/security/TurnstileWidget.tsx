'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ComponentType, ReactElement, RefAttributes } from 'react';
import { Turnstile } from '@marsidev/react-turnstile';
import { useTranslation } from '@stark-ballot/web/hooks';
import { useCspNonce } from '@stark-ballot/web/components/security/CspNonceProvider';
import { readBrowserPublicEnv, readBrowserPublicFlag } from '@stark-ballot/runtime-config/env/browserPublic';

type TurnstileHandle = {
  reset?: () => void;
};

type TurnstileRenderer = ComponentType<
  {
    siteKey: string;
    onSuccess: (token: string) => void;
    onExpire: () => void;
    size?: 'compact' | 'normal' | 'flexible';
    options?: Record<string, unknown>;
    scriptOptions?: {
      nonce?: string;
    };
  } & RefAttributes<TurnstileHandle>
>;

type TurnstileWidgetProps = {
  onTokenChange: (token: string | null) => void;
  action: 'vote' | 'finalize' | 'session';
  disabled?: boolean;
};

const TOKEN_TTL_MS = 5 * 60 * 1000; // 300 seconds
const BUILD_TIME_BYPASS_ENABLED =
  import.meta.env['VITE_TURNSTILE_BYPASS'] === '1' || import.meta.env['VITE_TURNSTILE_BYPASS'] === 'true';
const BYPASS_TOKEN_PARTS = ['turnstile', 'bypass', 'token'] as const;

function isTurnstileBypassEnabled(): boolean {
  if (import.meta.env.MODE === 'test') {
    return readBrowserPublicFlag('VITE_TURNSTILE_BYPASS');
  }
  return BUILD_TIME_BYPASS_ENABLED;
}

function buildTurnstileBypassToken(): string {
  return BYPASS_TOKEN_PARTS.join('-');
}

export function TurnstileWidget({
  onTokenChange,
  action,
  disabled = false,
}: TurnstileWidgetProps): ReactElement | null {
  const { t } = useTranslation();
  const [, setToken] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnstileRef = useRef<TurnstileHandle | null>(null);
  const bypassEnabled = isTurnstileBypassEnabled();
  const siteKey = readBrowserPublicEnv('VITE_TURNSTILE_SITE_KEY');
  const cspNonce = useCspNonce();
  const [TurnstileComponent] = useState<TurnstileRenderer>(() => Turnstile as TurnstileRenderer);

  const resetTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setExpired(true);
      setToken(null);
      onTokenChange(null);
    }, TOKEN_TTL_MS);
  }, [onTokenChange]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleSuccess = useCallback(
    (newToken: string) => {
      setToken(newToken);
      setExpired(false);
      onTokenChange(newToken);
      resetTimer();
    },
    [onTokenChange, resetTimer],
  );

  const handleExpire = useCallback(() => {
    setExpired(true);
    setToken(null);
    onTokenChange(null);
  }, [onTokenChange]);

  const resetWidget = useCallback(() => {
    if (turnstileRef.current?.reset) {
      try {
        turnstileRef.current.reset();
      } catch (error) {
        console.warn('[TurnstileWidget] Failed to reset widget', error);
      }
    }
  }, []);

  useEffect(() => {
    if (bypassEnabled) {
      onTokenChange(buildTurnstileBypassToken());
    }
  }, [bypassEnabled, onTokenChange]);

  useEffect(() => {
    if (!expired) {
      return;
    }
    resetWidget();
  }, [expired, resetWidget]);

  if (bypassEnabled) {
    return (
      <div
        className="rounded-md border border-dashed border-paper-border bg-paper-cream p-3 text-sm text-text-secondary"
        aria-live="polite"
      >
        {t('security.turnstileBypassed')}
      </div>
    );
  }

  if (!siteKey) {
    return null;
  }

  return (
    <div className="space-y-2" aria-live="polite" aria-busy={disabled}>
      <TurnstileComponent
        ref={turnstileRef}
        siteKey={siteKey}
        onSuccess={handleSuccess}
        onExpire={handleExpire}
        size="flexible"
        {...(cspNonce ? { scriptOptions: { nonce: cspNonce } } : {})}
        options={{
          action,
        }}
      />
      {expired && (
        <p className="text-sm text-text-muted" data-testid="turnstile-expired">
          {t('security.turnstileExpired')}
        </p>
      )}
    </div>
  );
}

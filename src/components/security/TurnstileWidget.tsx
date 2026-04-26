'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ComponentType, ReactElement, RefAttributes } from 'react';
import dynamic from 'next/dynamic';
import { useTranslation } from '@/lib/hooks';
import { useCspNonce } from '@/components/security/CspNonceProvider';

const Turnstile = dynamic(() => import('@marsidev/react-turnstile').then((mod) => mod.Turnstile), {
  ssr: false,
});

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

const getTurnstileComponent = (): TurnstileRenderer => {
  const override = (globalThis as { __TEST_TURNSTILE__?: TurnstileRenderer }).__TEST_TURNSTILE__;
  return override ?? (Turnstile as TurnstileRenderer);
};

type TurnstileWidgetProps = {
  onTokenChange: (token: string | null) => void;
  action: 'vote' | 'finalize' | 'session';
  disabled?: boolean;
};

const TOKEN_TTL_MS = 5 * 60 * 1000; // 300 seconds

export function TurnstileWidget({
  onTokenChange,
  action,
  disabled = false,
}: TurnstileWidgetProps): ReactElement | null {
  const { t } = useTranslation();
  const [, setToken] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const turnstileRef = useRef<TurnstileHandle | null>(null);
  const bypassEnabled = process.env.NEXT_PUBLIC_TURNSTILE_BYPASS === '1';
  const cspNonce = useCspNonce();
  const [TurnstileComponent] = useState<TurnstileRenderer>(() => getTurnstileComponent());

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
      onTokenChange('turnstile-bypass-token');
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

  if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    return null;
  }

  return (
    <div className="space-y-2" aria-live="polite" aria-busy={disabled}>
      <TurnstileComponent
        ref={turnstileRef}
        siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
        onSuccess={handleSuccess}
        onExpire={handleExpire}
        size="flexible"
        scriptOptions={cspNonce ? { nonce: cspNonce } : undefined}
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

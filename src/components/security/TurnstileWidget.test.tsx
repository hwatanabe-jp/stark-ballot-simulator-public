import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import type { ComponentType, RefAttributes } from 'react';
import type { Mock } from 'vitest';
import { TurnstileWidget } from './TurnstileWidget';
import { CspNonceProvider } from './CspNonceProvider';

type MockTurnstileProps = {
  siteKey: string;
  onSuccess: (token: string) => void;
  onExpire: () => void;
  size?: 'compact' | 'normal' | 'flexible';
  options?: Record<string, unknown>;
  scriptOptions?: {
    nonce?: string;
  };
};

type MockTurnstileHandle = {
  reset: () => void;
};

declare global {
  var __TEST_TURNSTILE__: ComponentType<MockTurnstileProps & RefAttributes<MockTurnstileHandle>> | undefined;
}

vi.mock('@/lib/hooks', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const originalEnv = { ...process.env };

describe('TurnstileWidget', () => {
  let resetMock: Mock<() => void>;
  let latestProps: MockTurnstileProps | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, originalEnv);
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
    delete process.env.NEXT_PUBLIC_TURNSTILE_BYPASS;
    resetMock = vi.fn<() => void>();
    latestProps = null;
    const MockTurnstile = forwardRef<MockTurnstileHandle, MockTurnstileProps>((props, ref) => {
      const { onSuccess, onExpire } = props;
      const handleReset = () => resetMock();
      useImperativeHandle(ref, () => ({
        reset: handleReset,
      }));
      useEffect(() => {
        latestProps = props;
      }, [props]);

      return (
        <div>
          <button onClick={() => onSuccess('mock-token')}>success</button>
          <button onClick={() => onExpire()}>expire</button>
        </div>
      );
    });
    MockTurnstile.displayName = 'MockTurnstile';
    globalThis.__TEST_TURNSTILE__ = MockTurnstile;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    delete globalThis.__TEST_TURNSTILE__;
  });

  it('calls onTokenChange when Turnstile succeeds', async () => {
    const onTokenChange = vi.fn();
    render(<TurnstileWidget action="vote" onTokenChange={onTokenChange} />);

    await waitFor(() => screen.getByText('success'));
    fireEvent.click(screen.getByText('success'));

    await waitFor(() => {
      expect(onTokenChange).toHaveBeenCalledWith('mock-token');
    });
  });

  it('notifies expiration and clears token', async () => {
    const onTokenChange = vi.fn();
    render(<TurnstileWidget action="vote" onTokenChange={onTokenChange} />);

    fireEvent.click(screen.getByText('expire'));

    await waitFor(() => {
      expect(onTokenChange).toHaveBeenLastCalledWith(null);
    });
  });

  it('resets widget when token expires', async () => {
    const onTokenChange = vi.fn();
    render(<TurnstileWidget action="vote" onTokenChange={onTokenChange} />);

    fireEvent.click(screen.getByText('expire'));

    await waitFor(() => {
      expect(resetMock).toHaveBeenCalled();
    });
  });

  it('shows bypass banner and auto emits token when bypass enabled', () => {
    process.env.NEXT_PUBLIC_TURNSTILE_BYPASS = '1';
    const onTokenChange = vi.fn();
    render(<TurnstileWidget action="vote" onTokenChange={onTokenChange} />);

    expect(screen.getByText('security.turnstileBypassed')).toBeInTheDocument();
    expect(onTokenChange).toHaveBeenCalledWith('turnstile-bypass-token');
  });

  it('passes nonce to script options when provided', async () => {
    const onTokenChange = vi.fn();
    render(
      <CspNonceProvider nonce="test-nonce">
        <TurnstileWidget action="vote" onTokenChange={onTokenChange} />
      </CspNonceProvider>,
    );

    await waitFor(() => screen.getByText('success'));

    expect(latestProps?.scriptOptions?.nonce).toBe('test-nonce');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Mock } from 'vitest';
import { TurnstileWidget } from './TurnstileWidget';
import { CspNonceProvider } from './CspNonceProvider';
import {
  clearPublicRuntimeEnvForTests,
  setPublicRuntimeEnvForTests,
} from '@stark-ballot/runtime-config/env/public-runtime-config';

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

const turnstileMockState = vi.hoisted(() => ({
  latestProps: null as MockTurnstileProps | null,
  resetMock: vi.fn<() => void>(),
}));

vi.mock('@marsidev/react-turnstile', async () => {
  const React = await import('react');
  const MockTurnstile = React.forwardRef<MockTurnstileHandle, MockTurnstileProps>((props, ref) => {
    const { onSuccess, onExpire } = props;
    React.useImperativeHandle(ref, () => ({
      reset: () => turnstileMockState.resetMock(),
    }));
    React.useEffect(() => {
      turnstileMockState.latestProps = props;
    }, [props]);

    return React.createElement(
      'div',
      null,
      React.createElement('button', { onClick: () => onSuccess('mock-token') }, 'success'),
      React.createElement('button', { onClick: () => onExpire() }, 'expire'),
    );
  });
  MockTurnstile.displayName = 'MockTurnstile';
  return { Turnstile: MockTurnstile };
});

vi.mock('@stark-ballot/web/hooks', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('TurnstileWidget', () => {
  let resetMock: Mock<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', 'target-aws-async');
    setPublicRuntimeEnvForTests('VITE_APP_ENV', 'main');
    setPublicRuntimeEnvForTests('VITE_TURNSTILE_SITE_KEY', 'site-key');
    resetMock = turnstileMockState.resetMock;
    resetMock.mockClear();
    turnstileMockState.latestProps = null;
  });

  afterEach(() => {
    clearPublicRuntimeEnvForTests();
    vi.unstubAllEnvs();
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
    clearPublicRuntimeEnvForTests();
    setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', 'local-demo');
    setPublicRuntimeEnvForTests('VITE_TURNSTILE_SITE_KEY', 'site-key');
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

    expect(turnstileMockState.latestProps?.scriptOptions?.nonce).toBe('test-nonce');
  });
});

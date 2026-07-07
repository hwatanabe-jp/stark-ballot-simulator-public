import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, useRef } from 'react';
import { VoteForm } from './VoteForm';
import { generateCommitment } from '@stark-ballot/web/vote/commitment';
import { getSessionAuthHeaders, getSessionData } from '@stark-ballot/web/session';
import { apiFetch } from '@stark-ballot/web/api/apiFetch';
import {
  clearBrowserPublicEnvForTests,
  setBrowserPublicEnvForTests,
} from '@stark-ballot/runtime-config/env/browserPublic';

const turnstileMockState = vi.hoisted(() => ({
  emitToken: true,
}));

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

vi.mock('@stark-ballot/web/hooks', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@stark-ballot/web/components/security/TurnstileWidget', () => ({
  TurnstileWidget: ({
    onTokenChange,
    disabled,
  }: {
    onTokenChange: (token: string | null) => void;
    disabled?: boolean;
  }) => {
    const didEmitRef = useRef(false);
    useEffect(() => {
      if (!disabled && !didEmitRef.current && turnstileMockState.emitToken) {
        didEmitRef.current = true;
        onTokenChange('turnstile-token');
      }
    }, [disabled, onTokenChange]);
    return <div data-testid="turnstile-widget" />;
  },
}));

vi.mock('@stark-ballot/web/vote/commitment', () => ({
  generateCommitment: vi.fn(),
}));

vi.mock('@stark-ballot/web/session', () => ({
  getSessionAuthHeaders: vi.fn(),
  getSessionData: vi.fn(),
  saveSessionData: vi.fn(),
}));

vi.mock('@stark-ballot/web/knowledge', () => ({
  saveKnowledgeData: vi.fn(),
}));

vi.mock('@stark-ballot/web/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@stark-ballot/web/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

describe('VoteForm', () => {
  const onVoteComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    turnstileMockState.emitToken = true;
    setBrowserPublicEnvForTests('VITE_SESSION_CREATE_TURNSTILE_REQUIRED', 'true');
    vi.mocked(getSessionData).mockReturnValue({
      sessionId: 'session-123',
      capabilityToken: 'test-capability-token',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      lastActivity: Date.now(),
    });
    vi.mocked(getSessionAuthHeaders).mockReturnValue({
      'X-Session-ID': 'session-123',
      'X-Session-Capability': 'test-capability-token',
    });
    vi.mocked(generateCommitment).mockResolvedValue({
      commitment: '0x' + '1'.repeat(64),
      randomValue: '0x' + '2'.repeat(64),
    });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            voteId: '550e8400-e29b-41d4-a716-446655440000',
            commitment: '0x' + '1'.repeat(64),
            bulletinIndex: 1,
            bulletinRootAtCast: '0x' + '1'.repeat(64),
            timestamp: 1234567890,
          },
        }),
    } as Response);
  });

  afterEach(() => {
    clearBrowserPublicEnvForTests();
  });

  it('keeps submit button disabled after successful vote submission', async () => {
    const user = userEvent.setup();
    render(<VoteForm onVoteComplete={onVoteComplete} />);

    await user.click(screen.getByTestId('vote-option-A'));

    const submitButton = screen.getByTestId('submit-vote');
    await waitFor(() => expect(submitButton).toBeEnabled());

    await user.click(submitButton);

    await waitFor(() => {
      expect(onVoteComplete).toHaveBeenCalled();
    });

    expect(screen.getByTestId('submit-vote')).toBeDisabled();
  });

  it('scrolls to the bottom after selecting a vote option', async () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const user = userEvent.setup();

    try {
      render(<VoteForm onVoteComplete={onVoteComplete} />);

      await user.click(screen.getByTestId('vote-option-A'));

      await waitFor(() => {
        expect(scrollToSpy).toHaveBeenCalled();
      });
    } finally {
      scrollToSpy.mockRestore();
    }
  });

  it('allows operator-gated develop vote submission without a browser Turnstile token', async () => {
    const user = userEvent.setup();
    turnstileMockState.emitToken = false;
    setBrowserPublicEnvForTests('VITE_SESSION_CREATE_TURNSTILE_REQUIRED', 'false');

    render(<VoteForm onVoteComplete={onVoteComplete} />);

    await user.click(screen.getByTestId('vote-option-A'));

    const submitButton = screen.getByTestId('submit-vote');
    await waitFor(() => expect(submitButton).toBeEnabled());
    expect(screen.queryByTestId('turnstile-widget')).not.toBeInTheDocument();

    await user.click(submitButton);

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalled();
    });
    const calls = vi.mocked(apiFetch).mock.calls as unknown;
    const firstCall = isUnknownArray(calls) ? calls.at(0) : undefined;
    expect(isUnknownArray(firstCall)).toBe(true);
    const [url, requestInit] = firstCall as [unknown, { body?: unknown }];
    expect(url).toBe('/api/vote');
    expect(typeof requestInit.body).toBe('string');
    if (typeof requestInit.body !== 'string') {
      throw new Error('Expected vote request body to be a JSON string.');
    }
    expect(JSON.parse(requestInit.body)).not.toHaveProperty('turnstileToken');
  });
});

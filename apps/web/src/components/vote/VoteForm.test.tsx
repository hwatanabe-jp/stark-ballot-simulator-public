import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, useRef } from 'react';
import { VoteForm } from './VoteForm';
import { generateCommitment } from '@stark-ballot/web/vote/commitment';
import {
  captureSessionIdentity,
  getSessionData,
  getSessionDataForIdentity,
  saveSessionDataForIdentity,
} from '@stark-ballot/web/session';
import { submitVote } from '@stark-ballot/web/api/votes';
import {
  clearPublicRuntimeEnvForTests,
  setPublicRuntimeEnvForTests,
} from '@stark-ballot/runtime-config/env/public-runtime-config';

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
  captureSessionIdentity: vi.fn(),
  getSessionData: vi.fn(),
  getSessionDataForIdentity: vi.fn(),
  saveSessionDataForIdentity: vi.fn(),
}));

vi.mock('@stark-ballot/web/knowledge', () => ({
  saveKnowledgeData: vi.fn(),
}));

vi.mock('@stark-ballot/web/api/votes', () => ({
  submitVote: vi.fn(),
}));

describe('VoteForm', () => {
  const onVoteComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    turnstileMockState.emitToken = true;
    setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', 'target-aws-async');
    setPublicRuntimeEnvForTests('VITE_APP_ENV', 'main');
    const sessionData = {
      ...admitSessionIdentity({ sessionId: 'session-123', capabilityToken: 'test-capability-token' }),
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: `0x${'a'.repeat(64)}`,
      logId: `0x${'b'.repeat(64)}`,
      lastActivity: Date.now(),
      expiresAt: Date.now() + 60_000,
      phase: 'voting',
    } as const;
    vi.mocked(getSessionData).mockReturnValue(sessionData);
    vi.mocked(captureSessionIdentity).mockReturnValue({
      sessionId: sessionData.sessionId,
      capabilityToken: sessionData.capabilityToken,
    });
    vi.mocked(getSessionDataForIdentity).mockReturnValue(sessionData);
    vi.mocked(generateCommitment).mockResolvedValue({
      commitment: '0x' + '1'.repeat(64),
      randomValue: '0x' + '2'.repeat(64),
    });
    vi.mocked(submitVote).mockResolvedValue({
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commitment: '0x' + '1'.repeat(64),
      bulletinIndex: 1,
      bulletinRootAtCast: '0x' + '1'.repeat(64),
      castAtMs: 1234567890,
    });
  });

  afterEach(() => {
    clearPublicRuntimeEnvForTests();
  });

  it('reuses the opening after an uncertain response and obtains a fresh CAPTCHA', async () => {
    const user = userEvent.setup();
    vi.mocked(submitVote).mockRejectedValueOnce(new Error('Network error'));
    render(<VoteForm onVoteComplete={onVoteComplete} />);
    await user.click(screen.getByTestId('vote-option-A'));
    await user.click(screen.getByTestId('submit-vote'));
    await waitFor(() => expect(screen.getByTestId('submit-vote')).toBeEnabled());
    expect(screen.getByTestId('vote-option-B').querySelector('input')).toBeDisabled();
    await user.click(screen.getByTestId('submit-vote'));
    await waitFor(() => expect(onVoteComplete).toHaveBeenCalledTimes(1));
    expect(generateCommitment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitVote).mock.calls[1]?.[1]).toEqual(vi.mocked(submitVote).mock.calls[0]?.[1]);
  });

  it('replays the saved opening after reload without generating another commitment', async () => {
    const user = userEvent.setup();
    const saved = getSessionData();
    if (!saved) throw new Error('Expected session');
    vi.mocked(getSessionDataForIdentity).mockReturnValue({
      ...saved,
      myVote: 'A',
      myCommit: `0x${'1'.repeat(64)}`,
      myRand: `0x${'2'.repeat(64)}`,
    });
    render(<VoteForm onVoteComplete={onVoteComplete} />);
    await waitFor(() => expect(screen.getByTestId('submit-vote')).toBeEnabled());
    await user.click(screen.getByTestId('submit-vote'));
    await waitFor(() => expect(onVoteComplete).toHaveBeenCalledTimes(1));
    expect(generateCommitment).not.toHaveBeenCalled();
    expect(submitVote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ vote: 'A', commitment: `0x${'1'.repeat(64)}`, rand: `0x${'2'.repeat(64)}` }),
      expect.anything(),
    );
  });

  it('rejects a response bound to another opening', async () => {
    const user = userEvent.setup();
    vi.mocked(submitVote).mockResolvedValueOnce({
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commitment: `0x${'3'.repeat(64)}`,
      bulletinIndex: 0,
      bulletinRootAtCast: `0x${'4'.repeat(64)}`,
      castAtMs: 10,
    });
    render(<VoteForm onVoteComplete={onVoteComplete} />);
    await user.click(screen.getByTestId('vote-option-A'));
    await user.click(screen.getByTestId('submit-vote'));
    await screen.findByText('errors.generic');
    expect(onVoteComplete).not.toHaveBeenCalled();
    expect(saveSessionDataForIdentity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ voteId: expect.anything() }),
    );
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

  it('keeps the current scroll position after selecting a vote option', async () => {
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const user = userEvent.setup();

    try {
      render(<VoteForm onVoteComplete={onVoteComplete} />);

      await user.click(screen.getByTestId('vote-option-A'));

      expect(screen.getByTestId('vote-option-A').querySelector('input')).toBeChecked();
      expect(scrollToSpy).not.toHaveBeenCalled();
    } finally {
      scrollToSpy.mockRestore();
    }
  });

  it('does not submit after leaving while commitment generation is pending', async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof generateCommitment>>>();
    vi.mocked(generateCommitment).mockReturnValue(pending.promise);
    const { unmount } = render(<VoteForm onVoteComplete={onVoteComplete} />);
    await user.click(screen.getByTestId('vote-option-A'));
    await user.click(screen.getByTestId('submit-vote'));
    unmount();

    await act(async () => {
      pending.resolve({ commitment: `0x${'1'.repeat(64)}`, randomValue: `0x${'2'.repeat(64)}` });
    });
    expect(submitVote).not.toHaveBeenCalled();
    expect(saveSessionDataForIdentity).not.toHaveBeenCalled();
    expect(onVoteComplete).not.toHaveBeenCalled();
  });

  it('aborts the request and ignores a late vote response after leaving', async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof submitVote>>>();
    vi.mocked(submitVote).mockReturnValue(pending.promise);
    const { unmount } = render(<VoteForm onVoteComplete={onVoteComplete} />);
    await user.click(screen.getByTestId('vote-option-A'));
    await user.click(screen.getByTestId('submit-vote'));
    const signal = vi.mocked(submitVote).mock.calls[0]?.[2]?.signal;
    expect(saveSessionDataForIdentity).toHaveBeenCalledOnce();
    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      pending.resolve({
        voteId: '550e8400-e29b-41d4-a716-446655440000',
        commitment: `0x${'1'.repeat(64)}`,
        bulletinIndex: 1,
        bulletinRootAtCast: `0x${'1'.repeat(64)}`,
        castAtMs: 1234567890,
      });
    });
    expect(saveSessionDataForIdentity).toHaveBeenCalledOnce();
    expect(onVoteComplete).not.toHaveBeenCalled();
  });

  it('allows operator-gated develop vote submission without a browser Turnstile token', async () => {
    const user = userEvent.setup();
    turnstileMockState.emitToken = false;
    clearPublicRuntimeEnvForTests();
    setPublicRuntimeEnvForTests('VITE_RUNTIME_PROFILE', 'target-aws-async');
    setPublicRuntimeEnvForTests('VITE_APP_ENV', 'develop');

    render(<VoteForm onVoteComplete={onVoteComplete} />);

    await user.click(screen.getByTestId('vote-option-A'));

    const submitButton = screen.getByTestId('submit-vote');
    await waitFor(() => expect(submitButton).toBeEnabled());
    expect(screen.queryByTestId('turnstile-widget')).not.toBeInTheDocument();

    await user.click(submitButton);

    await waitFor(() => {
      expect(submitVote).toHaveBeenCalled();
    });
    const calls = vi.mocked(submitVote).mock.calls as unknown;
    const firstCall = isUnknownArray(calls) ? calls.at(0) : undefined;
    expect(isUnknownArray(firstCall)).toBe(true);
    const [, request] = firstCall as [unknown, Record<string, unknown>];
    expect(request).not.toHaveProperty('turnstileToken');
  });

  it('does not adopt a replacement session after the form mounts', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    render(<VoteForm onVoteComplete={onVoteComplete} onError={onError} />);

    vi.mocked(getSessionData).mockReturnValue({
      ...admitSessionIdentity({ sessionId: 'replacement-session', capabilityToken: 'replacement-capability' }),
      electionId: '550e8400-e29b-41d4-a716-446655440001',
      electionConfigHash: `0x${'c'.repeat(64)}`,
      logId: `0x${'d'.repeat(64)}`,
      lastActivity: Date.now(),
      expiresAt: Date.now() + 60_000,
      phase: 'voting',
    });
    vi.mocked(getSessionDataForIdentity).mockReturnValue(null);

    await user.click(screen.getByTestId('vote-option-A'));
    await user.click(screen.getByTestId('submit-vote'));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('errors.generic'));
    expect(submitVote).not.toHaveBeenCalled();
    expect(getSessionData).not.toHaveBeenCalled();
    expect(saveSessionDataForIdentity).not.toHaveBeenCalled();
    expect(onVoteComplete).not.toHaveBeenCalled();
  });

  it('does not submit a vote when the mounted session is replaced while commitment generation is pending', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const pendingCommitment = Promise.withResolvers<Awaited<ReturnType<typeof generateCommitment>>>();
    vi.mocked(generateCommitment).mockReturnValue(pendingCommitment.promise);

    render(<VoteForm onVoteComplete={onVoteComplete} onError={onError} />);

    await user.click(screen.getByTestId('vote-option-A'));
    await user.click(screen.getByTestId('submit-vote'));
    await waitFor(() => expect(generateCommitment).toHaveBeenCalledOnce());

    vi.mocked(getSessionDataForIdentity).mockReturnValue(null);
    pendingCommitment.resolve({
      commitment: `0x${'1'.repeat(64)}`,
      randomValue: `0x${'2'.repeat(64)}`,
    });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('errors.generic'));
    expect(saveSessionDataForIdentity).not.toHaveBeenCalled();
    expect(submitVote).not.toHaveBeenCalled();
    expect(onVoteComplete).not.toHaveBeenCalled();
  });

  it('does not complete a vote when the mounted session is replaced while submission is pending', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const pendingSubmission = Promise.withResolvers<Awaited<ReturnType<typeof submitVote>>>();
    vi.mocked(submitVote).mockReturnValue(pendingSubmission.promise);

    render(<VoteForm onVoteComplete={onVoteComplete} onError={onError} />);

    await user.click(screen.getByTestId('vote-option-A'));
    await user.click(screen.getByTestId('submit-vote'));
    await waitFor(() => expect(submitVote).toHaveBeenCalledOnce());

    vi.mocked(getSessionDataForIdentity).mockReturnValue(null);
    pendingSubmission.resolve({
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commitment: `0x${'1'.repeat(64)}`,
      bulletinIndex: 1,
      bulletinRootAtCast: `0x${'1'.repeat(64)}`,
      castAtMs: 1234567890,
    });

    await waitFor(() => expect(onError).toHaveBeenCalledWith('errors.generic'));
    expect(saveSessionDataForIdentity).toHaveBeenCalledOnce();
    expect(onVoteComplete).not.toHaveBeenCalled();
  });
});

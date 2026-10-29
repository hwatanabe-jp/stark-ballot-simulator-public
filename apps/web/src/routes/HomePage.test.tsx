import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '@stark-ballot/web/api/sessions';
import { resolveApiClientErrorCode } from '@stark-ballot/web/api/client';
import { initializeSession } from '@stark-ballot/web/session';
import { clearKnowledge, mergeKnowledgeFromApi } from '@stark-ballot/web/knowledge';
import sessionFixture from '@stark-ballot/web/mock-api/fixtures/json/sessions.post.json';
import HomePage from './HomePage';

const { push, locale } = vi.hoisted(() => ({ push: vi.fn(), locale: { value: 'ja' } }));

vi.mock('@stark-ballot/web/navigation/appNavigation', () => ({ useAppRouter: () => ({ push }) }));
vi.mock('@stark-ballot/web/hooks', () => ({
  useTranslation: () => ({ t: (key: string) => `${locale.value}:${key}` }),
}));
vi.mock('@stark-ballot/web/api/sessions', () => ({ createSession: vi.fn() }));
vi.mock('@stark-ballot/web/api/client', () => ({ resolveApiClientErrorCode: vi.fn() }));
vi.mock('@stark-ballot/web/session', () => ({ initializeSession: vi.fn() }));
vi.mock('@stark-ballot/web/knowledge', () => ({ clearKnowledge: vi.fn(), mergeKnowledgeFromApi: vi.fn() }));
vi.mock('@stark-ballot/web/components/security/turnstilePolicy', () => ({
  isBrowserTurnstileRequiredForAction: () => false,
}));
vi.mock('@stark-ballot/web/components/security/TurnstileWidget', () => ({ TurnstileWidget: () => null }));

describe('HomePage session creation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    locale.value = 'ja';
  });

  it('admits one completed request before navigating to vote', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof createSession>>>();
    vi.mocked(createSession).mockReturnValue(pending.promise);
    render(<HomePage />);
    const start = screen.getByRole('button', { name: 'ja:common.start' });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(createSession).toHaveBeenCalledOnce();
    expect(start).toBeDisabled();

    await act(async () => pending.resolve({ ...sessionFixture.data, ...admitSessionIdentity(sessionFixture.data) }));

    expect(clearKnowledge).toHaveBeenCalledOnce();
    expect(initializeSession).toHaveBeenCalledOnce();
    expect(mergeKnowledgeFromApi).toHaveBeenCalledWith({
      ...sessionFixture.data,
      ...admitSessionIdentity(sessionFixture.data),
    });
    expect(push).toHaveBeenCalledWith('/vote');
    expect(start).toBeDisabled();
  });

  it('aborts on unmount and ignores a late session response', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof createSession>>>();
    vi.mocked(createSession).mockReturnValue(pending.promise);
    const { unmount } = render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'ja:common.start' }));
    const signal = vi.mocked(createSession).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => pending.resolve({ ...sessionFixture.data, ...admitSessionIdentity(sessionFixture.data) }));

    expect(initializeSession).not.toHaveBeenCalled();
    expect(clearKnowledge).not.toHaveBeenCalled();
    expect(mergeKnowledgeFromApi).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it.each([
    ['SESSION_LIMIT_EXCEEDED', 'sessionLimitExceeded'],
    ['CAPTCHA_FAILED', 'captchaFailed'],
  ])('allows retry after %s and translates the current error after a language change', async (code, key) => {
    vi.mocked(createSession)
      .mockRejectedValueOnce(new Error(code))
      .mockResolvedValueOnce({ ...sessionFixture.data, ...admitSessionIdentity(sessionFixture.data) });
    vi.mocked(resolveApiClientErrorCode).mockReturnValue(code);
    const { rerender } = render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: 'ja:common.start' }));
    await screen.findByText(`ja:errors.${key}`);
    locale.value = 'en';
    rerender(<HomePage />);
    expect(screen.getByText(`en:errors.${key}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'en:common.start' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/vote'));
    expect(createSession).toHaveBeenCalledTimes(2);
  });
});

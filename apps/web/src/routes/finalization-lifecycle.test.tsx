import { admitSessionIdentity } from '@stark-ballot/web/session/identity';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizationResource } from '@stark-ballot/api-contract/schemas/finalizations';
import type { SessionData } from '@stark-ballot/web/session/types';
import { ApiClientError } from '@stark-ballot/web/api/client';
import { fetchCurrentFinalization, startFinalization } from '@stark-ballot/web/api/finalizations';
import {
  captureSessionIdentity,
  clearSession,
  getSessionData,
  getSessionDataForIdentity,
  isSessionReplacedForIdentity,
  saveSessionDataForIdentity,
} from '@stark-ballot/web/session';
import { clearKnowledgeForSession, mergeKnowledgeFromApi } from '@stark-ballot/web/knowledge';
import AggregatePage from './aggregate/page';
import ResultPage from './result/page';

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn() },
  translate: (key: string): string => key,
}));

vi.mock('@stark-ballot/web/hooks', () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));
vi.mock('@stark-ballot/web/navigation/appNavigation', () => ({
  useAppRouter: () => mocks.router,
}));
vi.mock('@stark-ballot/web/components/security/turnstilePolicy', () => ({
  isBrowserTurnstileRequiredForAction: () => false,
}));
vi.mock('@stark-ballot/web/session', () => ({
  captureSessionIdentity: vi.fn(),
  clearSession: vi.fn(),
  getSessionData: vi.fn(),
  getSessionDataForIdentity: vi.fn(),
  isSessionReplacedForIdentity: vi.fn(),
  isSessionReplaced: vi.fn(() => false),
  saveSessionData: vi.fn(),
  saveSessionDataForIdentity: vi.fn(),
  SESSION_STORAGE_KEY: 'starkBallotSession',
}));
vi.mock('@stark-ballot/web/knowledge', () => ({
  clearKnowledge: vi.fn(),
  clearKnowledgeForSession: vi.fn(),
  getKnowledgeValue: vi.fn(() => null),
  mergeKnowledgeFromApi: vi.fn(),
  saveKnowledgeData: vi.fn(),
  VERIFICATION_GATED_KEYS: [],
}));
vi.mock('@stark-ballot/web/api/finalizations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stark-ballot/web/api/finalizations')>()),
  fetchCurrentFinalization: vi.fn(),
  startFinalization: vi.fn(),
}));
vi.mock('@stark-ballot/web/verification/stark-verification-polling', () => ({
  startStarkVerificationPolling: vi.fn(),
}));

const session: SessionData = {
  ...admitSessionIdentity({ sessionId: 'session-1', capabilityToken: 'capability-1' }),
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: `0x${'a'.repeat(64)}`,
  logId: `0x${'b'.repeat(64)}`,
  lastActivity: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  phase: 'finalizing',
};
const identity = { sessionId: session.sessionId, capabilityToken: session.capabilityToken };
const pendingResource: FinalizationResource = {
  finalizationId: 'finalization-1',
  queuedAtMs: 1,
  status: 'pending',
  runtimeDiagnostics: { asyncMode: 'enabled' },
};
function failedResource(message: string): FinalizationResource {
  return {
    finalizationId: 'finalization-1',
    queuedAtMs: 1,
    status: 'failed',
    failedAtMs: 2,
    runtimeDiagnostics: { asyncMode: 'disabled' },
    error: { code: 'FINALIZATION_FAILED', message },
  };
}
function missingSessionError(): ApiClientError {
  return new ApiClientError('missing', 404, {
    error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
    meta: { requestId: 'request-1' },
  });
}
function replaceSession(): void {
  vi.mocked(getSessionData).mockReturnValue({
    ...session,
    ...admitSessionIdentity({ sessionId: 'session-2', capabilityToken: 'capability-2' }),
  });
  vi.mocked(getSessionDataForIdentity).mockReturnValue(null);
  vi.mocked(isSessionReplacedForIdentity).mockReturnValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.translate = (key: string) => key;
  vi.mocked(captureSessionIdentity).mockReturnValue(identity);
  vi.mocked(getSessionData).mockReturnValue(session);
  vi.mocked(getSessionDataForIdentity).mockReturnValue(session);
  vi.mocked(isSessionReplacedForIdentity).mockReturnValue(false);
  vi.mocked(fetchCurrentFinalization).mockResolvedValue(null);
});

describe('ResultPage request lifecycle', () => {
  it('aborts on unmount and ignores a late terminal resource without clearing stored evidence', async () => {
    const pending = Promise.withResolvers<FinalizationResource | null>();
    vi.mocked(fetchCurrentFinalization).mockReturnValue(pending.promise);
    const { unmount } = render(<ResultPage />);
    const signal = vi.mocked(fetchCurrentFinalization).mock.calls[0]?.[1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => pending.resolve(failedResource('Late failure')));
    expect(clearKnowledgeForSession).not.toHaveBeenCalled();
    expect(saveSessionDataForIdentity).not.toHaveBeenCalled();
    expect(mergeKnowledgeFromApi).not.toHaveBeenCalled();
  });

  it('preserves a replacement session when an older request reports session loss', async () => {
    const pending = Promise.withResolvers<FinalizationResource | null>();
    vi.mocked(fetchCurrentFinalization).mockReturnValue(pending.promise);
    render(<ResultPage />);
    replaceSession();
    await act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'starkBallotSession' })));
    expect(screen.getByRole('alert')).toHaveTextContent('pages.result.errors.sessionReplaced');

    await act(async () => pending.reject(missingSessionError()));
    expect(clearSession).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('pages.result.errors.sessionReplaced');
  });

  it('ignores the previous request after a language change starts a replacement request', async () => {
    const pending = Promise.withResolvers<FinalizationResource | null>();
    vi.mocked(fetchCurrentFinalization)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(failedResource('Current failure'));
    const { rerender } = render(<ResultPage />);
    const signal = vi.mocked(fetchCurrentFinalization).mock.calls[0]?.[1]?.signal;
    mocks.translate = (key: string) => `translated:${key}`;
    await act(async () => rerender(<ResultPage />));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('Current failure');

    await act(async () => pending.resolve(failedResource('Previous failure')));
    expect(screen.getByRole('alert')).toHaveTextContent('Current failure');
    expect(clearKnowledgeForSession).toHaveBeenCalledOnce();
    expect(captureSessionIdentity).toHaveBeenCalledOnce();
  });
});

describe('AggregatePage request lifecycle', () => {
  it('shows an initially replaced session without starting restoration', () => {
    replaceSession();
    render(<AggregatePage />);

    expect(screen.getByText('pages.aggregate.errors.sessionReplaced')).toBeInTheDocument();
    expect(fetchCurrentFinalization).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('does not apply a finalization response after leaving the page', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof startFinalization>>>();
    vi.mocked(startFinalization).mockReturnValue(pending.promise);
    const view = render(<AggregatePage />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('scenario-radio-S0'));
    fireEvent.click(screen.getByTestId('execute-button'));
    const signal = vi.mocked(startFinalization).mock.calls[0]?.[2]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => pending.resolve({ status: 202, data: pendingResource }));
    expect(saveSessionDataForIdentity).not.toHaveBeenCalled();
    expect(mergeKnowledgeFromApi).not.toHaveBeenCalled();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('rejects a finalization response for a replaced session', async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof startFinalization>>>();
    vi.mocked(startFinalization).mockReturnValue(pending.promise);
    render(<AggregatePage />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId('scenario-radio-S1'));
    fireEvent.click(screen.getByTestId('execute-button'));
    replaceSession();

    await act(async () => pending.resolve({ status: 202, data: pendingResource }));
    expect(saveSessionDataForIdentity).not.toHaveBeenCalled();
    expect(screen.getByText('pages.aggregate.errors.sessionReplaced')).toBeInTheDocument();
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it('does not clear a replacement session when a restore request reports session loss', async () => {
    const pending = Promise.withResolvers<FinalizationResource | null>();
    vi.mocked(fetchCurrentFinalization).mockReturnValue(pending.promise);
    render(<AggregatePage />);
    replaceSession();

    await act(async () => pending.reject(missingSessionError()));
    expect(clearSession).not.toHaveBeenCalled();
    expect(screen.getByText('pages.aggregate.errors.sessionReplaced')).toBeInTheDocument();
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ResultPage from './page';
import type { ClientFinalizationSnapshot } from '@/lib/finalize/client-finalization-result';
import { t as translate } from '@/lib/i18n';
import type { SessionData } from '@/lib/session/types';
import { normalizeTestJournalCounts } from '@/lib/testing/test-helpers';
import { getNumberProperty, requireRecord } from '@/lib/utils/guards';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import type { FinalizationStatusFinalizationResult } from '@/lib/finalize/finalization-status-client';

const mockPush = vi.fn();
const { mockIsSessionReplacedForIdentity, mockSaveSessionDataForIdentity, MockFinalizationStatusError } = vi.hoisted(
  () => ({
    mockIsSessionReplacedForIdentity: vi.fn(() => false),
    mockSaveSessionDataForIdentity: vi.fn(),
    MockFinalizationStatusError: class FinalizationStatusError extends Error {
      status: number;
      responseBody?: unknown;

      constructor(message: string, status: number, responseBody?: unknown) {
        super(message);
        this.status = status;
        this.responseBody = responseBody;
      }
    },
  }),
);

const { stableTranslation } = vi.hoisted(() => ({
  stableTranslation: {
    t: (key: string, params?: Record<string, string | number>) => translate('en', key, params),
    language: 'en',
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/lib/hooks', () => ({
  useTranslation: () => stableTranslation,
}));

vi.mock('@/lib/session', () => ({
  captureSessionIdentity: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) =>
    session?.sessionId ? { sessionId: session.sessionId, capabilityToken: session.capabilityToken } : null,
  ),
  getSessionData: vi.fn(),
  getSessionDataForIdentity: vi.fn(),
  getSessionAuthHeaders: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) => {
    if (!session?.sessionId) {
      return {};
    }
    const headers: Record<string, string> = {
      'X-Session-ID': session.sessionId,
    };
    if (session.capabilityToken) {
      headers['X-Session-Capability'] = session.capabilityToken;
    }
    return headers;
  }),
  clearSessionData: vi.fn(),
  saveSessionData: vi.fn(),
  saveSessionDataForIdentity: mockSaveSessionDataForIdentity,
  isSessionReplacedForIdentity: mockIsSessionReplacedForIdentity,
  SESSION_STORAGE_KEY: 'starkBallotSession',
}));

vi.mock('@/lib/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge')>();
  return {
    ...actual,
    saveKnowledgeData: vi.fn(),
    clearKnowledge: vi.fn(),
    clearKnowledgeForSession: vi.fn(),
    getKnowledgeValue: vi.fn(),
    mergeKnowledgeFromApi: vi.fn(),
  };
});

vi.mock('@/lib/api/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/api/apiBaseUrl', () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock('@/lib/verification/stark-verification-polling', () => ({
  startStarkVerificationPolling: vi.fn(),
}));

vi.mock('@/lib/finalize/finalization-status-client', () => ({
  fetchFinalizationStatus: vi.fn(),
  FinalizationStatusError: MockFinalizationStatusError,
  resolveFinalizationStatusErrorCode: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'responseBody' in error &&
    typeof error.responseBody === 'object' &&
    error.responseBody !== null &&
    'error' in error.responseBody &&
    typeof error.responseBody.error === 'string'
      ? error.responseBody.error
      : null,
}));

const sessionModule = await import('@/lib/session');
const knowledgeModule = await import('@/lib/knowledge');
const apiModule = await import('@/lib/api/apiFetch');
const pollingModule = await import('@/lib/verification/stark-verification-polling');
const statusModule = await import('@/lib/finalize/finalization-status-client');

const mockGetSessionData = vi.mocked(sessionModule.getSessionData);
const mockClearSessionData = vi.mocked(sessionModule.clearSessionData);
const mockGetSessionDataForIdentity = vi.mocked(sessionModule.getSessionDataForIdentity);
const mockSaveKnowledgeData = vi.mocked(knowledgeModule.saveKnowledgeData);
const mockClearKnowledge = vi.mocked(knowledgeModule.clearKnowledge);
const mockClearKnowledgeForSession = vi.mocked(knowledgeModule.clearKnowledgeForSession);
const mockGetKnowledgeValue = vi.mocked(knowledgeModule.getKnowledgeValue);
const mockMergeKnowledgeFromApi = vi.mocked(knowledgeModule.mergeKnowledgeFromApi);
const mockApiFetch = vi.mocked(apiModule.apiFetch);
const mockStartPolling = vi.mocked(pollingModule.startStarkVerificationPolling);
const mockFetchFinalizationStatus = vi.mocked(statusModule.fetchFinalizationStatus);

function withCanonicalJournal(
  result: Record<string, unknown>,
): NonNullable<FinalizationStatusFinalizationResult> & ClientFinalizationSnapshot {
  const tally = requireRecord(result.tally, 'finalize result tally');
  const counts = requireRecord(tally.counts, 'finalize result counts');
  const tamperedCount = getNumberProperty(tally, 'tamperedCount') ?? 0;
  const claimedTotalVotes =
    getNumberProperty(tally, 'totalVotes') ??
    ['A', 'B', 'C', 'D', 'E'].reduce((sum, key) => sum + (getNumberProperty(counts, key) ?? 0), 0);
  const normalizedCounts = normalizeTestJournalCounts({
    countedIndices: getNumberProperty(result, 'countedIndices') ?? claimedTotalVotes,
    invalidVotes: getNumberProperty(result, 'invalidVotes') ?? undefined,
    seenIndicesCount: getNumberProperty(result, 'seenIndicesCount') ?? undefined,
    missingSlots: getNumberProperty(result, 'missingSlots') ?? undefined,
    missingIndices: getNumberProperty(result, 'missingIndices') ?? undefined,
    invalidPresentedSlots: getNumberProperty(result, 'invalidPresentedSlots') ?? undefined,
    invalidIndices: getNumberProperty(result, 'invalidIndices') ?? undefined,
    rejectedRecords: getNumberProperty(result, 'rejectedRecords') ?? undefined,
    excludedSlots: getNumberProperty(result, 'excludedSlots') ?? undefined,
    excludedCount: getNumberProperty(result, 'excludedCount') ?? undefined,
  });
  const totalExpected = getNumberProperty(result, 'totalExpected') ?? claimedTotalVotes;
  const treeSize = getNumberProperty(result, 'treeSize') ?? totalExpected;

  return {
    ...result,
    tally: {
      counts: {
        A: getNumberProperty(counts, 'A') ?? 0,
        B: getNumberProperty(counts, 'B') ?? 0,
        C: getNumberProperty(counts, 'C') ?? 0,
        D: getNumberProperty(counts, 'D') ?? 0,
        E: getNumberProperty(counts, 'E') ?? 0,
      },
      totalVotes: claimedTotalVotes,
      tamperedCount,
    },
    bulletinRoot: (result.bulletinRoot as string | undefined) ?? '0x' + 'a'.repeat(64),
    imageId: (result.imageId as string | undefined) ?? '0x' + 'e'.repeat(64),
    verifiedTally: [
      getNumberProperty(counts, 'A') ?? 0,
      getNumberProperty(counts, 'B') ?? 0,
      getNumberProperty(counts, 'C') ?? 0,
      getNumberProperty(counts, 'D') ?? 0,
      getNumberProperty(counts, 'E') ?? 0,
    ],
    missingSlots: normalizedCounts.missingSlots,
    invalidPresentedSlots: normalizedCounts.invalidPresentedSlots,
    rejectedRecords: normalizedCounts.rejectedRecords,
    missingIndices: normalizedCounts.missingIndices,
    invalidIndices: normalizedCounts.invalidIndices,
    countedIndices: normalizedCounts.countedIndices,
    totalExpected,
    treeSize,
    excludedSlots: normalizedCounts.excludedSlots,
    excludedCount: normalizedCounts.excludedCount,
    sthDigest: (result.sthDigest as string | undefined) ?? '0x' + 'b'.repeat(64),
    seenBitmapRoot: '0x' + 'f'.repeat(64),
    includedBitmapRoot: (result.includedBitmapRoot as string | undefined) ?? '0x' + 'c'.repeat(64),
    inputCommitment: (result.inputCommitment as string | undefined) ?? '0x' + 'd'.repeat(64),
    seenIndicesCount: normalizedCounts.seenIndicesCount,
    journal: {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '0'.repeat(64),
      bulletinRoot: (result.bulletinRoot as string | undefined) ?? '0x' + 'a'.repeat(64),
      treeSize,
      totalExpected,
      sthDigest: (result.sthDigest as string | undefined) ?? '0x' + 'b'.repeat(64),
      verifiedTally: [
        getNumberProperty(counts, 'A') ?? 0,
        getNumberProperty(counts, 'B') ?? 0,
        getNumberProperty(counts, 'C') ?? 0,
        getNumberProperty(counts, 'D') ?? 0,
        getNumberProperty(counts, 'E') ?? 0,
      ],
      totalVotes: normalizedCounts.totalVotes,
      validVotes: normalizedCounts.validVotes,
      invalidVotes: normalizedCounts.invalidVotes,
      seenIndicesCount: normalizedCounts.seenIndicesCount,
      missingSlots: normalizedCounts.missingSlots,
      invalidPresentedSlots: normalizedCounts.invalidPresentedSlots,
      rejectedRecords: normalizedCounts.rejectedRecords,
      missingIndices: normalizedCounts.missingIndices,
      invalidIndices: normalizedCounts.invalidIndices,
      countedIndices: normalizedCounts.countedIndices,
      seenBitmapRoot: '0x' + 'f'.repeat(64),
      includedBitmapRoot: (result.includedBitmapRoot as string | undefined) ?? '0x' + 'c'.repeat(64),
      excludedSlots: normalizedCounts.excludedSlots,
      excludedCount: normalizedCounts.excludedCount,
      inputCommitment: (result.inputCommitment as string | undefined) ?? '0x' + 'd'.repeat(64),
      methodVersion: CURRENT_METHOD_VERSION,
      imageId: (result.imageId as string | undefined) ?? '0x' + 'e'.repeat(64),
    },
  } as NonNullable<FinalizationStatusFinalizationResult> & ClientFinalizationSnapshot;
}

describe('ResultPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSessionReplacedForIdentity.mockReturnValue(false);
    mockGetSessionDataForIdentity.mockImplementation(() => mockGetSessionData());
    mockGetKnowledgeValue.mockReturnValue(undefined);
    mockStartPolling.mockReset();
    mockFetchFinalizationStatus.mockImplementation(() => {
      const session = mockGetSessionData();
      return Promise.resolve({
        sessionId: session?.sessionId ?? 'test-session',
        finalizationState: session?.finalizeResult
          ? {
              status: 'succeeded',
              executionId: 'exec-restored-default',
              queuedAt: Date.now(),
              startedAt: Date.now(),
              completedAt: Date.now(),
            }
          : null,
        queue: null,
        finalizationResult: (session?.finalizeResult ?? null) as FinalizationStatusFinalizationResult | null,
        stepFunctions: null,
      });
    });
    mockApiFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    } as Response);
  });

  it('renders result summary and stores tally knowledge', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        sthDigest: '0x' + 'b'.repeat(64),
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        inputCommitment: '0x' + 'd'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
        receiptPublication: {
          receiptHash: '0x' + 'f'.repeat(64),
          boardIndex: 2,
        },
      }),
    });

    render(<ResultPage />);

    expect(await screen.findByText('Aggregation Result')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: translate('en', 'pages.result.startVerification') })).toBeInTheDocument();
    expect(screen.getByText('Total 15 votes')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockMergeKnowledgeFromApi).toHaveBeenCalledWith(
        'result',
        expect.objectContaining({
          tally: {
            counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
            totalVotes: 15,
            tamperedCount: 0,
          },
        }),
        { omitKeys: knowledgeModule.VERIFICATION_GATED_KEYS, expectedSessionId: 'test-session' },
      );
    });
  });

  it('loads finalize result from the status API when session cache is missing', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
    });
    mockFetchFinalizationStatus.mockResolvedValueOnce({
      sessionId: 'test-session',
      finalizationState: {
        status: 'succeeded',
        executionId: 'exec-1234567890',
        queuedAt: Date.now(),
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
      queue: null,
      finalizationResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
      }),
      stepFunctions: null,
    });

    render(<ResultPage />);

    expect(await screen.findByText('Aggregation Result')).toBeInTheDocument();
    const call = mockSaveSessionDataForIdentity.mock.calls[0] ?? [];
    const payload = requireRecord(call[1], 'session patch');
    expect(payload.phase).toBe('verifying');
    expect(payload.finalizeResult).toBeTruthy();
  });

  it('ignores status result when finalization state is not succeeded', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
    });
    mockFetchFinalizationStatus.mockResolvedValueOnce({
      sessionId: 'test-session',
      finalizationState: {
        status: 'running',
        executionId: 'exec-1234567890',
        queuedAt: Date.now(),
        startedAt: Date.now(),
      },
      queue: null,
      finalizationResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
      }),
      stepFunctions: null,
    });

    render(<ResultPage />);

    expect(await screen.findByText(translate('en', 'pages.result.errors.noResult'))).toBeInTheDocument();
    expect(mockSaveSessionDataForIdentity).toHaveBeenCalledWith(
      { sessionId: 'test-session', capabilityToken: 'test-capability-token' },
      expect.objectContaining({
        finalizeResult: undefined,
        phase: 'voting',
      }),
    );
  });

  it('disables start verification button after click', async () => {
    const user = userEvent.setup();
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        sthDigest: '0x' + 'b'.repeat(64),
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        inputCommitment: '0x' + 'd'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
      }),
    });

    render(<ResultPage />);

    await screen.findByText('Aggregation Result');

    const button = screen.getByRole('button', { name: translate('en', 'pages.result.startVerification') });
    expect(button).toBeEnabled();

    await user.click(button);

    expect(mockPush).toHaveBeenCalledWith('/verify');
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
  });

  it('fires verification run before navigating to verify', async () => {
    const user = userEvent.setup();
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        sthDigest: '0x' + 'b'.repeat(64),
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        inputCommitment: '0x' + 'd'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
      }),
    });

    render(<ResultPage />);

    const button = await screen.findByRole('button', {
      name: translate('en', 'pages.result.startVerification'),
    });

    await user.click(button);

    expect(mockPush).toHaveBeenCalledWith('/verify');
    const savedCall =
      mockSaveSessionDataForIdentity.mock.calls.find(
        (call) =>
          typeof getNumberProperty(requireRecord(call[1], 'session patch'), 'verificationRequestedAt') === 'number',
      ) ?? [];
    const savedPayload = requireRecord(savedCall[1], 'session patch');
    expect(typeof getNumberProperty(savedPayload, 'verificationRequestedAt')).toBe('number');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/verification/run',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(mockStartPolling).toHaveBeenCalledWith({ sessionId: 'test-session' });
    const call = mockApiFetch.mock.calls[0] ?? [];
    const options = requireRecord(call[1], 'api fetch options');
    const headers = requireRecord(options.headers, 'api fetch headers');
    expect(headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Session-ID': 'test-session',
      }),
    );
  });

  it('fails closed when the browser session cannot recover a canonical finalization snapshot', async () => {
    const user = userEvent.setup();
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
    });
    mockFetchFinalizationStatus.mockResolvedValueOnce({
      sessionId: 'test-session',
      finalizationState: {
        status: 'succeeded',
        executionId: 'exec-1234567890',
        queuedAt: Date.now(),
        startedAt: Date.now(),
        completedAt: Date.now(),
      },
      queue: null,
      finalizationResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        sthDigest: '0x' + 'b'.repeat(64),
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        inputCommitment: '0x' + 'd'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
      }),
      stepFunctions: null,
    });

    render(<ResultPage />);

    const button = await screen.findByRole('button', {
      name: translate('en', 'pages.result.startVerification'),
    });

    await user.click(button);

    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(await screen.findByText(translate('en', 'pages.result.errors.noResult'))).toBeInTheDocument();
  });

  it('shows the session recovery error when status restore returns SESSION_NOT_FOUND', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
    });
    mockFetchFinalizationStatus.mockRejectedValueOnce(
      new MockFinalizationStatusError('missing', 404, {
        error: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      }),
    );

    render(<ResultPage />);

    expect(await screen.findByText(translate('en', 'pages.result.errors.sessionNotFound'))).toBeInTheDocument();
    expect(screen.queryByText(translate('en', 'pages.result.errors.noResult'))).not.toBeInTheDocument();
    expect(mockClearSessionData).toHaveBeenCalledTimes(1);
  });

  it('clears cached finalized projection when status restore fails closed', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
      }),
    });
    mockFetchFinalizationStatus.mockResolvedValueOnce({
      sessionId: 'test-session',
      artifactState: 'unsupported_current_artifact',
      finalizationState: {
        status: 'failed',
        executionId: 'exec-stale',
        queuedAt: Date.now(),
        failedAt: Date.now(),
        error: {
          code: 'UNSUPPORTED_CURRENT_ARTIFACT',
          message: 'Unsupported current artifact',
        },
      },
      queue: null,
      finalizationResult: null,
      stepFunctions: null,
    });

    render(<ResultPage />);

    expect(await screen.findByText('Unsupported current artifact')).toBeInTheDocument();
    expect(mockSaveSessionDataForIdentity).toHaveBeenCalledWith(
      { sessionId: 'test-session', capabilityToken: 'test-capability-token' },
      expect.objectContaining({
        finalizeResult: undefined,
        phase: 'voting',
      }),
    );
    expect(mockClearKnowledgeForSession).toHaveBeenCalledWith('test-session');
  });

  it.each(['success', 'failed', 'dev_mode'] as const)(
    'does not trigger verification when status is already %s',
    async (status) => {
      const user = userEvent.setup();
      mockGetSessionData.mockReturnValue({
        sessionId: 'test-session',
        capabilityToken: 'test-capability-token',
        lastActivity: Date.now(),
        finalizeResult: withCanonicalJournal({
          tally: {
            counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
            totalVotes: 15,
            tamperedCount: 0,
          },
          bulletinRoot: '0x' + 'a'.repeat(64),
          treeSize: 64,
          sthDigest: '0x' + 'b'.repeat(64),
          includedBitmapRoot: '0x' + 'c'.repeat(64),
          inputCommitment: '0x' + 'd'.repeat(64),
          imageId: '0x' + 'e'.repeat(64),
          verificationStatus: status,
        }),
      });

      render(<ResultPage />);

      const button = await screen.findByRole('button', {
        name: translate('en', 'pages.result.startVerification'),
      });

      await user.click(button);

      expect(mockPush).toHaveBeenCalledWith('/verify');
      expect(mockApiFetch).not.toHaveBeenCalled();
      expect(mockStartPolling).not.toHaveBeenCalled();
    },
  );

  it('rewrites cached success to failed before persisting when canonical journal indicates exclusions', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 1,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        totalExpected: 64,
        sthDigest: '0x' + 'b'.repeat(64),
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        inputCommitment: '0x' + 'd'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
        excludedCount: 1,
        missingIndices: 1,
        invalidIndices: 0,
        verificationStatus: 'success',
      }),
    });

    render(<ResultPage />);

    expect(await screen.findByText('Aggregation Result')).toBeInTheDocument();

    await waitFor(() => {
      const saveCall = mockSaveSessionDataForIdentity.mock.calls[0] ?? [];
      const payload = requireRecord(saveCall[1], 'session patch');
      const finalizeResult = requireRecord(payload.finalizeResult, 'finalize result');
      expect(finalizeResult.verificationStatus).toBe('failed');
    });
  });

  it('rewrites cached success to failed when nested verifier report has no receipt image id', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        totalExpected: 64,
        sthDigest: '0x' + 'b'.repeat(64),
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        inputCommitment: '0x' + 'd'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
        verificationStatus: 'success',
        verificationResult: {
          status: 'success',
          bundlePath: '/tmp/bundle',
          reportPath: '/tmp/report.json',
          report: {
            status: 'success',
            verifier_version: '0.1.0',
            verified_at: '2025-10-16T00:00:00Z',
            duration_ms: 42,
            expected_image_id: '0x' + 'e'.repeat(64),
            receipt_image_id: null,
            bundle_path: '/tmp/bundle',
            receipt_path: '/tmp/bundle/receipt.json',
            dev_mode_receipt: false,
          },
        },
      }),
    });

    render(<ResultPage />);

    expect(await screen.findByText('Aggregation Result')).toBeInTheDocument();

    await waitFor(() => {
      const saveCall = mockSaveSessionDataForIdentity.mock.calls[0] ?? [];
      const payload = requireRecord(saveCall[1], 'session patch');
      const finalizeResult = requireRecord(payload.finalizeResult, 'finalize result');
      expect(finalizeResult.verificationStatus).toBe('failed');
      expect(requireRecord(finalizeResult.verificationResult, 'verification result').status).toBe('failed');
    });
  });

  it('starts polling when verification is already running', async () => {
    const user = userEvent.setup();
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        sthDigest: '0x' + 'b'.repeat(64),
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        inputCommitment: '0x' + 'd'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
        verificationStatus: 'running',
      }),
    });

    render(<ResultPage />);

    const button = await screen.findByRole('button', {
      name: translate('en', 'pages.result.startVerification'),
    });

    await user.click(button);

    expect(mockPush).toHaveBeenCalledWith('/verify');
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(mockStartPolling).toHaveBeenCalledWith({ sessionId: 'test-session' });
  });

  it('clears session data and knowledge on reset from error state', async () => {
    const user = userEvent.setup();
    mockGetSessionData.mockReturnValue(null);

    render(<ResultPage />);

    const resetButton = await screen.findByRole('button', { name: /Start Over/i });
    await user.click(resetButton);

    expect(mockClearSessionData).toHaveBeenCalled();
    expect(mockClearKnowledge).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/');
  });

  it('does not override proof bundle status when already downloaded', async () => {
    mockGetKnowledgeValue.mockReturnValue('downloaded');
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + 'a'.repeat(64),
        treeSize: 64,
        sthDigest: '0x' + 'b'.repeat(64),
        includedBitmapRoot: '0x' + 'c'.repeat(64),
        inputCommitment: '0x' + 'd'.repeat(64),
        imageId: '0x' + 'e'.repeat(64),
      }),
    });

    render(<ResultPage />);

    expect(await screen.findByText('Aggregation Result')).toBeInTheDocument();

    const calls = mockSaveKnowledgeData.mock.calls;
    const wroteProofBundleStatus = calls.some((call) => call[0].proofBundleStatus === 'not_downloaded');
    expect(wroteProofBundleStatus).toBe(false);
  });

  it('stores completeness metrics when available in finalize result', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        missingIndices: 1,
        invalidIndices: 2,
        countedIndices: 61,
        totalExpected: 64,
      }),
    });

    render(<ResultPage />);

    expect(await screen.findByText('Aggregation Result')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockSaveKnowledgeData).toHaveBeenCalledWith(
        expect.objectContaining({
          missingSlots: 1,
          invalidPresentedSlots: 2,
          validVotes: 61,
          excludedSlots: 3,
          totalExpected: 64,
        }),
        { expectedSessionId: 'test-session' },
      );
    });
  });

  it('prefers journal-derived completeness metrics over stale cached top-level copies', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: {
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        imageId: '0x' + 'e'.repeat(64),
        missingIndices: 99,
        invalidIndices: 98,
        countedIndices: 0,
        totalExpected: 999,
        journal: {
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          electionConfigHash: '0x' + '0'.repeat(64),
          bulletinRoot: '0x' + '1'.repeat(64),
          treeSize: 64,
          totalExpected: 64,
          sthDigest: '0x' + '2'.repeat(64),
          verifiedTally: [1, 2, 3, 4, 5],
          totalVotes: 15,
          validVotes: 15,
          invalidVotes: 0,
          seenIndicesCount: 15,
          missingSlots: 1,
          invalidPresentedSlots: 0,
          rejectedRecords: 2,
          seenBitmapRoot: '0x' + '5'.repeat(64),
          includedBitmapRoot: '0x' + '3'.repeat(64),
          excludedSlots: 1,
          inputCommitment: '0x' + '4'.repeat(64),
          methodVersion: CURRENT_METHOD_VERSION,
        },
      } as unknown as NonNullable<SessionData['finalizeResult']>,
    });

    render(<ResultPage />);

    expect(await screen.findByText('Aggregation Result')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockSaveKnowledgeData).toHaveBeenCalledWith(
        expect.objectContaining({
          missingSlots: 1,
          invalidPresentedSlots: 0,
          rejectedRecords: 2,
          validVotes: 15,
          excludedSlots: 1,
          totalExpected: 64,
        }),
        { expectedSessionId: 'test-session' },
      );
    });
  });

  it('keeps record-only rejections when rebuilding a canonical snapshot from top-level mirrors', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      finalizeResult: withCanonicalJournal({
        tally: {
          counts: { A: 1, B: 2, C: 3, D: 4, E: 5 },
          totalVotes: 15,
          tamperedCount: 0,
        },
        imageId: '0x' + 'e'.repeat(64),
        countedIndices: 15,
        missingIndices: 0,
        invalidIndices: 0,
        rejectedRecords: 2,
        excludedCount: 0,
        totalExpected: 64,
        treeSize: 64,
      }),
    });

    render(<ResultPage />);

    expect(await screen.findByText('Aggregation Result')).toBeInTheDocument();

    await waitFor(() => {
      expect(mockSaveKnowledgeData).toHaveBeenCalledWith(
        expect.objectContaining({
          missingSlots: 0,
          invalidPresentedSlots: 0,
          rejectedRecords: 2,
          validVotes: 15,
          excludedSlots: 0,
          totalExpected: 64,
        }),
        { expectedSessionId: 'test-session' },
      );
    });
  });
});

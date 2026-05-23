import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KnowledgeData } from '@/lib/knowledge';
import type { VerificationStepStatus } from '@/lib/knowledge';
import { resolveCanonicalFinalizationPayload } from '@/lib/finalize/client-finalization-result';
import type { SessionData } from '@/lib/session/types';
import { VERIFICATION_CHECK_DEFINITIONS, type VerificationCheckId } from '@/lib/verification/verification-checks';
import { computeCommitment, CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import VerifyPage from './page';

// Mock dependencies
type SaveKnowledgeDataFn = typeof import('@/lib/knowledge/store').saveKnowledgeData;

const mockPush = vi.fn();
let currentT: (key: string) => string = (key) => key;
const {
  mockSetProofBundleStatus,
  mockSaveKnowledgeData,
  actualSaveKnowledgeDataRef,
  mockIsSessionReplaced,
  mockClearClientFinalizedProjection,
  mockClearClientSessionAuthority,
  mockGetStarkVerificationSnapshot,
  mockSubscribeStarkVerificationSnapshot,
} = vi.hoisted(() => {
  const actualSaveKnowledgeDataRef: { current: SaveKnowledgeDataFn } = {
    current: () => [],
  };

  return {
    mockSetProofBundleStatus: vi.fn(),
    mockSaveKnowledgeData: vi.fn<SaveKnowledgeDataFn>(),
    actualSaveKnowledgeDataRef,
    mockIsSessionReplaced: vi.fn(() => false),
    mockClearClientFinalizedProjection: vi.fn(),
    mockClearClientSessionAuthority: vi.fn(),
    mockGetStarkVerificationSnapshot: vi.fn<
      () => import('@/lib/verification/stark-verification-polling').StarkVerificationSnapshot | null
    >(() => null),
    mockSubscribeStarkVerificationSnapshot: vi.fn(() => () => undefined),
  };
});

function buildCanonicalFinalizeResult(
  electionId: string,
  verifiedTally: [number, number, number, number, number],
  totalExpected: number,
): NonNullable<SessionData['finalizeResult']> {
  const totalVotes = verifiedTally.reduce((sum, value) => sum + value, 0);
  const result = resolveCanonicalFinalizationPayload({
    tally: {
      counts: {
        A: verifiedTally[0],
        B: verifiedTally[1],
        C: verifiedTally[2],
        D: verifiedTally[3],
        E: verifiedTally[4],
      },
      totalVotes,
      tamperedCount: 0,
    },
    imageId: '0x' + 'e'.repeat(64),
    journal: {
      electionId,
      electionConfigHash: '0x' + '0'.repeat(64),
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: totalExpected,
      totalExpected,
      sthDigest: '0x' + 'b'.repeat(64),
      verifiedTally,
      totalVotes,
      validVotes: totalVotes,
      invalidVotes: 0,
      seenIndicesCount: totalVotes,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      missingIndices: 0,
      invalidIndices: 0,
      countedIndices: totalVotes,
      seenBitmapRoot: '0x' + 'c'.repeat(64),
      includedBitmapRoot: '0x' + 'd'.repeat(64),
      excludedSlots: 0,
      excludedCount: 0,
      inputCommitment: '0x' + 'f'.repeat(64),
      methodVersion: CURRENT_METHOD_VERSION,
    },
  });

  if (!result) {
    throw new Error('Failed to build canonical finalization snapshot');
  }

  return result;
}
vi.mock('@/lib/hooks', () => ({
  useTranslation: () => ({
    t: currentT,
    language: 'en',
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/lib/session', () => ({
  captureSessionIdentity: vi.fn((session?: { sessionId?: string; capabilityToken?: string } | null) =>
    session?.sessionId ? { sessionId: session.sessionId, capabilityToken: session.capabilityToken } : null,
  ),
  getSessionData: vi.fn(),
  getSessionDataForIdentity: vi.fn(),
  isSessionReplaced: mockIsSessionReplaced,
  isSessionReplacedForIdentity: mockIsSessionReplaced,
  SESSION_STORAGE_KEY: 'starkBallotSession',
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
  updateLastActivity: vi.fn(),
  updateLastActivityForIdentity: vi.fn(),
  SESSION_HEARTBEAT_INTERVAL_MS: 60_000,
}));

vi.mock('@/lib/knowledge', async () => {
  const actual = await vi.importActual<typeof import('@/lib/knowledge')>('@/lib/knowledge');
  actualSaveKnowledgeDataRef.current = actual.saveKnowledgeData;
  return {
    ...actual,
    setProofBundleStatus: mockSetProofBundleStatus,
    saveKnowledgeData: (data: Partial<KnowledgeData>, options?: { expectedSessionId?: string }) =>
      mockSaveKnowledgeData(data, options),
  };
});

vi.mock('@/lib/finalize/client-finalization-boundary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/finalize/client-finalization-boundary')>(
    '@/lib/finalize/client-finalization-boundary',
  );
  return {
    ...actual,
    clearClientFinalizedProjection: mockClearClientFinalizedProjection,
    clearClientSessionAuthority: mockClearClientSessionAuthority,
  };
});

vi.mock('@/lib/verification/stark-verification-polling', async () => {
  const actual = await vi.importActual<typeof import('@/lib/verification/stark-verification-polling')>(
    '@/lib/verification/stark-verification-polling',
  );
  return {
    ...actual,
    getStarkVerificationSnapshot: mockGetStarkVerificationSnapshot,
    subscribeStarkVerificationSnapshot: mockSubscribeStarkVerificationSnapshot,
  };
});

const sessionModule = await import('@/lib/session');
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);
const mockGetSessionDataForIdentity = vi.mocked(sessionModule.getSessionDataForIdentity);
const mockUpdateLastActivityForIdentity = vi.mocked(sessionModule.updateLastActivityForIdentity);

describe('VerifyPage', () => {
  const mockSessionId = '2b9efb8c-7fb1-41e5-9fc9-0026054eeda6';
  const mockExecutionId = '01KDNNN77XG2T86VJ3G4G5PWK0';
  const statusUrl = `/api/sessions/${mockSessionId}/status`;
  const localBundleUrl = resolveApiUrl(`/api/verification/bundles/${mockSessionId}/${mockExecutionId}`);
  const originalCreateElement = document.createElement.bind(document);

  const createStatusPayload = () => ({
    sessionId: mockSessionId,
    finalizationState: {
      status: 'succeeded' as const,
      executionId: mockExecutionId,
      queuedAt: 1,
      startedAt: 2,
      completedAt: 3,
    },
    finalizationResult: {},
    stepFunctions: null,
  });

  const createStatusResponse = () =>
    Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(createStatusPayload())),
    });

  const resolveUrl = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') {
      return input;
    }
    if (input instanceof URL) {
      return input.toString();
    }
    return input.url;
  };

  const isRequestInput = (value: unknown): value is RequestInfo | URL => {
    if (typeof value === 'string' || value instanceof URL) {
      return true;
    }
    if (typeof Request !== 'undefined' && value instanceof Request) {
      return true;
    }
    return false;
  };

  const buildVerificationChecks = (overrides: Partial<Record<VerificationCheckId, VerificationStepStatus>> = {}) =>
    VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
      id: definition.id,
      status: overrides[definition.id] ?? 'success',
      evidence: definition.evidence,
      inputs: definition.inputs,
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSessionReplaced.mockReturnValue(false);
    mockClearClientFinalizedProjection.mockReset();
    mockClearClientSessionAuthority.mockReset();
    mockGetStarkVerificationSnapshot.mockReturnValue(null);
    mockSubscribeStarkVerificationSnapshot.mockImplementation(() => () => undefined);
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
    });
    mockGetSessionDataForIdentity.mockImplementation(() => mockGetSessionData());
    mockSetProofBundleStatus.mockReset();
    mockSaveKnowledgeData.mockReset();
    mockSaveKnowledgeData.mockImplementation((data: Partial<KnowledgeData>) =>
      actualSaveKnowledgeDataRef.current(data),
    );
    currentT = (key: string) => key;
    document.createElement = originalCreateElement;
    global.URL.createObjectURL = vi.fn(() => 'blob:test');
    global.URL.revokeObjectURL = vi.fn();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    document.createElement = originalCreateElement;
  });

  it('renders loading state initially', () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(<VerifyPage />);

    expect(screen.getByText('pages.verify.loading')).toBeInTheDocument();
    expect(mockUpdateLastActivityForIdentity).toHaveBeenCalled();
  });

  it('renders error state when no session', async () => {
    mockGetSessionData.mockReturnValue(null);

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.sessionError')).toBeInTheDocument();
    });
    expect(mockUpdateLastActivityForIdentity).toHaveBeenCalled();
  });

  it('renders isolation error when session is replaced in another tab', async () => {
    mockGetSessionData.mockReturnValue(null);
    mockIsSessionReplaced.mockReturnValue(true);

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.sessionReplaced')).toBeInTheDocument();
    });
  });

  it('switches to isolation error when storage event reports session replacement', async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(<VerifyPage />);

    mockIsSessionReplaced.mockReturnValue(true);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'starkBallotSession',
        oldValue: JSON.stringify({ sessionId: mockSessionId }),
        newValue: JSON.stringify({ sessionId: 'other-session' }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByText('pages.verify.sessionReplaced')).toBeInTheDocument();
    });
  });

  it('renders verification data successfully', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      verificationExecutionId: mockExecutionId,
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      // Verify UnifiedVerificationCard is rendered with first category
      expect(screen.getByText('pages.verify.stepsCard.categories.castAsIntended.title')).toBeInTheDocument();
    });
    expect(mockUpdateLastActivityForIdentity).toHaveBeenCalled();

    // Verify download section is rendered (bundle available)
    await waitFor(() => {
      expect(screen.getByText('pages.verify.download.cta')).toBeInTheDocument();
    });
  });

  it('auto-starts verification once data is available', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      verificationExecutionId: mockExecutionId,
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      // Verify first category is rendered (collapsible header with category title)
      expect(screen.getByText('pages.verify.stepsCard.categories.castAsIntended.title')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Start Verification/i })).not.toBeInTheDocument();
  });

  it('shows a direct access warning when STARK verification has not been triggered', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
    });

    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'not_run',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.directAccess')).toBeInTheDocument();
    });

    expect(screen.queryByText('pages.verify.stepsCard.categories.castAsIntended.title')).not.toBeInTheDocument();
    const backButton = screen.getByRole('button', { name: 'pages.verify.actions.backToResult' });
    await userEvent.click(backButton);
    expect(mockPush).toHaveBeenCalledWith('/result');
  });

  it('shows a direct access warning when the trigger exists but browser-local finalization state is unsupported', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: {
        tally: {
          counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
          totalVotes: 30,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
      } as unknown as NonNullable<SessionData['finalizeResult']>,
    });

    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'not_run',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.directAccess')).toBeInTheDocument();
    });

    expect(screen.queryByText('pages.verify.stepsCard.categories.castAsIntended.title')).not.toBeInTheDocument();
  });

  it('shows a timeout status when STARK verification does not resolve in time', async () => {
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
    });

    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'running',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(
      () => {
        expect(screen.getByText('pages.verify.status.timeout')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('triggers STARK verification run when status is not_run and reaches completion', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const myRand = '0x' + 'a'.repeat(64);
    const voteCommitment = computeCommitment(electionId, 0, myRand);
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: buildCanonicalFinalizeResult(electionId, [10, 20, 0, 0, 0], 64),
      electionId,
      myVote: 'A',
      myRand,
    });

    const mockData = {
      electionId,
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'success', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks(),
      voteReceipt: {
        voteId: 'vote-1',
        commitment: voteCommitment,
        bulletinRootAtCast: '0x' + 'b'.repeat(64),
        bulletinIndex: 0,
        timestamp: Date.now(),
      },
    };

    let verifyCallCount = 0;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        verifyCallCount += 1;
        const verificationStatus = verifyCallCount === 1 ? 'not_run' : 'success';
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { ...mockData, verificationStatus } }),
        } as Response);
      }
      if (url === '/api/verification/run') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { verificationStatus: 'running' } }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/verification/run',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({}),
        }),
      );
    });

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.fullyVerifiedMain');
    expect(screen.queryByText('pages.verify.status.timeout')).not.toBeInTheDocument();
  });

  it('clears session authority and shows a session error when verification run loses capability', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const myRand = '0x' + 'a'.repeat(64);
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: buildCanonicalFinalizeResult(electionId, [10, 20, 0, 0, 0], 64),
      electionId,
      myVote: 'A',
      myRand,
    });

    const mockData = {
      electionId,
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'not_run',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'not_run', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks({
        stark_receipt_verify: 'not_run',
      }),
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      if (url === '/api/verification/run') {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          json: () =>
            Promise.resolve({
              error: 'SESSION_CAPABILITY_INVALID',
              message: 'Capability token is invalid',
            }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.sessionError')).toBeInTheDocument();
    });

    expect(mockClearClientSessionAuthority).toHaveBeenCalledWith({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
    });
    expect(screen.queryByTestId('overall-status')).not.toBeInTheDocument();
  });

  it('does not trigger server-side verification until /api/verify revalidates a snapshot-backed finalized session', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const myRand = '0x' + 'a'.repeat(64);
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      finalizeResult: buildCanonicalFinalizeResult(electionId, [10, 20, 0, 0, 0], 64),
      electionId,
      myVote: 'A',
      myRand,
    });

    const mockData = {
      electionId,
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'not_run',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'not_run', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks({
        stark_receipt_verify: 'not_run',
      }),
    };

    mockGetStarkVerificationSnapshot.mockReturnValue({
      sessionId: mockSessionId,
      status: 'not_run',
      payload: mockData,
      receivedAt: Date.now(),
    });

    let resolveVerify: ((value: { ok: boolean; json: () => Promise<{ data: typeof mockData }> }) => void) | undefined;
    const verifyPromise = new Promise<{ ok: boolean; json: () => Promise<{ data: typeof mockData }> }>((resolve) => {
      resolveVerify = resolve;
    });

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return verifyPromise;
      }
      if (url === '/api/verification/run') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { verificationStatus: 'running' } }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/verify', expect.anything());
    });

    expect(fetchMock).not.toHaveBeenCalledWith('/api/verification/run', expect.anything());

    resolveVerify?.({
      ok: true,
      json: () => Promise.resolve({ data: mockData }),
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/verification/run',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({}),
        }),
      );
    });
  });

  it('shows a generic error when verification sequence throws unexpectedly', async () => {
    mockSaveKnowledgeData.mockImplementation((data: Partial<KnowledgeData>) => {
      if ('user.voteReceipt' in data) {
        throw new Error('save failed');
      }
      return actualSaveKnowledgeDataRef.current(data);
    });

    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 1,
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + 'b'.repeat(64),
        bulletinRootAtCast: '0x' + 'c'.repeat(64),
        bulletinIndex: 0,
        timestamp: Date.now(),
      },
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('errors.generic')).toBeInTheDocument();
    });
  });

  it('shows proof verification failure when verificationStatus failed without explicit proof details', async () => {
    const mockJournal = {
      electionId: 'test-election',
      electionConfigHash: '0x' + '1'.repeat(64),
      bulletinRoot: '0x' + '2'.repeat(64),
      sthDigest: '0x' + '3'.repeat(64),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      inputCommitment: '0x' + '5'.repeat(64),
      treeSize: 64,
      totalExpected: 64,
      totalVotes: 64,
      validVotes: 64,
      invalidVotes: 0,
      seenIndicesCount: 64,
      missingIndices: 0,
      invalidIndices: 0,
      countedIndices: 64,
      excludedCount: 0,
      methodVersion: 9,
      verifiedTally: [64, 0, 0, 0, 0],
    };

    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 64,
      },
      scenarioId: 'S0',
      verificationStatus: 'failed',
      verificationReport: {
        duration_ms: 123,
        errors: ['receipt metadata image_id mismatch: expected 0xabc, got 0xdef'],
      },
      bulletinRoot: '0x' + 'd'.repeat(64),
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0x' + 'e'.repeat(64),
        bulletinRootAtCast: '0x' + 'f'.repeat(64),
        bulletinIndex: 0,
        timestamp: Date.now(),
      },
      journal: mockJournal,
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.proofVerificationFailedMain');
    expect(screen.getByText('pages.verify.resultSummary.proofVerificationFailedSub')).toBeInTheDocument();
  });

  it('treats verificationReport.status=failed as an explicit server failure even without checks', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 64, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 64,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      verificationReport: {
        status: 'failed',
        duration_ms: 123,
        errors: ['Receipt::verify failed'],
      },
      bulletinRoot: '0x' + 'd'.repeat(64),
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.proofVerificationFailedMain');
  });

  it('shows verification steps when verification starts', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 1,
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      // Verify first category is rendered in UnifiedVerificationCard
      expect(screen.getByText('pages.verify.stepsCard.categories.castAsIntended.title')).toBeInTheDocument();
    });
  });

  it('marks overall status failed when consistency proof check fails', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'success', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks({
        recorded_consistency_proof: 'failed',
      }),
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.recordedIntegrityFailedMain');
  });

  it('does not show summary until verification completes', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'success', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks({
        counted_input_sanity: 'pending',
      }),
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.stepsCard.categories.castAsIntended.title')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('overall-status')).not.toBeInTheDocument();
  });

  it('shows fully verified summary when all checks succeed', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const myRand = '0x' + 'a'.repeat(64);
    const voteCommitment = computeCommitment(electionId, 0, myRand);
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      electionId,
      myVote: 'A',
      myRand,
    });

    const mockData = {
      electionId,
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'success', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks(),
      voteReceipt: {
        voteId: 'vote-1',
        commitment: voteCommitment,
        bulletinRootAtCast: '0x' + 'b'.repeat(64),
        bulletinIndex: 0,
        timestamp: Date.now(),
      },
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.fullyVerifiedMain');
    expect(screen.getByText('pages.verify.resultSummary.fullyVerifiedSub')).toBeInTheDocument();
  });

  it('overrides server cast success and shows cast failure when local intent mismatches', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const localRand = '0x' + 'c'.repeat(64);
    const voteCommitment = computeCommitment(electionId, 0, localRand);
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      electionId,
      myVote: 'B',
      myRand: localRand,
    });

    const mockData = {
      electionId,
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'success', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks(),
      voteReceipt: {
        voteId: 'vote-1',
        commitment: voteCommitment,
        bulletinRootAtCast: '0x' + 'b'.repeat(64),
        bulletinIndex: 0,
        timestamp: Date.now(),
      },
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.castIntegrityFailedMain');
  });

  it('shows missing evidence when local cast intent is unavailable', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const localRand = '0x' + 'd'.repeat(64);
    const voteCommitment = computeCommitment(electionId, 0, localRand);
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      electionId,
    });

    const mockData = {
      electionId,
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'success', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks(),
      voteReceipt: {
        voteId: 'vote-1',
        commitment: voteCommitment,
        bulletinRootAtCast: '0x' + 'b'.repeat(64),
        bulletinIndex: 0,
        timestamp: Date.now(),
      },
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.missingEvidenceMain');
  });

  it('shows missing evidence when API omits verification checks and steps', async () => {
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const localRand = '0x' + 'e'.repeat(64);
    const voteCommitment = computeCommitment(electionId, 0, localRand);
    mockGetSessionData.mockReturnValue({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
      verificationRequestedAt: Date.now(),
      electionId,
    });

    const mockData = {
      electionId,
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      voteReceipt: {
        voteId: 'vote-1',
        commitment: voteCommitment,
        bulletinRootAtCast: '0x' + 'b'.repeat(64),
        bulletinIndex: 0,
        timestamp: Date.now(),
      },
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.missingEvidenceMain');
  });

  it('shows proof verification failure when proof checks fail', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'failed',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'failed', inputs: [] },
      ],
      verificationChecks: buildVerificationChecks({
        stark_receipt_verify: 'failed',
      }),
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.resultSummary.proofVerificationFailedMain');
    expect(screen.getByText('pages.verify.resultSummary.proofVerificationFailedSub')).toBeInTheDocument();
  });

  it('surfaces STARK polling transport failures as authoritative summary failures', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'running',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
    };

    let verifyCallCount = 0;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        verifyCallCount += 1;
        if (verifyCallCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: mockData }),
          } as Response);
        }
        return Promise.reject(new Error('network failed'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const overallStatus = await screen.findByTestId('overall-status');
    expect(overallStatus).toHaveTextContent('pages.verify.failed');
    expect(screen.getByText('network failed')).toBeInTheDocument();
  });

  it('does not refetch verification data after translation changes', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 0, D: 0, E: 0 },
        totalVotes: 30,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 30,
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    const { rerender } = render(<VerifyPage />);

    await waitFor(() => {
      // Verify first category is rendered in UnifiedVerificationCard
      expect(screen.getByText('pages.verify.stepsCard.categories.castAsIntended.title')).toBeInTheDocument();
    });

    const verifyCalls = fetchMock.mock.calls.filter(([input]) => {
      if (!isRequestInput(input)) {
        return false;
      }
      return resolveUrl(input) === '/api/verify';
    });
    expect(verifyCalls).toHaveLength(1);

    currentT = (key: string) => key; // new function reference to simulate language change
    rerender(<VerifyPage />);

    await waitFor(() => {
      // Verify first category is still rendered after rerender
      expect(screen.getByText('pages.verify.stepsCard.categories.castAsIntended.title')).toBeInTheDocument();
    });

    const verifyCallsAfter = fetchMock.mock.calls.filter(([input]) => {
      if (!isRequestInput(input)) {
        return false;
      }
      return resolveUrl(input) === '/api/verify';
    });
    expect(verifyCallsAfter).toHaveLength(1);
  });

  it('downloads through the authenticated bundle route when executionId authority is available', async () => {
    const user = userEvent.setup();
    const mockData = {
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
      },
      scenarioId: 'S0',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 1,
      verificationExecutionId: mockExecutionId,
      verificationStatus: 'success',
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url.includes('api/verify')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        });
      }

      if (url === localBundleUrl) {
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(['test'], { type: 'application/zip' })),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });

    global.fetch = fetchMock;

    document.createElement = vi.fn((tag: string) => {
      const element = originalCreateElement(tag);
      if (tag === 'a') {
        element.click = vi.fn();
        element.remove = vi.fn();
      }
      return element;
    });

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.download.cta')).toBeInTheDocument();
    });

    const downloadButton = screen.getByText('pages.verify.download.cta');
    await user.click(downloadButton);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.download.success')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      localBundleUrl,
      expect.objectContaining({
        headers: {
          'X-Session-ID': mockSessionId,
          'X-Session-Capability': 'test-capability-token',
        },
      }),
    );
    expect(mockSetProofBundleStatus).toHaveBeenCalledWith('downloaded');
  });

  it('keeps the download action disabled when executionId authority is unavailable', async () => {
    const mockData = {
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
      },
      scenarioId: 'S0',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 1,
      verificationStatus: 'success',
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    global.fetch = fetchMock;

    document.createElement = vi.fn((tag: string) => {
      const element = originalCreateElement(tag);
      if (tag === 'a') {
        element.click = vi.fn();
        element.remove = vi.fn();
      }
      return element;
    });

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.download.cta')).toBeInTheDocument();
    });

    const downloadButton = screen.getByText('pages.verify.download.cta').closest('button');
    expect(downloadButton).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      localBundleUrl,
      expect.objectContaining({
        headers: {
          'X-Session-ID': mockSessionId,
          'X-Session-Capability': 'test-capability-token',
        },
      }),
    );
    expect(mockSetProofBundleStatus).not.toHaveBeenCalledWith('downloaded');
  });

  it('shows disabled bot tab for bot tamper scenarios', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 5, D: 4, E: 3 },
        totalVotes: 42,
      },
      scenarioId: 'S3',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'success', inputs: [] },
      ],
      botVotesSummary: {
        total: 63,
        affectedBotIds: [1, 2],
        source: 'scenario_simulation',
      },
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      if (url === '/api/verification/run') {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('{}'),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    const botTab = await screen.findByRole('tab', { name: /verification\.tabs\.bot/i });
    expect(botTab).toHaveAttribute('aria-disabled', 'true');
    expect(botTab).toHaveAttribute('title', 'verification.tabs.botDisabledTooltip');

    const myTab = screen.getByRole('tab', { name: /verification\.tabs\.my/i });
    expect(myTab).toHaveAttribute('aria-selected', 'true');
  });

  it('hides verification tabs when no bot tamper scenario is selected', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: {
        counts: { A: 10, B: 20, C: 5, D: 4, E: 3 },
        totalVotes: 42,
      },
      scenarioId: 'S0',
      verificationStatus: 'success',
      imageId: '0x123456',
      bulletinRoot: '0x' + 'a'.repeat(64),
      treeSize: 64,
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success', inputs: [] },
        { id: 'recorded_as_cast', status: 'success', inputs: [] },
        { id: 'counted_as_recorded', status: 'success', inputs: [] },
        { id: 'stark_verification', status: 'success', inputs: [] },
      ],
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      if (url === '/api/verification/run') {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('{}'),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.download.cta')).toBeInTheDocument();
    });

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /verification\.tabs\.bot/i })).not.toBeInTheDocument();
  });

  it('clears finalized projection and shows a page-level error when bundle download fails closed', async () => {
    const user = userEvent.setup();
    const mockData = {
      verificationExecutionId: mockExecutionId,
      verificationStatus: 'success',
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url.includes('api/verify')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        });
      }
      if (url === localBundleUrl) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: () =>
            Promise.resolve({
              error: 'UNSUPPORTED_CURRENT_ARTIFACT',
              message: 'Finalized state is unsupported for the current contract generation',
              artifactState: 'unsupported_current_artifact',
            }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });

    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.download.cta')).toBeInTheDocument();
    });

    await user.click(screen.getByText('pages.verify.download.cta'));

    await waitFor(() => {
      expect(
        screen.getByText('Finalized state is unsupported for the current contract generation'),
      ).toBeInTheDocument();
    });

    expect(mockClearClientFinalizedProjection).toHaveBeenCalledWith({
      sessionId: mockSessionId,
      capabilityToken: 'test-capability-token',
    });
    expect(screen.queryByTestId('overall-status')).not.toBeInTheDocument();
  });

  it('handles download failure when all sources fail', async () => {
    const user = userEvent.setup();
    const mockData = {
      verificationExecutionId: mockExecutionId,
      verificationStatus: 'success',
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url.includes('api/verify')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        });
      }

      return Promise.resolve({
        ok: false,
        status: 404,
      } as Response);
    });

    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByText('pages.verify.download.cta')).toBeInTheDocument();
    });

    const downloadButton = screen.getByText('pages.verify.download.cta');
    await user.click(downloadButton);

    await waitFor(() => {
      const errorElement = screen.getByRole('alert');
      expect(errorElement).toBeInTheDocument();
    });
  });

  it('handles missing bundle URLs gracefully', async () => {
    const mockData = {
      electionId: 'test-election',
      tally: { A: 10 },
      totalVotes: 10,
      verificationStatus: 'success',
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      // Download button exists but is disabled when no bundle URL is available
      const downloadButton = screen.getByText('pages.verify.download.cta');
      expect(downloadButton).toBeInTheDocument();
      expect(downloadButton.closest('button')).toBeDisabled();
    });
  });

  it('displays download section when bundle is available', async () => {
    const mockData = {
      verificationExecutionId: mockExecutionId,
      verificationStatus: 'success',
    };

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = resolveUrl(input);
      if (url === statusUrl) {
        return createStatusResponse();
      }
      if (url === '/api/verify') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: mockData }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);
    });
    global.fetch = fetchMock;

    render(<VerifyPage />);

    await waitFor(() => {
      // Download button is enabled when bundle is available
      const downloadButton = screen.getByText('pages.verify.download.cta');
      expect(downloadButton).toBeInTheDocument();
      expect(downloadButton.closest('button')).not.toBeDisabled();
    });
  });
});

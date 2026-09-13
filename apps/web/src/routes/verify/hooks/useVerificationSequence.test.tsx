import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { RefObject } from 'react';
import type { VerificationPayload } from '../lib/verification-data';
import type { VerificationStepStatus } from '@stark-ballot/web/knowledge';
import type { SessionIdentity } from '@stark-ballot/web/session';
import { saveKnowledgeData } from '@stark-ballot/web/knowledge';
import { VerificationClientApiError } from '@stark-ballot/web/verification/client-api-errors';
import { useVerificationSequence } from './useVerificationSequence';

vi.mock('@stark-ballot/web/session', () => ({
  getSessionData: vi.fn(),
  getSessionDataForIdentity: vi.fn(),
  isSessionReplaced: vi.fn(() => false),
  isSessionReplacedForIdentity: vi.fn(() => false),
}));

vi.mock('@stark-ballot/web/knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stark-ballot/web/knowledge')>()),
  saveKnowledgeData: vi.fn(),
}));

const sessionModule = await import('@stark-ballot/web/session');
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);
const mockGetSessionDataForIdentity = vi.mocked(sessionModule.getSessionDataForIdentity);
const mockIsSessionReplacedForIdentity = vi.mocked(sessionModule.isSessionReplacedForIdentity);
const mockSaveKnowledgeData = vi.mocked(saveKnowledgeData);

const ACTIVE_SESSION = {
  sessionId: 'test-session',
  capabilityToken: 'test-capability-token',
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: `0x${'a'.repeat(64)}`,
  logId: `0x${'b'.repeat(64)}`,
  lastActivity: 1,
  expiresAt: 60_001,
  phase: 'voting' as const,
};

const buildSteps = (status: VerificationStepStatus): NonNullable<VerificationPayload['verificationSteps']> => [
  { id: 'cast_as_intended', status },
  { id: 'recorded_as_cast', status },
  { id: 'counted_as_recorded', status },
  { id: 'stark_verification', status },
];

const voterEvidence = {
  voteReceipt: {
    voteId: 'vote-1',
    commitment: `0x${'c'.repeat(64)}`,
    bulletinIndex: 0,
    bulletinRootAtCast: `0x${'d'.repeat(64)}`,
    timestamp: 1,
  },
  userVote: {
    commitment: `0x${'c'.repeat(64)}`,
    voteId: 'vote-1',
    proof: { leafIndex: 0, treeSize: 1, merklePath: [], bulletinRootAtCast: `0x${'d'.repeat(64)}` },
  },
} satisfies Pick<VerificationPayload, 'voteReceipt' | 'userVote'>;

const setup = (
  data: VerificationPayload,
  fetchVerification?: Mock<() => Promise<VerificationPayload>>,
  triggerStarkVerificationRun?: () => Promise<void>,
) => {
  const fetchFn = fetchVerification ?? vi.fn<() => Promise<VerificationPayload>>().mockResolvedValue(data);
  const fetchVerificationRef = {
    current: fetchFn,
  } satisfies RefObject<() => Promise<VerificationPayload>>;
  const verificationStartedRef = { current: false } satisfies RefObject<boolean>;
  const sessionIdentityRef = {
    current: {
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
    },
  } satisfies RefObject<SessionIdentity | null>;
  const triggerRunMock = triggerStarkVerificationRun ?? (() => Promise.resolve());
  const triggerRunFn = async (): Promise<void> => {
    await triggerRunMock();
  };
  const onError = vi.fn();
  const visibilityHistory: Array<{ visibleStepCount: number; sequenceComplete: boolean }> = [];

  const hook = renderHook(() => {
    const sequence = useVerificationSequence({
      data,
      t: (key) => key,
      fetchVerificationRef,
      onError,
      verificationStartedRef,
      triggerStarkVerificationRun: triggerRunFn,
      sessionIdentityRef,
    });
    visibilityHistory.push({
      visibleStepCount: sequence.visibleStepCount,
      sequenceComplete: sequence.sequenceComplete,
    });
    return sequence;
  });

  return {
    ...hook,
    fetchVerificationRef,
    fetchVerification: fetchFn,
    triggerStarkVerificationRun: triggerRunMock,
    onError,
    visibilityHistory,
  };
};

describe('useVerificationSequence', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.useFakeTimers();
    mockGetSessionData.mockReturnValue(ACTIVE_SESSION);
    mockGetSessionDataForIdentity.mockReturnValue(ACTIVE_SESSION);
    mockIsSessionReplacedForIdentity.mockReturnValue(false);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('publishes all resolved stages together without display timers', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'success',
      verificationSteps: buildSteps('success'),
    };

    const { result, fetchVerification, visibilityHistory } = setup(data);

    await act(async () => {
      await result.current.startVerification();
    });

    expect(result.current.sequenceComplete).toBe(true);
    expect(result.current.visibleStepCount).toBe(4);
    expect(visibilityHistory).toEqual([
      { visibleStepCount: 0, sequenceComplete: false },
      { visibleStepCount: 4, sequenceComplete: true },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.stepStatusMap.stark_verification.status).toBe('success');
    expect(fetchVerification).not.toHaveBeenCalled();
  });

  it('polls verification status until STARK resolves', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'running',
      verificationSteps: buildSteps('success'),
    };

    const fetchVerification = vi
      .fn()
      .mockResolvedValueOnce({ ...data, verificationStatus: 'running' })
      .mockResolvedValueOnce({ ...data, verificationStatus: 'success' });

    const { result } = setup(data, fetchVerification);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(fetchVerification).toHaveBeenCalledTimes(2);
    expect(result.current.sequenceComplete).toBe(true);
    expect(result.current.stepStatusMap.stark_verification.status).toBe('success');
  });

  it('triggers STARK verification run once when status is not_run', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'not_run',
      verificationSteps: buildSteps('success'),
    };

    const fetchVerification = vi
      .fn()
      .mockResolvedValueOnce({ ...data, verificationStatus: 'running' })
      .mockResolvedValueOnce({ ...data, verificationStatus: 'success' });
    const triggerStarkVerificationRunMock = vi.fn().mockResolvedValue(undefined);
    const triggerStarkVerificationRun = async (): Promise<void> => {
      await triggerStarkVerificationRunMock();
    };

    const { result } = setup(data, fetchVerification, triggerStarkVerificationRun);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(triggerStarkVerificationRunMock).toHaveBeenCalledTimes(1);
    expect(result.current.sequenceComplete).toBe(true);
    expect(result.current.stepStatusMap.stark_verification.status).toBe('success');
  });

  it('continues polling when triggering STARK verification run fails', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'not_run',
      verificationSteps: buildSteps('success'),
    };

    const fetchVerification = vi
      .fn()
      .mockResolvedValueOnce({ ...data, verificationStatus: 'running' })
      .mockResolvedValueOnce({ ...data, verificationStatus: 'success' });
    const triggerStarkVerificationRunMock = vi.fn().mockRejectedValue(new Error('run failed'));
    const triggerStarkVerificationRun = async (): Promise<void> => {
      await triggerStarkVerificationRunMock();
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const { result } = setup(data, fetchVerification, triggerStarkVerificationRun);

      act(() => {
        void result.current.startVerification();
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(triggerStarkVerificationRunMock).toHaveBeenCalledTimes(1);
      expect(fetchVerification).toHaveBeenCalledTimes(2);
      expect(result.current.sequenceComplete).toBe(true);
      expect(result.current.stepStatusMap.stark_verification.status).toBe('success');
      expect(warnSpy).toHaveBeenCalledWith('[Verify] Failed to trigger STARK verification run', expect.any(Error));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('triggers STARK verification run only once even when status stays not_run', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'not_run',
      verificationSteps: buildSteps('success'),
    };

    const fetchVerification = vi.fn().mockResolvedValue({ ...data, verificationStatus: 'not_run' });
    const triggerStarkVerificationRunMock = vi.fn().mockResolvedValue(undefined);
    const triggerStarkVerificationRun = async (): Promise<void> => {
      await triggerStarkVerificationRunMock();
    };

    const { result } = setup(data, fetchVerification, triggerStarkVerificationRun);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(triggerStarkVerificationRunMock).toHaveBeenCalledTimes(1);
    expect(result.current.sequenceComplete).toBe(true);
    expect(result.current.stepStatusMap.stark_verification.status).toBe('failed');
    expect(result.current.stepStatusMap.stark_verification.error).toMatch(/timeout/i);
  });

  it('marks STARK as failed after polling timeout', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'running',
      verificationSteps: buildSteps('success'),
    };

    const fetchVerification = vi.fn().mockResolvedValue({ ...data, verificationStatus: 'running' });

    const { result } = setup(data, fetchVerification);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.sequenceComplete).toBe(true);
    expect(result.current.stepStatusMap.stark_verification.status).toBe('failed');
    expect(result.current.stepStatusMap.stark_verification.error).toMatch(/timeout/i);
  });

  it('marks STARK as failed when polling returns an error before proof details are available', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'running',
      verificationSteps: buildSteps('not_run'),
    };

    const fetchVerification = vi.fn().mockRejectedValue(new Error('network failed'));

    const { result } = setup(data, fetchVerification);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.sequenceComplete).toBe(true);
    expect(result.current.stepStatusMap.stark_verification.status).toBe('failed');
    expect(result.current.stepStatusMap.stark_verification.error).toBe('network failed');
  });

  it('uses the latest payload returned from STARK polling to resolve steps', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'running',
      verificationSteps: buildSteps('failed'),
    };

    const refreshed: VerificationPayload = {
      verificationStatus: 'success',
      verificationSteps: buildSteps('success'),
    };

    const fetchVerification = vi.fn().mockResolvedValue(refreshed);
    const { result } = setup(data, fetchVerification);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(fetchVerification).toHaveBeenCalled();
    expect(result.current.stepStatusMap.cast_as_intended.status).toBe('success');
    expect(result.current.stepStatusMap.stark_verification.status).toBe('success');
  });

  it('prefers the API stark_verification step over a broad failed verificationStatus', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'failed',
      verificationSteps: [
        { id: 'cast_as_intended', status: 'success' },
        { id: 'recorded_as_cast', status: 'failed' },
        { id: 'counted_as_recorded', status: 'failed' },
        { id: 'stark_verification', status: 'success' },
      ],
      verificationChecks: [
        { id: 'stark_image_id_match', status: 'success', evidence: 'zk', inputs: ['imageId'] },
        { id: 'stark_receipt_verify', status: 'success', evidence: 'zk', inputs: ['proofBundleStatus'] },
      ],
    };

    const { result, fetchVerification } = setup(data);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(fetchVerification).not.toHaveBeenCalled();
    expect(result.current.sequenceComplete).toBe(true);
    expect(result.current.stepStatusMap.stark_verification.status).toBe('success');
  });

  it('waits for STARK before publishing evidence and all four stages', async () => {
    const data: VerificationPayload = {
      ...voterEvidence,
      verificationStatus: 'running',
      verificationSteps: buildSteps('success'),
    };

    const resolveRef: { resolve: (v: VerificationPayload) => void } = { resolve: () => {} };
    const starkPromise = new Promise<VerificationPayload>((resolve) => {
      resolveRef.resolve = resolve;
    });

    const fetchVerification = vi.fn().mockReturnValue(starkPromise);
    const { result } = setup(data, fetchVerification);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.visibleStepCount).toBe(0);
    expect(result.current.verificationStarted).toBe(true);
    expect(result.current.sequenceComplete).toBe(false);
    expect(mockSaveKnowledgeData).not.toHaveBeenCalled();

    await act(async () => {
      resolveRef.resolve({ ...data, verificationStatus: 'success' });
    });

    expect(result.current.visibleStepCount).toBe(4);
    expect(result.current.sequenceComplete).toBe(true);
    expect(mockSaveKnowledgeData).toHaveBeenCalledExactlyOnceWith(
      { 'user.voteReceipt': voterEvidence.voteReceipt, 'user.merklePath': voterEvidence.userVote.proof },
      { expectedSessionId: ACTIVE_SESSION.sessionId },
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['unmounted', 'session_replaced'] as const)(
    'does not publish resolved evidence or completion after the view is %s',
    async (invalidation) => {
      const data: VerificationPayload = {
        ...voterEvidence,
        verificationStatus: 'running',
        verificationSteps: buildSteps('success'),
      };
      const pending = Promise.withResolvers<VerificationPayload>();
      const fetchVerification = vi.fn<() => Promise<VerificationPayload>>().mockReturnValue(pending.promise);
      const { result, unmount, onError } = setup(data, fetchVerification);
      let completion: Promise<void> | undefined;
      act(() => {
        completion = result.current.startVerification();
      });
      if (invalidation === 'unmounted') {
        unmount();
      } else {
        mockGetSessionDataForIdentity.mockReturnValue(null);
        mockIsSessionReplacedForIdentity.mockReturnValue(true);
      }

      await act(async () => {
        pending.resolve({ ...data, verificationStatus: 'success' });
        await completion;
      });

      expect(mockSaveKnowledgeData).not.toHaveBeenCalled();
      expect(result.current.sequenceComplete).toBe(false);
      expect(result.current.visibleStepCount).toBe(0);
      if (invalidation === 'session_replaced') {
        expect(onError).toHaveBeenCalledExactlyOnceWith('pages.verify.sessionReplaced');
      }
    },
  );

  it.each(['trigger', 'poll'] as const)(
    'stops without publishing stale evidence when the %s invalidates verification authority',
    async (boundary) => {
      const data: VerificationPayload = {
        ...voterEvidence,
        verificationStatus: boundary === 'trigger' ? 'not_run' : 'running',
        verificationSteps: buildSteps('success'),
      };
      const error = new VerificationClientApiError('Finalization is no longer current', {
        invalidation: 'clear_finalized_projection',
        responseStatus: 409,
      });
      const trigger = vi.fn<() => Promise<void>>().mockRejectedValue(error);
      const fetchVerification = vi.fn<() => Promise<VerificationPayload>>().mockRejectedValue(error);
      const { result, onError } = setup(data, fetchVerification, trigger);

      await act(async () => {
        await result.current.startVerification();
      });

      expect(onError).toHaveBeenCalledExactlyOnceWith(error.message);
      expect(mockSaveKnowledgeData).not.toHaveBeenCalled();
      expect(result.current.sequenceComplete).toBe(false);
      expect(result.current.visibleStepCount).toBe(0);
      expect(fetchVerification).toHaveBeenCalledTimes(boundary === 'poll' ? 1 : 0);
    },
  );
});

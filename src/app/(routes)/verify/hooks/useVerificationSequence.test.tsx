import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MutableRefObject } from 'react';
import type { VerificationPayload } from '../lib/verification-data';
import type { VerificationStepStatus } from '@/lib/knowledge';
import type { SessionIdentity } from '@/lib/session';
import { useVerificationSequence } from './useVerificationSequence';

vi.mock('@/lib/session', () => ({
  getSessionData: vi.fn(),
  getSessionDataForIdentity: vi.fn(),
  isSessionReplaced: vi.fn(() => false),
  isSessionReplacedForIdentity: vi.fn(() => false),
}));

const sessionModule = await import('@/lib/session');
const mockGetSessionData = vi.mocked(sessionModule.getSessionData);
const mockGetSessionDataForIdentity = vi.mocked(sessionModule.getSessionDataForIdentity);
const mockIsSessionReplacedForIdentity = vi.mocked(sessionModule.isSessionReplacedForIdentity);

const buildSteps = (status: VerificationStepStatus): NonNullable<VerificationPayload['verificationSteps']> => [
  { id: 'cast_as_intended', status },
  { id: 'recorded_as_cast', status },
  { id: 'counted_as_recorded', status },
  { id: 'stark_verification', status },
];

const setup = (
  data: VerificationPayload,
  fetchVerification?: ReturnType<typeof vi.fn>,
  triggerStarkVerificationRun?: () => Promise<void>,
) => {
  const fetchFn = fetchVerification ?? vi.fn().mockResolvedValue(data);
  const fetchVerificationRef = {
    current: fetchFn,
  } as MutableRefObject<() => Promise<VerificationPayload>>;
  const verificationStartedRef = { current: false } as MutableRefObject<boolean>;
  const sessionIdentityRef = {
    current: {
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
    },
  } as MutableRefObject<SessionIdentity | null>;
  const triggerRunMock = triggerStarkVerificationRun ?? (() => Promise.resolve());
  const triggerRunFn = async (): Promise<void> => {
    await triggerRunMock();
  };

  const hook = renderHook(() =>
    useVerificationSequence({
      data,
      t: (key) => key,
      fetchVerificationRef,
      onError: vi.fn(),
      verificationStartedRef,
      triggerStarkVerificationRun: triggerRunFn,
      sessionIdentityRef,
    }),
  );

  return { ...hook, fetchVerificationRef, fetchVerification: fetchFn, triggerStarkVerificationRun: triggerRunMock };
};

describe('useVerificationSequence', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.useFakeTimers();
    mockGetSessionData.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
    });
    mockGetSessionDataForIdentity.mockReturnValue({
      sessionId: 'test-session',
      capabilityToken: 'test-capability-token',
      lastActivity: Date.now(),
    });
    mockIsSessionReplacedForIdentity.mockReturnValue(false);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('completes without an extra STARK delay when status already succeeded', async () => {
    const data: VerificationPayload = {
      verificationStatus: 'success',
      verificationSteps: buildSteps('success'),
    };

    const { result, fetchVerification } = setup(data);

    act(() => {
      void result.current.startVerification();
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.sequenceComplete).toBe(true);
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

  it('waits for STARK to resolve before showing any steps', async () => {
    // Given: STARK verification is running (not yet complete)
    const data: VerificationPayload = {
      verificationStatus: 'running',
      verificationSteps: buildSteps('success'),
    };

    const resolveRef: { resolve: (v: VerificationPayload) => void } = { resolve: () => {} };
    const starkPromise = new Promise<VerificationPayload>((resolve) => {
      resolveRef.resolve = resolve;
    });

    const fetchVerification = vi.fn().mockReturnValue(starkPromise);
    const { result } = setup(data, fetchVerification);

    // When: verification sequence starts
    act(() => {
      void result.current.startVerification();
    });

    // Then: no steps should be visible while STARK is being polled
    // (cascade display should wait for STARK to complete)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.visibleStepCount).toBe(0);
    expect(result.current.verificationStarted).toBe(true);

    // When: STARK resolves
    await act(async () => {
      resolveRef.resolve({ ...data, verificationStatus: 'success' });
      await vi.runAllTimersAsync();
    });

    // Then: steps should become visible and sequence should complete
    expect(result.current.visibleStepCount).toBeGreaterThan(0);
    expect(result.current.sequenceComplete).toBe(true);
  });
});

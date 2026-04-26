import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { ProverWorkMessage } from '@/lib/finalize/types';
import { publishFinalizeMessageWithRetry } from '@/lib/finalize/finalization-queue';
import { logger } from '@/lib/utils/logger';

const message = { sessionId: 'test-session' } as ProverWorkMessage;

describe('publishFinalizeMessageWithRetry', () => {
  let warnSpy: MockInstance<typeof logger.warn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('retries until success', async () => {
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValueOnce(undefined);

    await publishFinalizeMessageWithRetry(publish, message, 3);

    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting attempts', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(publishFinalizeMessageWithRetry(publish, message, 2)).rejects.toThrow('fail');
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('defaults to one attempt when maxAttempts is invalid', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(publishFinalizeMessageWithRetry(publish, message, 0)).rejects.toThrow('fail');
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

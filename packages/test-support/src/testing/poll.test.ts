import { describe, expect, it, vi } from 'vitest';
import { pollUntil, type PollDelayContext } from './poll';

describe('pollUntil', () => {
  it('runs the exact maximum attempts and delays after every non-terminal result, including the last', async () => {
    const operation = vi.fn(({ attempt }: { attempt: number }) => Promise.resolve(`retry-${attempt}`));
    const delay = vi.fn((context: PollDelayContext<string>) => {
      void context;
      return Promise.resolve();
    });

    await expect(
      pollUntil({
        maxAttempts: 3,
        operation,
        isTerminal: () => false,
        delay,
        createTimeoutError: ({ attempts, lastResult }) =>
          new Error(`timed out after ${attempts} attempts with ${lastResult ?? 'no result'}`),
      }),
    ).rejects.toThrow('timed out after 3 attempts with retry-2');

    expect(operation).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls.map(([context]) => context)).toEqual([
      { attempt: 0, result: 'retry-0' },
      { attempt: 1, result: 'retry-1' },
      { attempt: 2, result: 'retry-2' },
    ]);
  });

  it('returns the terminal result without another delay', async () => {
    const delay = vi.fn(() => Promise.resolve());

    await expect(
      pollUntil({
        maxAttempts: 3,
        operation: ({ attempt }) => Promise.resolve(attempt),
        isTerminal: (result) => result === 1,
        delay,
        createTimeoutError: () => new Error('unexpected timeout'),
      }),
    ).resolves.toBe(1);

    expect(delay).toHaveBeenCalledOnce();
  });

  it('checks a deadline before the pre-attempt delay and does not recheck it before the operation', async () => {
    let now = 10;
    const events: string[] = [];

    await expect(
      pollUntil({
        deadlineMs: 10,
        clock: () => now,
        delayPosition: 'before-attempt',
        delay: ({ attempt }) => {
          events.push(`delay-${attempt}`);
          now = 11;
          return Promise.resolve();
        },
        operation: ({ attempt }) => {
          events.push(`operation-${attempt}`);
          return Promise.resolve('retry');
        },
        isTerminal: () => false,
        createTimeoutError: ({ attempts }) => new Error(`deadline after ${attempts} attempts`),
      }),
    ).rejects.toThrow('deadline after 1 attempts');

    expect(events).toEqual(['delay-0', 'operation-0']);
  });

  it('allows a zero-attempt limit for caller-preserved fail-fast behavior', async () => {
    const operation = vi.fn(() => Promise.resolve('unused'));
    const delay = vi.fn(() => Promise.resolve());

    await expect(
      pollUntil({
        maxAttempts: 0,
        operation,
        isTerminal: () => false,
        delay,
        createTimeoutError: ({ attempts, lastResult }) =>
          new Error(`stopped at ${attempts} with ${lastResult ?? 'no result'}`),
      }),
    ).rejects.toThrow('stopped at 0 with no result');

    expect(operation).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it('rejects invalid limits before calling the operation', async () => {
    const operation = vi.fn(() => Promise.resolve('unused'));

    await expect(
      pollUntil({
        maxAttempts: -1,
        operation,
        isTerminal: () => false,
        delay: () => Promise.resolve(),
        createTimeoutError: () => new Error('unused'),
      }),
    ).rejects.toThrow('maxAttempts must be a non-negative integer');

    expect(operation).not.toHaveBeenCalled();
  });
});

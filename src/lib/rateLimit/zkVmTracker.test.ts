import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { canExecuteZkVm, recordZkVmExecution, getRemainingExecutions, clearExpiredExecutions } from './zkVmTracker';
import { getNumberArrayProperty, getNumberProperty, isRecord } from '@/lib/utils/guards';

describe('zkVmTracker', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow execution when no history exists', () => {
    expect(canExecuteZkVm()).toBe(true);
    expect(getRemainingExecutions()).toBe(50);
  });

  it('should record execution with timestamp', () => {
    const now = new Date('2023-01-01T12:00:00Z').getTime();
    vi.setSystemTime(now);

    recordZkVmExecution();

    const storedRaw = localStorage.getItem('zkVmExecutions');
    const stored: unknown = storedRaw ? JSON.parse(storedRaw) : {};
    const storedRecord = isRecord(stored) ? stored : {};
    const timestamps = getNumberArrayProperty(storedRecord, 'timestamps') ?? [];
    expect(timestamps).toContain(now);
    expect(getNumberProperty(storedRecord, 'lastReset')).toBe(now);
  });

  it('should allow up to 50 executions in 24 hours', () => {
    const baseTime = new Date('2023-01-01T12:00:00Z').getTime();
    vi.setSystemTime(baseTime);

    // Record 50 executions
    for (let i = 0; i < 50; i++) {
      expect(canExecuteZkVm()).toBe(true);
      recordZkVmExecution();
      vi.setSystemTime(baseTime + i * 60 * 1000); // 1 minute apart
    }

    // 51st execution should be blocked
    expect(canExecuteZkVm()).toBe(false);
    expect(getRemainingExecutions()).toBe(0);
  });

  it('should remove executions older than 24 hours', () => {
    const baseTime = new Date('2023-01-01T12:00:00Z').getTime();

    // Record executions at different times
    vi.setSystemTime(baseTime - 25 * 60 * 60 * 1000); // 25 hours ago
    recordZkVmExecution();

    vi.setSystemTime(baseTime - 23 * 60 * 60 * 1000); // 23 hours ago
    recordZkVmExecution();

    vi.setSystemTime(baseTime);

    // Clear expired executions
    clearExpiredExecutions();

    // Should only have 1 execution remaining (the one from 23 hours ago)
    expect(getRemainingExecutions()).toBe(49);
  });

  it('should automatically clear expired executions when checking', () => {
    const baseTime = new Date('2023-01-01T12:00:00Z').getTime();

    // Record old execution
    vi.setSystemTime(baseTime - 25 * 60 * 60 * 1000);
    recordZkVmExecution();

    // Check 25 hours later
    vi.setSystemTime(baseTime);

    expect(canExecuteZkVm()).toBe(true);
    expect(getRemainingExecutions()).toBe(50);
  });

  it('should handle multiple executions with proper timing', () => {
    const baseTime = new Date('2023-01-01T12:00:00Z').getTime();

    // Record 3 executions spread over time
    vi.setSystemTime(baseTime);
    recordZkVmExecution();

    vi.setSystemTime(baseTime + 10 * 60 * 60 * 1000); // 10 hours later
    recordZkVmExecution();

    vi.setSystemTime(baseTime + 20 * 60 * 60 * 1000); // 20 hours later
    recordZkVmExecution();

    expect(getRemainingExecutions()).toBe(47);

    // Move to 25 hours after first execution
    vi.setSystemTime(baseTime + 25 * 60 * 60 * 1000);

    // First execution should be expired
    expect(getRemainingExecutions()).toBe(48);
  });
});

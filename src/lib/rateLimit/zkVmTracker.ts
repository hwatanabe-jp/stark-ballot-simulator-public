interface ZkVmExecutions {
  timestamps: number[];
  lastReset: number;
}

const STORAGE_KEY = 'zkVmExecutions';
const DEFAULT_MAX_EXECUTIONS = 50;
const parsedMaxExecutions = Number(process.env.NEXT_PUBLIC_ZKVM_RATE_LIMIT_PER_IP);
const MAX_EXECUTIONS =
  Number.isFinite(parsedMaxExecutions) && parsedMaxExecutions > 0 ? parsedMaxExecutions : DEFAULT_MAX_EXECUTIONS;
const TIME_WINDOW = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

function canAccessStorage(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isZkVmExecutions(value: unknown): value is ZkVmExecutions {
  if (!isRecord(value)) {
    return false;
  }

  return isNumberArray(value.timestamps) && isFiniteNumber(value.lastReset);
}

function getExecutions(): ZkVmExecutions {
  const now = Date.now();
  const fallback: ZkVmExecutions = { timestamps: [], lastReset: now };

  if (!canAccessStorage()) {
    return fallback;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return fallback;
    }
    const parsed: unknown = JSON.parse(stored);
    return isZkVmExecutions(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function saveExecutions(executions: ZkVmExecutions): void {
  if (!canAccessStorage()) {
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(executions));
}

export function clearExpiredExecutions(): void {
  if (!canAccessStorage()) {
    return;
  }
  const executions = getExecutions();
  const now = Date.now();
  const cutoffTime = now - TIME_WINDOW;

  // Filter out executions older than 24 hours
  const validTimestamps = executions.timestamps.filter((timestamp) => timestamp > cutoffTime);

  saveExecutions({
    timestamps: validTimestamps,
    lastReset: executions.lastReset,
  });
}

export function canExecuteZkVm(): boolean {
  // Skip rate limiting in test mode
  if (typeof window !== 'undefined' && localStorage.getItem('testMode') === 'true') {
    return true;
  }
  if (!canAccessStorage()) {
    return true;
  }

  clearExpiredExecutions();
  const executions = getExecutions();
  return executions.timestamps.length < MAX_EXECUTIONS;
}

export function recordZkVmExecution(): void {
  if (!canAccessStorage()) {
    return;
  }
  clearExpiredExecutions();
  const executions = getExecutions();
  const now = Date.now();

  executions.timestamps.push(now);
  if (executions.lastReset === 0) {
    executions.lastReset = now;
  }

  saveExecutions(executions);
}

export function getRemainingExecutions(): number {
  if (!canAccessStorage()) {
    return MAX_EXECUTIONS;
  }
  clearExpiredExecutions();
  const executions = getExecutions();
  return Math.max(0, MAX_EXECUTIONS - executions.timestamps.length);
}

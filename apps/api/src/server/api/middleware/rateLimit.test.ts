import { describe, expect, it, vi, afterEach, type MockInstance } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VoteRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/voteRateLimit';
import type { ServerRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/serverRateLimit';
import {
  consumeVoteRateLimit,
  enforceFinalizeCancelRateLimit,
  enforceFinalizeRateLimit,
  enforceSessionCreateRateLimit,
  enforceVoteRateLimit,
  recordFinalizeRateLimit,
} from './rateLimit';
import {
  resetSharedDynamoDocumentClientForTests,
  setSharedDynamoDocumentClientForTests,
} from '@stark-ballot/aws-adapters/aws/dynamodbConfig';
import { resetSessionCreateRateLimiter } from '@stark-ballot/aws-adapters/rate-limit/sessionCreateRateLimit';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { logger } from '@stark-ballot/diagnostics/logger';
import { getRecordProperty, getStringProperty } from '@stark-ballot/validation/unknown-value-guards';

const LOCAL_RUNTIME_PROFILE = localRuntimeProfile();
const TARGET_RUNTIME_PROFILE = targetRuntimeProfile();

afterEach(() => {
  vi.restoreAllMocks();
});

function expectRateLimitWarning(spy: MockInstance<typeof logger.warn>, reason: string): void {
  const call = spy.mock.calls[0];
  const fields = call?.[1];
  const rateLimit = getRecordProperty(fields, 'rate_limit');
  expect(spy).toHaveBeenCalledTimes(1);
  expect(call?.[0]).toBe('rate limit exceeded');
  expect(getStringProperty(fields, 'event')).toBe('rate_limit_hit');
  expect(rateLimit?.['hit']).toBe(true);
  expect(getStringProperty(rateLimit, 'reason')).toBe(reason);
  expect(getStringProperty(rateLimit, 'ip_hash')).toMatch(/^ip_[a-f0-9]{12}$/);
}

type CommandLike = {
  constructor: { name: string };
  input: Record<string, unknown>;
};

class FakeDynamoRateLimitDocumentClient {
  readonly commands: string[] = [];
  readonly inputs: Record<string, unknown>[] = [];
  private readonly failWrites: boolean;

  constructor(failWrites = false) {
    this.failWrites = failWrites;
  }

  send(command: CommandLike): Promise<Record<string, unknown>> {
    this.commands.push(command.constructor.name);
    this.inputs.push(command.input);
    if (command.constructor.name === 'PutCommand') {
      if (this.failWrites) {
        return Promise.reject(new Error('dynamodb unavailable'));
      }
      return Promise.resolve({});
    }
    if (command.constructor.name === 'QueryCommand') {
      return Promise.resolve({ Count: 1 });
    }
    throw new Error(`Unsupported command: ${command.constructor.name}`);
  }
}

function asDocumentClient(client: FakeDynamoRateLimitDocumentClient): DynamoDBDocumentClient {
  return client as unknown as DynamoDBDocumentClient;
}

describe('runtime profile injection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows the local profile unknown-client fallback', async () => {
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    const result = await enforceVoteRateLimit(localRuntimeProfile(), undefined, attemptLimiter);

    expect(result).not.toBeInstanceOf(Response);
    expect(attemptLimiter.consume).toHaveBeenCalledWith('0.0.0.0');
  });

  it('fails closed for a target profile without a client IP', async () => {
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    const result = await enforceVoteRateLimit(targetRuntimeProfile(), undefined, attemptLimiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(getApiErrorCode(await readJsonRecord(result, 'target missing IP'))).toBe('INVALID_REQUEST');
    }
    expect(attemptLimiter.consume).not.toHaveBeenCalled();
  });
});

describe('enforceVoteRateLimit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('consumes attempt limiter when allowed', async () => {
    // Given
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    // When
    const result = await enforceVoteRateLimit(LOCAL_RUNTIME_PROFILE, undefined, attemptLimiter);

    // Then
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('0.0.0.0');
    }
    expect(attemptLimiter.consume).toHaveBeenCalledWith('0.0.0.0');
  });

  it('returns GLOBAL_LIMIT_EXCEEDED when blocked', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Given
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 42 }),
    };

    // When
    const result = await enforceVoteRateLimit(LOCAL_RUNTIME_PROFILE, '203.0.113.5', attemptLimiter);

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote rate limit');
      expect(getApiErrorCode(payload)).toBe('GLOBAL_LIMIT_EXCEEDED');
      expect(attemptLimiter.consume).toHaveBeenCalledWith('203.0.113.5');
    }
    expectRateLimitWarning(loggerWarnSpy, 'vote_attempt');
  });

  it('returns INVALID_REQUEST when client IP is missing in production', async () => {
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    const result = await enforceVoteRateLimit(TARGET_RUNTIME_PROFILE, undefined, attemptLimiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote rate limit missing ip');
      expect(getApiErrorCode(payload)).toBe('INVALID_REQUEST');
    }
    expect(attemptLimiter.consume).not.toHaveBeenCalled();
  });

  it('allows missing client IP for the injected local profile', async () => {
    const attemptLimiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    const result = await enforceVoteRateLimit(LOCAL_RUNTIME_PROFILE, undefined, attemptLimiter);

    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('0.0.0.0');
    }
    expect(attemptLimiter.consume).toHaveBeenCalledWith('0.0.0.0');
  });
});

describe('enforceSessionCreateRateLimit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetSessionCreateRateLimiter();
    resetSharedDynamoDocumentClientForTests();
  });

  it('consumes session-create limiter when allowed', async () => {
    const limiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 5 }),
    };

    const result = await enforceSessionCreateRateLimit(LOCAL_RUNTIME_PROFILE, undefined, limiter);

    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('0.0.0.0');
    }
    expect(limiter.consume).toHaveBeenCalledWith('0.0.0.0');
  });

  it('returns GLOBAL_LIMIT_EXCEEDED when blocked', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const limiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 30 }),
    };

    const result = await enforceSessionCreateRateLimit(LOCAL_RUNTIME_PROFILE, '203.0.113.7', limiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'session create rate limit');
      expect(getApiErrorCode(payload)).toBe('GLOBAL_LIMIT_EXCEEDED');
    }
    expect(limiter.consume).toHaveBeenCalledWith('203.0.113.7');
    expectRateLimitWarning(loggerWarnSpy, 'session_create');
  });

  it('constructs and uses the DynamoDB-backed limiter path when explicitly enabled for tests', async () => {
    vi.stubEnv('RATE_LIMIT_EVENTS_TABLE', 'untrusted-events');
    vi.stubEnv('RATE_LIMIT_COUNTERS_TABLE', 'untrusted-counters');
    vi.stubEnv('AWS_REGION', 'ap-northeast-1');
    const client = new FakeDynamoRateLimitDocumentClient();
    setSharedDynamoDocumentClientForTests(asDocumentClient(client));

    const result = await enforceSessionCreateRateLimit(TARGET_RUNTIME_PROFILE, '203.0.113.7');

    expect(result).not.toBeInstanceOf(Response);
    expect(client.commands).toEqual(['PutCommand', 'QueryCommand']);
    if (TARGET_RUNTIME_PROFILE.external.kind !== 'aws') {
      throw new Error('Expected target runtime profile');
    }
    expect(client.inputs.map((input) => input['TableName'])).toEqual([
      TARGET_RUNTIME_PROFILE.external.dynamo.rateLimitEventsTable,
      TARGET_RUNTIME_PROFILE.external.dynamo.rateLimitEventsTable,
    ]);
  });

  it('fails closed when the DynamoDB-backed limiter storage is unavailable', async () => {
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.stubEnv('RATE_LIMIT_EVENTS_TABLE', 'rate-limit-events');
    vi.stubEnv('RATE_LIMIT_COUNTERS_TABLE', 'rate-limit-counters');
    vi.stubEnv('AWS_REGION', 'ap-northeast-1');
    const client = new FakeDynamoRateLimitDocumentClient(true);
    setSharedDynamoDocumentClientForTests(asDocumentClient(client));

    const result = await enforceSessionCreateRateLimit(TARGET_RUNTIME_PROFILE, '203.0.113.7');

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'session create dynamo rate limit storage error');
      expect(getApiErrorCode(payload)).toBe('GLOBAL_LIMIT_EXCEEDED');
      expect(payload).not.toHaveProperty('reason');
    }
    expect(client.commands).toEqual(['PutCommand']);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith('rate limit storage error', {
      event: 'rate_limit_error',
      rate_limit: { hit: false, reason: 'storage_error' },
      error: { operation: 'recordEvent', cause: 'dynamodb unavailable' },
    });
  });
});

describe('enforceFinalizeCancelRateLimit', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('consumes cancel limiter when allowed', async () => {
    const limiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 1 }),
    };

    const result = await enforceFinalizeCancelRateLimit(LOCAL_RUNTIME_PROFILE, '203.0.113.9', limiter);

    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('203.0.113.9');
    }
    expect(limiter.consume).toHaveBeenCalledWith('203.0.113.9');
  });

  it('returns GLOBAL_LIMIT_EXCEEDED when cancel is rate-limited', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const limiter: Pick<VoteRateLimiter, 'consume'> = {
      consume: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 15 }),
    };

    const result = await enforceFinalizeCancelRateLimit(LOCAL_RUNTIME_PROFILE, '203.0.113.9', limiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'finalize cancel rate limit');
      expect(getApiErrorCode(payload)).toBe('GLOBAL_LIMIT_EXCEEDED');
    }
    expect(limiter.consume).toHaveBeenCalledWith('203.0.113.9');
    expectRateLimitWarning(loggerWarnSpy, 'finalize_cancel');
  });
});

describe('consumeVoteRateLimit', () => {
  it('records usage when allowed', async () => {
    const rateLimiter: Pick<VoteRateLimiter, 'check' | 'record' | 'consume'> = {
      check: vi.fn().mockReturnValue({ allowed: true, remaining: 1 }),
      record: vi.fn(),
      consume: vi.fn().mockReturnValue({ allowed: true, remaining: 0 }),
    };

    const result = await consumeVoteRateLimit(LOCAL_RUNTIME_PROFILE, '203.0.113.5', rateLimiter);

    expect(result).toBeNull();
    expect(rateLimiter.consume).toHaveBeenCalledWith('203.0.113.5');
    expect(rateLimiter.record).not.toHaveBeenCalled();
  });

  it('returns GLOBAL_LIMIT_EXCEEDED when blocked', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const rateLimiter: Pick<VoteRateLimiter, 'check' | 'record' | 'consume'> = {
      check: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 42 }),
      record: vi.fn(),
      consume: vi.fn().mockReturnValue({ allowed: false, remaining: 0, retryAfter: 42 }),
    };

    const result = await consumeVoteRateLimit(LOCAL_RUNTIME_PROFILE, '203.0.113.5', rateLimiter);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'vote rate limit');
      expect(getApiErrorCode(payload)).toBe('GLOBAL_LIMIT_EXCEEDED');
    }
    expect(rateLimiter.record).not.toHaveBeenCalled();
    expect(rateLimiter.consume).toHaveBeenCalledWith('203.0.113.5');
    expectRateLimitWarning(loggerWarnSpy, 'vote_consume');
  });
});

describe('enforceFinalizeRateLimit', () => {
  it('skips persistent checks for the injected memory rate-limit profile', async () => {
    // Given
    const rateLimiter: Pick<
      ServerRateLimiter,
      'checkZkVmRateLimit' | 'checkGlobalLimit' | 'recordZkVmExecution' | 'incrementGlobalCount'
    > = {
      checkZkVmRateLimit: vi.fn().mockResolvedValue({ allowed: true, remainingExecutions: 1 }),
      checkGlobalLimit: vi.fn().mockResolvedValue({ allowed: true, currentCount: 0, limit: 10 }),
      recordZkVmExecution: vi.fn().mockResolvedValue(undefined),
      incrementGlobalCount: vi.fn().mockResolvedValue(1),
    };
    const attemptLimiter: Pick<ServerRateLimiter, 'consumeZkVmExecution'> = {
      consumeZkVmExecution: vi.fn().mockResolvedValue({ allowed: true, remainingExecutions: 1 }),
    };

    // When
    const result = await enforceFinalizeRateLimit(LOCAL_RUNTIME_PROFILE, undefined, {
      rateLimiter,
      attemptLimiter,
    });

    // Then
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.clientIp).toBe('0.0.0.0');
      expect(result.shouldRecord).toBe(false);
    }
    expect(rateLimiter.checkZkVmRateLimit).not.toHaveBeenCalled();
    expect(attemptLimiter.consumeZkVmExecution).not.toHaveBeenCalled();
  });

  it('returns ZKVM_RATE_LIMIT_EXCEEDED when IP limit is hit', async () => {
    const loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Given
    const rateLimiter: Pick<
      ServerRateLimiter,
      'checkZkVmRateLimit' | 'checkGlobalLimit' | 'recordZkVmExecution' | 'incrementGlobalCount'
    > = {
      checkZkVmRateLimit: vi.fn().mockResolvedValue({
        allowed: false,
        remainingExecutions: 0,
        nextAvailableAt: '2025-01-01T00:00:00.000Z',
      }),
      checkGlobalLimit: vi.fn().mockResolvedValue({ allowed: true, currentCount: 0, limit: 10 }),
      recordZkVmExecution: vi.fn().mockResolvedValue(undefined),
      incrementGlobalCount: vi.fn().mockResolvedValue(1),
    };
    const attemptLimiter: Pick<ServerRateLimiter, 'consumeZkVmExecution'> = {
      consumeZkVmExecution: vi.fn().mockResolvedValue({
        allowed: true,
        remainingExecutions: 0,
        nextAvailableAt: '2025-01-01T00:00:00.000Z',
      }),
    };

    // When
    const result = await enforceFinalizeRateLimit(TARGET_RUNTIME_PROFILE, '203.0.113.5', {
      rateLimiter,
      attemptLimiter,
    });

    // Then
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      const payload = await readJsonRecord(result, 'finalize rate limit');
      expect(getApiErrorCode(payload)).toBe('ZKVM_RATE_LIMIT_EXCEEDED');
    }
    expect(rateLimiter.checkGlobalLimit).not.toHaveBeenCalled();
    expectRateLimitWarning(loggerWarnSpy, 'zkvm_ip');
  });
});

describe('recordFinalizeRateLimit', () => {
  it('records counters when enabled', async () => {
    // Given
    const rateLimiter: Pick<ServerRateLimiter, 'recordZkVmExecution' | 'incrementGlobalCount'> = {
      recordZkVmExecution: vi.fn().mockResolvedValue(undefined),
      incrementGlobalCount: vi.fn().mockResolvedValue(1),
    };

    // When
    await recordFinalizeRateLimit(rateLimiter, '203.0.113.5', true);

    // Then
    expect(rateLimiter.recordZkVmExecution).toHaveBeenCalledWith('203.0.113.5');
    expect(rateLimiter.incrementGlobalCount).toHaveBeenCalledWith('daily');
    expect(rateLimiter.incrementGlobalCount).toHaveBeenCalledWith('hourly');
  });

  it('skips recording when disabled', async () => {
    // Given
    const rateLimiter: Pick<ServerRateLimiter, 'recordZkVmExecution' | 'incrementGlobalCount'> = {
      recordZkVmExecution: vi.fn().mockResolvedValue(undefined),
      incrementGlobalCount: vi.fn().mockResolvedValue(1),
    };

    // When
    await recordFinalizeRateLimit(rateLimiter, '203.0.113.5', false);

    // Then
    expect(rateLimiter.recordZkVmExecution).not.toHaveBeenCalled();
    expect(rateLimiter.incrementGlobalCount).not.toHaveBeenCalled();
  });
});

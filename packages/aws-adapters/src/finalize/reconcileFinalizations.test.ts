import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import {
  reconcileFinalization,
  type FinalizationReconciliationPorts,
} from '@stark-ballot/application/finalize/reconcile-finalization';
import { targetRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import { reconcileAwsFinalizations } from './reconcileFinalizations';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

const mocks = vi.hoisted(() => ({ query: vi.fn(), describe: vi.fn(), destroy: vi.fn() }));
vi.mock('../aws/dynamodbConfig', () => ({ getSharedDynamoDocumentClient: () => ({ send: mocks.query }) }));
vi.mock('@aws-sdk/client-sfn', async (original) => ({
  ...(await original<typeof import('@aws-sdk/client-sfn')>()),
  SFNClient: class {
    send = mocks.describe;
    destroy = mocks.destroy;
  },
}));
vi.mock('@stark-ballot/application/finalize/reconcile-finalization', () => ({ reconcileFinalization: vi.fn() }));
const profile = targetRuntimeProfile();
const sessionId = asSessionId('reconcile-session');
const finalizationId = asFinalizationId('reconcile-execution');
const candidate = { ownerSessionId: sessionId, finalizationId };
const store: FinalizationReconciliationPorts['store'] = {
  getCurrentFinalizationRecord: vi.fn(),
  markFinalizationFailed: vi.fn(),
  markFinalizationTimedOut: vi.fn(),
};
// Only lifecycle methods are needed by this adapter.
const lifecycle = {
  ...store,
  getFinalizationRecord: vi.fn(),
  markFinalizationQueued: vi.fn(),
  markFinalizationRunning: vi.fn(),
  markFinalizationSucceeded: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  mocks.query.mockResolvedValue({ Items: [candidate] });
  vi.stubEnv('FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS', '900');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AWS finalization reconciliation', () => {
  it('queries only unexpired finalization candidates with pagination and reuses lifecycle authority', async () => {
    const cursor = { sessionId: 'cursor' };
    mocks.query
      .mockResolvedValueOnce({ Items: [candidate], LastEvaluatedKey: cursor })
      .mockResolvedValueOnce({ Items: [candidate] });
    await expect(reconcileAwsFinalizations(profile, lifecycle)).resolves.toEqual({ visited: 2 });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    const command = mocks.query.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command).toMatchObject({
      input: {
        IndexName: 'finalization-expiry-index',
        Limit: 25,
        ScanIndexForward: false,
        ExpressionAttributeValues: { ':type': 'FINALIZATION' },
      },
    });
    expect(mocks.query.mock.calls[1]?.[0]).toMatchObject({ input: { ExclusiveStartKey: cursor } });
    expect(vi.mocked(reconcileFinalization).mock.calls[0]?.[0]).toMatchObject({
      sessionId,
      finalizationId,
      dispatchDeadlineMs: 900_000,
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(reconcileFinalization).toHaveBeenCalledOnce();
  });
  it.each(['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'] as const)(
    'binds and normalizes execution observation %s',
    async (status) => {
      mocks.describe.mockResolvedValue({ status, stopDate: new Date(100_000) });
      vi.mocked(reconcileFinalization).mockImplementation(async (input, ports) => {
        expect(await ports.observeExecution(input.sessionId, input.finalizationId)).toEqual(
          status === 'RUNNING' ? { status: 'running' } : { status: status.toLowerCase(), stoppedAtMs: 100_000 },
        );
      });
      await reconcileAwsFinalizations(profile, lifecycle);
      if (profile.external.kind !== 'aws') throw new Error('Expected target profile');
      expect(mocks.describe.mock.calls[0]?.[0]).toBeInstanceOf(DescribeExecutionCommand);
      expect(mocks.describe.mock.calls[0]?.[0]).toMatchObject({
        input: {
          executionArn: `${profile.external.asyncRuntime.proverStateMachineArn.replace(':stateMachine:', ':execution:')}:${finalizationId}`,
        },
      });
    },
  );
  it('normalizes missing execution, but retries permissions/transport failures without treating them as missing', async () => {
    vi.mocked(reconcileFinalization).mockImplementation(async (input, ports) => {
      expect(await ports.observeExecution(input.sessionId, input.finalizationId)).toEqual({ status: 'missing' });
    });
    mocks.describe.mockRejectedValue(Object.assign(new Error('missing'), { name: 'ExecutionDoesNotExist' }));
    await reconcileAwsFinalizations(profile, lifecycle);
    mocks.describe.mockRejectedValue(new Error('ExecutionDoesNotExist mentioned in a different error'));
    await expect(reconcileAwsFinalizations(profile, lifecycle)).rejects.toThrow('one or more candidates');
  });
  it('continues after invalid identities and failed candidates, then fails the invocation for retry/alarms', async () => {
    mocks.query.mockResolvedValue({
      Items: [
        { ownerSessionId: '../bad', finalizationId },
        candidate,
        { ...candidate, finalizationId: 'another-execution' },
      ],
    });
    vi.mocked(reconcileFinalization).mockRejectedValueOnce(new Error('storage failed')).mockResolvedValue(undefined);
    await expect(reconcileAwsFinalizations(profile, lifecycle)).rejects.toThrow('one or more candidates');
    expect(reconcileFinalization).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('Finalization reconciliation candidate failed', {
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalization_id: finalizationId,
      error_name: 'Error',
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('storage failed');
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('../bad');
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(sessionId);
  });
  it('never logs arbitrary error names, messages or causes', async () => {
    vi.mocked(reconcileFinalization).mockRejectedValue(
      Object.assign(new Error('private message', { cause: 'private cause' }), { name: 'PrivateSecret' }),
    );
    await expect(reconcileAwsFinalizations(profile, lifecycle)).rejects.toThrow('one or more candidates');
    const output = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(output).not.toMatch(/private|PrivateSecret/);
    expect(output).toContain('"error_name":"Error"');
  });
  it('propagates a query outage and destroys its execution client', async () => {
    mocks.query.mockRejectedValue(new Error('query unavailable'));
    await expect(reconcileAwsFinalizations(profile, lifecycle)).rejects.toThrow('query unavailable');
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});

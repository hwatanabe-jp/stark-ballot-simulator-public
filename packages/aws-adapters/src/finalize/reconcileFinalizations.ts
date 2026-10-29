import { DescribeExecutionCommand, SFNClient, type DescribeExecutionCommandOutput } from '@aws-sdk/client-sfn';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getSharedDynamoDocumentClient } from '../aws/dynamodbConfig';
import {
  reconcileFinalization,
  type FinalizationExecutionObservation,
} from '@stark-ballot/application/finalize/reconcile-finalization';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import { parseSessionId } from '@stark-ballot/domain/types/identifiers';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

function assertTerminationTime(value: number | undefined): asserts value is number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Missing execution termination time');
}

function observeExecutionResult(execution: DescribeExecutionCommandOutput): FinalizationExecutionObservation {
  switch (execution.status) {
    case 'RUNNING':
      return { status: 'running' };
    case 'SUCCEEDED':
    case 'FAILED':
    case 'TIMED_OUT':
    case 'ABORTED': {
      const stoppedAtMs = execution.stopDate?.getTime();
      assertTerminationTime(stoppedAtMs);
      const statuses = {
        SUCCEEDED: 'succeeded',
        FAILED: 'failed',
        TIMED_OUT: 'timed_out',
        ABORTED: 'aborted',
      } as const;
      return { status: statuses[execution.status], stoppedAtMs };
    }
    case 'PENDING_REDRIVE':
    case undefined:
      throw new Error('Unsupported finalization execution status');
  }
}

async function observeExecution(
  sfn: SFNClient,
  executionPrefix: string,
  id: string,
): Promise<FinalizationExecutionObservation> {
  try {
    const execution = await sfn.send(new DescribeExecutionCommand({ executionArn: `${executionPrefix}${id}` }));
    return observeExecutionResult(execution);
  } catch (error) {
    if (error instanceof Error && error.name === 'ExecutionDoesNotExist') return { status: 'missing' };
    throw error;
  }
}

interface ReconciliationContext {
  store: FinalizationLifecycleStore;
  sfn: SFNClient;
  executionPrefix: string;
  nowMs: number;
  deadlineSeconds: number;
  seen: Set<string>;
}

function logCandidateFailure(error: unknown, sessionId: string | undefined, finalizationId: string | undefined): void {
  // Error messages, causes and arbitrary error names can contain private persisted/SDK data.
  const errorName = error instanceof Error ? error.name : '';
  const sessionHash = sessionId ? hashSessionIdForLogging(sessionId) : undefined;
  logger.error('Finalization reconciliation candidate failed', {
    ...(sessionHash ? { session_id_hash: sessionHash } : {}),
    ...(finalizationId ? { finalization_id: finalizationId } : {}),
    error_name: ['AccessDeniedException', 'ThrottlingException', 'TimeoutError', 'ServiceUnavailable'].includes(
      errorName,
    )
      ? errorName
      : 'Error',
  });
}

async function reconcileCandidate(item: Record<string, unknown>, context: ReconciliationContext): Promise<boolean> {
  const { store, sfn, executionPrefix, nowMs, deadlineSeconds, seen } = context;
  const sessionId = parseSessionId(item['ownerSessionId']);
  const finalizationId = parseFinalizationId(item['finalizationId']);
  try {
    if (!sessionId || !finalizationId) throw new Error('Invalid reconciliation candidate identity');
    // An eventually consistent old ID must not suppress the current ID for the same session.
    const identity = `${sessionId}/${finalizationId}`;
    if (seen.has(identity)) return true;
    seen.add(identity);
    await reconcileFinalization(
      { sessionId, finalizationId, nowMs, dispatchDeadlineMs: deadlineSeconds * 1000 },
      {
        store,
        observeExecution: (_sessionId, id) => observeExecution(sfn, executionPrefix, id),
      },
    );
  } catch (error) {
    logCandidateFailure(error, sessionId, finalizationId);
    return false;
  }
  return true;
}

function executionArnPrefix(external: Extract<ResolvedRuntimeProfile['external'], { kind: 'aws' }>): string {
  const stateMachine = external.asyncRuntime.proverStateMachineArn;
  const prefix = `arn:aws:states:${external.region}:${external.accountId}:stateMachine:`;
  if (!stateMachine.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(stateMachine.slice(prefix.length))) {
    throw new Error('Invalid finalization state machine identity');
  }
  const executionPrefix = `arn:aws:states:${external.region}:${external.accountId}:execution:${stateMachine.slice(prefix.length)}:`;
  return executionPrefix;
}

function dispatchDeadlineSeconds(): number {
  const deadlineSeconds = Number(process.env['FINALIZE_PENDING_DISPATCH_DEADLINE_SECONDS'] ?? 900);
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= 0) throw new Error('Invalid dispatch deadline');
  return deadlineSeconds;
}

function reconciliationCandidatesQuery(
  tableName: string,
  nowMs: number,
  cursor: Record<string, unknown> | undefined,
): QueryCommand {
  return new QueryCommand({
    TableName: tableName,
    IndexName: 'finalization-expiry-index',
    KeyConditionExpression: '#type = :type AND #expires > :now',
    ExpressionAttributeNames: { '#type': 'itemType', '#expires': 'expiresAt' },
    ExpressionAttributeValues: { ':type': 'FINALIZATION', ':now': Math.floor(nowMs / 1000) },
    ProjectionExpression: 'ownerSessionId, finalizationId',
    Limit: 25,
    ScanIndexForward: false,
    ...(cursor ? { ExclusiveStartKey: cursor } : {}),
  });
}

export async function reconcileAwsFinalizations(
  profile: ResolvedRuntimeProfile,
  store: FinalizationLifecycleStore,
): Promise<{ visited: number }> {
  if (profile.external.kind !== 'aws') throw new Error('Finalization reconciliation requires AWS runtime');
  const external = profile.external;
  const dynamo = getSharedDynamoDocumentClient(profile);
  const sfn = new SFNClient({ region: external.region });
  const executionPrefix = executionArnPrefix(external);
  const deadlineSeconds = dispatchDeadlineSeconds();
  let cursor: Record<string, unknown> | undefined;
  let visited = 0;
  let failures = 0;
  const seen = new Set<string>();
  const nowMs = Date.now();
  try {
    do {
      // Index candidates are hints only. The use case re-reads current authority before any transition.
      const page = await dynamo.send(reconciliationCandidatesQuery(external.dynamo.sessionsTable, nowMs, cursor));
      for (const item of page.Items ?? []) {
        visited++;
        if (!(await reconcileCandidate(item, { store, sfn, executionPrefix, nowMs, deadlineSeconds, seen })))
          failures++;
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor && Object.keys(cursor).length > 0);
  } finally {
    sfn.destroy();
  }
  logger.info('Finalization reconciliation completed', { visited, failures });
  if (failures > 0) throw new Error('Finalization reconciliation failed for one or more candidates');
  return { visited };
}

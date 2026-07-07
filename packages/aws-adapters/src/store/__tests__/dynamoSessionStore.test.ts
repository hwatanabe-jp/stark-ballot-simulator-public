import { beforeEach, describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoSessionStore } from '../dynamoSessionStore';
import type { VoteData } from '@stark-ballot/domain/types/server';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { parseFinalizationState } from '@stark-ballot/application/finalize/finalization-storage';
import {
  parseAwsFinalizationRuntimeState,
  parseAwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { encryptVoteSecret } from '@stark-ballot/aws-adapters/security/voteSecretCipher';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function strictString(value: unknown, label = 'value'): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${label} to be a string`);
  }
  return value;
}

const VoteChoice = {
  A: 'A' as const,
  B: 'B' as const,
};

function getVerificationExecutionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const executionId = (value as { verificationExecutionId?: unknown }).verificationExecutionId;
  return typeof executionId === 'string' ? executionId : undefined;
}

function parsePersistedFinalizationState(value: unknown) {
  return parseAwsFinalizationRuntimeState(value) ?? parseFinalizationState(value);
}

type CommandLike = {
  constructor: { name: string };
  input: Record<string, unknown>;
};

class FakeDynamoDocumentClient {
  readonly sessions = new Map<string, Record<string, unknown>>();
  readonly votes = new Map<string, Map<number, Record<string, unknown>>>();
  readonly extraVoteRows = new Map<string, Array<Record<string, unknown>>>();
  private beforeNextTransactWrite: (() => Promise<void> | void) | null = null;

  async send(command: CommandLike): Promise<Record<string, unknown>> {
    switch (command.constructor.name) {
      case 'PutCommand':
        return this.put(command.input);
      case 'TransactWriteCommand':
        return await this.transactWrite(command.input);
      case 'GetCommand':
        return this.get(command.input);
      case 'QueryCommand':
        return this.query(command.input);
      case 'ScanCommand':
        return this.scan();
      case 'UpdateCommand':
        return this.update(command.input);
      default:
        throw new Error(`Unsupported command: ${command.constructor.name}`);
    }
  }

  expireSession(sessionId: string): void {
    const item = this.sessions.get(sessionId);
    if (item) {
      item['expiresAt'] = Math.floor(Date.now() / 1000) - 1;
    }
  }

  expireSidecar(sidecarSessionId: string): void {
    const item = this.sessions.get(sidecarSessionId);
    if (item) {
      item['expiresAt'] = Math.floor(Date.now() / 1000) - 1;
    }
  }

  firstVoteRow(sessionId: string): Record<string, unknown> | undefined {
    return structuredClone(this.votes.get(sessionId)?.get(0));
  }

  sessionRow(sessionId: string): Record<string, unknown> | undefined {
    return structuredClone(this.sessions.get(sessionId));
  }

  deleteVoteRow(sessionId: string, voteIndex: number): void {
    this.votes.get(sessionId)?.delete(voteIndex);
  }

  duplicateVoteRow(sessionId: string, voteIndex: number): void {
    const row = this.votes.get(sessionId)?.get(voteIndex);
    if (!row) {
      throw new Error(`Missing vote row ${voteIndex}`);
    }
    const rows = this.extraVoteRows.get(sessionId) ?? [];
    rows.push(structuredClone(row));
    this.extraVoteRows.set(sessionId, rows);
  }

  mutateVoteRow(sessionId: string, voteIndex: number, mutate: (row: Record<string, unknown>) => void): void {
    const row = this.votes.get(sessionId)?.get(voteIndex);
    if (!row) {
      throw new Error(`Missing vote row ${voteIndex}`);
    }
    mutate(row);
  }

  mutateSessionRow(sessionId: string, mutate: (row: Record<string, unknown>) => void): void {
    const row = this.sessions.get(sessionId);
    if (!row) {
      throw new Error(`Missing session row ${sessionId}`);
    }
    mutate(row);
  }

  runBeforeNextTransactWrite(callback: () => Promise<void> | void): void {
    this.beforeNextTransactWrite = callback;
  }

  putBitmapSidecar(
    sessionId: string,
    bitmapData: {
      includedBitmap: boolean[];
      includedBitmapRoot: string;
      seenBitmap?: boolean[];
      seenBitmapRoot?: string;
      treeSize: number;
      finalizedAt: number;
    } = {
      includedBitmap: [true],
      includedBitmapRoot: computeIncludedBitmapRoot([true]),
      treeSize: 1,
      finalizedAt: 123,
    },
  ): void {
    this.sessions.set(`BITMAP#${sessionId}`, {
      sessionId: `BITMAP#${sessionId}`,
      itemType: 'BITMAP',
      bitmapData: {
        sessionId,
        ...structuredClone(bitmapData),
      },
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
  }

  receiptRow(sessionId: string): Record<string, unknown> | undefined {
    return structuredClone(this.sessions.get(`RECEIPT#${sessionId}`));
  }

  private put(input: Record<string, unknown>): Record<string, unknown> {
    const tableName = strictString(input['TableName'], 'TableName');
    const item = input['Item'] as Record<string, unknown>;
    if (tableName === 'sessions') {
      const sessionId = strictString(item['sessionId'], 'sessionId');
      const condition = typeof input['ConditionExpression'] === 'string' ? input['ConditionExpression'] : '';
      const existing = this.sessions.get(sessionId);
      if (condition.includes('attribute_not_exists(#sessionId)') && this.sessions.has(sessionId)) {
        throw new Error('ConditionalCheckFailedException');
      }
      if (condition.includes('attribute_exists(#sessionId)') && !this.sessions.has(sessionId)) {
        throw new Error('ConditionalCheckFailedException');
      }
      if (condition.includes('attribute_not_exists(#session.#userVoteIndex)')) {
        if (!existing) {
          throw new Error('ConditionalCheckFailedException');
        }
        const existingSession = existing['session'] as { userVoteIndex?: unknown } | undefined;
        if (existingSession && typeof existingSession.userVoteIndex === 'number') {
          throw new Error('ConditionalCheckFailedException');
        }
      }
      this.assertFinalizationCondition(condition, input['ExpressionAttributeValues'], existing);
      this.sessions.set(sessionId, structuredClone(item));
      return {};
    }

    const sessionId = strictString(item['sessionId'], 'sessionId');
    const voteIndex = Number(strictDefined(item['voteIndex']));
    const rows = this.votes.get(sessionId) ?? new Map<number, Record<string, unknown>>();
    const existing = rows.get(voteIndex);
    this.assertVoteCondition(
      typeof input['ConditionExpression'] === 'string' ? input['ConditionExpression'] : '',
      input['ExpressionAttributeNames'] as Record<string, string> | undefined,
      input['ExpressionAttributeValues'] as Record<string, unknown> | undefined,
      existing,
    );
    rows.set(voteIndex, structuredClone(item));
    this.votes.set(sessionId, rows);
    return {};
  }

  private assertVoteCondition(
    condition: string,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined,
    existing: Record<string, unknown> | undefined,
  ): void {
    if (condition.includes('attribute_not_exists(#sessionId)') && existing) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (condition.includes('attribute_exists(#sessionId)') && !existing) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (!existing) {
      return;
    }

    for (const [, namePlaceholder] of condition.matchAll(/attribute_not_exists\((#[A-Za-z0-9]+)\)/g)) {
      if (!namePlaceholder) {
        continue;
      }
      const attributeName = names?.[namePlaceholder];
      if (attributeName && existing[attributeName] !== undefined) {
        throw new Error('ConditionalCheckFailedException');
      }
    }

    for (const [, namePlaceholder, valuePlaceholder] of condition.matchAll(/(#[A-Za-z0-9]+) = (:[A-Za-z0-9]+)/g)) {
      if (!namePlaceholder || !valuePlaceholder) {
        continue;
      }
      const attributeName = names?.[namePlaceholder];
      const expectedValue = values?.[valuePlaceholder];
      if (!attributeName) {
        continue;
      }
      if (JSON.stringify(strictDefined(existing[attributeName])) !== JSON.stringify(expectedValue)) {
        throw new Error('ConditionalCheckFailedException');
      }
    }
  }

  private async transactWrite(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.beforeNextTransactWrite) {
      const callback = this.beforeNextTransactWrite;
      this.beforeNextTransactWrite = null;
      await callback();
    }
    const sessionsSnapshot = structuredClone(Array.from(this.sessions.entries()));
    const votesSnapshot = structuredClone(
      Array.from(this.votes.entries()).map(([sessionId, rows]) => [sessionId, Array.from(rows.entries())] as const),
    );
    const extraVoteRowsSnapshot = structuredClone(Array.from(this.extraVoteRows.entries()));
    const items = input['TransactItems'] as Array<Record<string, Record<string, unknown>>>;
    let failedIndex = -1;
    try {
      for (const [index, item] of items.entries()) {
        failedIndex = index;
        if ('Put' in item) {
          this.put(item['Put']);
        } else if ('Update' in item) {
          this.update(item['Update']);
        } else {
          throw new Error('Unsupported transaction item');
        }
      }
    } catch (error) {
      this.sessions.clear();
      for (const [sessionId, row] of sessionsSnapshot) {
        this.sessions.set(sessionId, row);
      }
      this.votes.clear();
      for (const [sessionId, rows] of votesSnapshot) {
        this.votes.set(sessionId, new Map(rows));
      }
      this.extraVoteRows.clear();
      for (const [sessionId, rows] of extraVoteRowsSnapshot) {
        this.extraVoteRows.set(sessionId, rows);
      }
      if (error instanceof Error && error.message.includes('ConditionalCheckFailedException')) {
        throw this.transactionCanceledAt(items.length, failedIndex);
      }
      throw error;
    }
    return {};
  }

  private transactionCanceledAt(itemCount: number, failedIndex: number): Error {
    const error = new Error('ConditionalCheckFailedException') as Error & {
      CancellationReasons: Array<{ Code: string }>;
    };
    error.name = 'TransactionCanceledException';
    error.CancellationReasons = Array.from({ length: itemCount }, (_, index) => ({
      Code: index === failedIndex ? 'ConditionalCheckFailed' : 'None',
    }));
    return error;
  }

  private assertFinalizationCondition(
    condition: string,
    expressionAttributeValues: unknown,
    existing: Record<string, unknown> | undefined,
  ): void {
    if (
      !condition.includes(':expectedFinalized') &&
      !condition.includes(':expectedBotCount') &&
      !condition.includes(':expectedVoteCount')
    ) {
      return;
    }
    if (!existing) {
      throw new Error('ConditionalCheckFailedException');
    }
    const values = expressionAttributeValues as Record<string, unknown> | undefined;
    const session = existing['session'] as
      | {
          contractGeneration?: unknown;
          finalizationContractGeneration?: unknown;
          finalizationArtifactState?: unknown;
          finalizationResult?: { verificationExecutionId?: unknown };
          finalizationState?: { status?: unknown; executionId?: unknown };
          userVoteIndex?: unknown;
          bulletinRootHistory?: unknown;
        }
      | undefined;
    if (!values || !session) {
      throw new Error('ConditionalCheckFailedException');
    }

    if (
      condition.includes(':expectedBotCount') &&
      existing['botCount'] !== strictDefined(values[':expectedBotCount'])
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (condition.includes(':expectedVoteCount')) {
      const rootHistory = Array.isArray(session.bulletinRootHistory) ? session.bulletinRootHistory : [];
      if (rootHistory.length !== strictDefined(values[':expectedVoteCount'])) {
        throw new Error('ConditionalCheckFailedException');
      }
    }
    if (
      values[':expectedUserVoteIndex'] !== undefined &&
      session.userVoteIndex !== strictDefined(values[':expectedUserVoteIndex'])
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedUserVoteIndex'] === undefined &&
      condition.includes('attribute_not_exists(#session.#userVoteIndex)') &&
      session.userVoteIndex !== undefined
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (existing['finalized'] !== strictDefined(values[':expectedFinalized'])) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedContractGeneration'] !== undefined &&
      session.contractGeneration !== strictDefined(values[':expectedContractGeneration'])
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedContractGeneration'] === undefined &&
      condition.includes('attribute_not_exists(#session.#contractGeneration)') &&
      session.contractGeneration !== undefined
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedFinalizationContractGeneration'] !== undefined &&
      session.finalizationContractGeneration !== strictDefined(values[':expectedFinalizationContractGeneration'])
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedFinalizationContractGeneration'] === undefined &&
      condition.includes('attribute_not_exists(#session.#finalizationContractGeneration)') &&
      session.finalizationContractGeneration !== undefined
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedFinalizationArtifactState'] !== undefined &&
      session.finalizationArtifactState !== strictDefined(values[':expectedFinalizationArtifactState'])
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedFinalizationArtifactState'] === undefined &&
      condition.includes('attribute_not_exists(#session.#finalizationArtifactState)') &&
      session.finalizationArtifactState !== undefined
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedVerificationExecutionId'] !== undefined &&
      session.finalizationResult?.verificationExecutionId !== strictDefined(values[':expectedVerificationExecutionId'])
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (
      values[':expectedVerificationExecutionId'] === undefined &&
      condition.includes('attribute_not_exists(#session.#finalizationResult.#verificationExecutionId)') &&
      session.finalizationResult?.verificationExecutionId !== undefined
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (values[':expectedFinalizationStateStatus'] !== undefined) {
      const finalizationState = parsePersistedFinalizationState(session.finalizationState);
      if (
        finalizationState?.status !== values[':expectedFinalizationStateStatus'] ||
        finalizationState.executionId !== strictDefined(values[':expectedFinalizationStateExecutionId'])
      ) {
        throw new Error('ConditionalCheckFailedException');
      }
      return;
    }
    if (
      condition.includes('attribute_not_exists(#session.#finalizationState)') &&
      session.finalizationState !== undefined
    ) {
      throw new Error('ConditionalCheckFailedException');
    }
  }

  private get(input: Record<string, unknown>): Record<string, unknown> {
    const key = input['Key'] as { sessionId: string };
    return {
      Item: structuredClone(this.sessions.get(key.sessionId)),
    };
  }

  private query(input: Record<string, unknown>): Record<string, unknown> {
    const values = input['ExpressionAttributeValues'] as { ':sessionId': string };
    const rows = this.votes.get(values[':sessionId']);
    return {
      Items: [
        ...(rows ? Array.from(rows.values()).map((item) => structuredClone(item)) : []),
        ...(this.extraVoteRows.get(values[':sessionId']) ?? []).map((item) => structuredClone(item)),
      ],
    };
  }

  private scan(): Record<string, unknown> {
    return {
      Items: Array.from(this.sessions.values()).map((item) => structuredClone(item)),
    };
  }

  private update(input: Record<string, unknown>): Record<string, unknown> {
    const key = input['Key'] as { sessionId: string };
    const current = this.sessions.get(key.sessionId);
    const condition = typeof input['ConditionExpression'] === 'string' ? input['ConditionExpression'] : '';
    const values = input['ExpressionAttributeValues'] as Record<string, unknown> | undefined;
    if (condition.includes('attribute_not_exists(#value)') && current?.['value'] !== undefined) {
      throw new Error('ConditionalCheckFailedException');
    }
    if (condition.includes('#value = :currentValue') && current?.['value'] !== values?.[':currentValue']) {
      throw new Error('ConditionalCheckFailedException');
    }
    const nextValue =
      typeof values?.[':nextValue'] === 'number'
        ? values[':nextValue']
        : typeof current?.['value'] === 'number'
          ? current['value'] + 1
          : 100;
    this.sessions.set(key.sessionId, {
      sessionId: key.sessionId,
      value: nextValue,
      ...(typeof values?.[':itemType'] === 'string' ? { itemType: values[':itemType'] } : {}),
    });
    return {
      Attributes: {
        value: nextValue,
      },
    };
  }
}

function asDocumentClient(client: FakeDynamoDocumentClient): DynamoDBDocumentClient {
  return client as unknown as DynamoDBDocumentClient;
}

function buildVote(voteId: string, vote: 'A' | 'B', randNibble: string): VoteData {
  return {
    voteId,
    vote,
    rand: `0x${randNibble.repeat(64)}`,
    commit: `0x${'0'.repeat(64)}`,
    path: [],
    timestamp: Date.now(),
  };
}

function buildFinalizationResult(
  executionId = 'exec-test',
  options: {
    journal?: ReturnType<typeof createTestJournal>;
  } = {},
) {
  const journal = options.journal ?? createTestJournal();
  const result = buildFinalizationResultFromJournal({
    journal,
    imageId: `0x${'1'.repeat(64)}`,
  });

  return {
    ...result,
    verificationExecutionId: executionId,
    publicInputArtifact: createTestPublicInputArtifact({
      executionId,
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        methodVersion: journal.methodVersion,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        votesCount: journal.validVotes,
        recomputedInputCommitment: journal.inputCommitment,
      },
    }),
  };
}

function corruptEncryptedPayload(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected encrypted payload string');
  }
  const parts = value.split(':');
  if (parts.length !== 5 || strictDefined(parts[4]).length === 0) {
    throw new Error('Unexpected encrypted payload shape');
  }
  const lastIndex = strictDefined(parts[4]).length - 1;
  const payloadPart = strictDefined(parts[4]);
  const replacement = payloadPart[lastIndex] === '0' ? '1' : '0';
  parts[4] = `${payloadPart.slice(0, lastIndex)}${replacement}`;
  return parts.join(':');
}

describe('DynamoSessionStore', () => {
  let client: FakeDynamoDocumentClient;

  beforeEach(() => {
    process.env['DYNAMODB_SESSIONS_TABLE'] = 'sessions';
    process.env['DYNAMODB_VOTES_TABLE'] = 'votes';
    process.env['AWS_REGION'] = 'ap-northeast-1';
    process.env['SESSION_LIVE_TTL_SECONDS'] = '300';
    process.env['VERIFICATION_ARTIFACT_TTL_SECONDS'] = '7200';
    process.env['VOTE_SECRET_ENCRYPTION_KEY'] = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    client = new FakeDynamoDocumentClient();
  });

  it('does not expose standalone receipt-board publication', () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });

    expect('saveReceiptToBoard' in store).toBe(false);
    expect(Reflect.get(store, 'saveReceiptToBoard')).toBeUndefined();
  });

  it('persists sessions and restores exact session-scoped CT proofs from vote rows', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();

    const castResult = await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    await writer.addBotVotes(session.sessionId, [buildVote(generateVoteId(), VoteChoice.B, 'b')]);

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const proof = await reader.getVoteByIdWithProof(session.sessionId, voteId);

    expect(proof?.voteData.voteId).toBe(voteId);
    expect(proof?.leafIndex).toBe(0);
    expect(proof?.treeSize).toBe(1);
    expect(proof?.bulletinRootAtCast).toBe(castResult.bulletinRootAtCast);
    expect(await reader.getVoteById('wrong-session', voteId)).toBeNull();
  });

  it('persists updateSession partial updates and rejects stale or missing session authority', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const originalCreatedAt = session.createdAt;

    await store.updateSession(session.sessionId, { electionId: 'election-plan-04' });

    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(persisted?.electionId).toBe('election-plan-04');
    expect(persisted?.createdAt).toBe(originalCreatedAt);
    expect(persisted?.lastActivity).toBeGreaterThanOrEqual(session.lastActivity);

    await expect(store.updateSession('missing-session', { electionId: 'missing' })).rejects.toThrow(
      'Session not found',
    );
    client.expireSession(session.sessionId);
    await expect(store.updateSession(session.sessionId, { electionId: 'stale' })).rejects.toThrow('Session not found');
  });

  it('persists DynamoDB finalization transitions across reloads', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';

    await expect(
      store.markFinalizationQueued(session.sessionId, {
        executionId: 'exec-transitions',
        queuedAt: 10,
        contractGeneration,
      }),
    ).resolves.toMatchObject({ status: 'pending', executionId: 'exec-transitions' });
    await expect(
      store.markAwsFinalizationRunning(session.sessionId, {
        executionId: 'exec-transitions',
        queuedAt: 10,
        startedAt: 20,
        contractGeneration,
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:test',
      }),
    ).resolves.toMatchObject({ status: 'running', startedAt: 20 });
    await expect(
      store.markFinalizationFailed(session.sessionId, {
        executionId: 'exec-transitions',
        queuedAt: 10,
        startedAt: 20,
        failedAt: 30,
        contractGeneration,
        error: { code: 'TEST_FAILURE', message: 'failed during evidence test' },
      }),
    ).resolves.toMatchObject({ status: 'failed', failedAt: 30 });

    const failedSession = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(failedSession?.finalizationState).toMatchObject({
      status: 'failed',
      executionId: 'exec-transitions',
    });

    const timeoutSession = await store.createSession();
    await expect(
      store.markFinalizationTimedOut(timeoutSession.sessionId, {
        executionId: 'exec-timeout',
        queuedAt: 40,
        startedAt: 50,
        timeoutAt: 60,
        contractGeneration: timeoutSession.contractGeneration ?? 'current',
      }),
    ).resolves.toMatchObject({ status: 'timeout', timeoutAt: 60 });

    const succeededSession = await store.createSession();
    await expect(
      store.markFinalizationSucceeded(succeededSession.sessionId, {
        executionId: 'exec-success',
        queuedAt: 70,
        startedAt: 80,
        completedAt: 90,
        contractGeneration: succeededSession.contractGeneration ?? 'current',
        finalizationResult: buildFinalizationResult('exec-success'),
      }),
    ).resolves.toMatchObject({ status: 'succeeded', completedAt: 90 });

    const persistedSucceededSession = await new DynamoSessionStore({
      documentClient: asDocumentClient(client),
    }).getSession(succeededSession.sessionId);
    expect(persistedSucceededSession?.finalized).toBe(true);
    expect(persistedSucceededSession?.finalizationState).toMatchObject({
      status: 'succeeded',
      executionId: 'exec-success',
    });

    await expect(
      store.markFinalizationQueued('missing-session', {
        executionId: 'missing-exec',
        queuedAt: 1,
        contractGeneration,
      }),
    ).rejects.toThrow('Session not found');
  });

  it('keeps USER_CANCELLED failed state when same-executionId running arrives through the Dynamo wrapper path', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';
    const executionId = 'exec-dynamo-cancelled-sticky';
    const queuedAt = 10;
    const failedAt = 20;
    const expectedFailedState = {
      status: 'failed' as const,
      executionId,
      queuedAt,
      failedAt,
      error: { code: 'USER_CANCELLED', message: 'User cancelled finalization' },
    };

    await store.markFinalizationQueued(session.sessionId, {
      executionId,
      queuedAt,
      contractGeneration,
    });
    await store.markAwsFinalizationFailed(session.sessionId, {
      executionId,
      queuedAt,
      failedAt,
      contractGeneration,
      error: expectedFailedState.error,
    });

    const nextState = await store.markAwsFinalizationRunning(session.sessionId, {
      executionId,
      queuedAt,
      startedAt: 30,
      contractGeneration,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:test-cancelled',
    });

    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(nextState).toEqual(expectedFailedState);
    expect(persisted?.finalizationState).toEqual(expectedFailedState);
    expect(persisted?.finalized).toBe(false);
    expect(persisted?.finalizationResult).toBeUndefined();
  });

  it('rejects widened pure lifecycle payloads that include AWS runtime metadata before DynamoDB persistence', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';
    const executionId = 'exec-pure-runtime-metadata';
    const queuedAt = 100;
    const startedAt = 200;

    await store.markFinalizationQueued(session.sessionId, {
      executionId,
      queuedAt,
      contractGeneration,
    });

    const runningPayload = {
      executionId,
      queuedAt,
      startedAt,
      contractGeneration,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-pure',
    };

    await expect(store.markFinalizationRunning(session.sessionId, runningPayload)).rejects.toThrow(
      'Pure finalization lifecycle methods do not accept AWS runtime metadata',
    );

    const succeededPayload = {
      executionId,
      queuedAt,
      startedAt,
      completedAt: 300,
      contractGeneration,
      finalizationResult: buildFinalizationResult(executionId),
      bundleMetadata: {
        s3BundleKey: 'sessions/session-1/exec-pure/bundle.zip',
      },
    };

    await expect(store.markFinalizationSucceeded(session.sessionId, succeededPayload)).rejects.toThrow(
      'Pure finalization lifecycle methods do not accept AWS runtime metadata',
    );

    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(persisted?.finalizationState).toEqual({
      status: 'pending',
      executionId,
      queuedAt,
    });
  });

  it('persists AWS callback bundle metadata on the finalization result', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';
    const executionId = 'exec-aws-bundle-metadata';
    const s3BundleKey = `sessions/${session.sessionId}/${executionId}/bundle.zip`;
    const s3UploadedAt = '2026-07-05T14:14:49.078Z';
    const includedBitmap = [true];
    const seenBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
    const journal = {
      ...createTestJournal({ totalExpected: 1, validVotes: 1, seenIndicesCount: 1 }),
      treeSize: 1,
      totalExpected: 1,
      includedBitmapRoot,
      seenBitmapRoot,
    };

    await store.markFinalizationQueued(session.sessionId, {
      executionId,
      queuedAt: 100,
      contractGeneration,
    });

    await store.markAwsFinalizationSucceeded(session.sessionId, {
      executionId,
      queuedAt: 100,
      startedAt: 200,
      completedAt: 300,
      contractGeneration,
      finalizationResult: {
        ...buildFinalizationResult(executionId, { journal }),
        bitmapProofSource: 'real',
        bitmapData: {
          includedBitmap,
          includedBitmapRoot,
          seenBitmap,
          seenBitmapRoot,
          treeSize: 1,
          finalizedAt: 300,
        },
      },
      bundleMetadata: {
        s3BundleKey,
        s3UploadedAt,
      },
    });

    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    const finalizationResult = parseAwsPersistedFinalizationResult(persisted?.finalizationResult);
    expect(finalizationResult).toMatchObject({
      verificationExecutionId: executionId,
      s3BundleKey,
      s3UploadedAt,
    });
    expect(persisted?.finalizationState).toMatchObject({
      status: 'succeeded',
      executionId,
      bundleMetadata: {
        s3BundleKey,
        s3UploadedAt,
      },
    });
    await expect(
      new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getBitmapData(session.sessionId),
    ).resolves.toEqual({
      sessionId: session.sessionId,
      includedBitmap,
      includedBitmapRoot,
      seenBitmap,
      seenBitmapRoot,
      treeSize: 1,
      finalizedAt: 300,
    });
  });

  it('rejects a stale DynamoDB finalization transition without dirtying the local cache', async () => {
    const staleWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleWriter.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';

    client.runBeforeNextTransactWrite(() => {
      client.mutateSessionRow(session.sessionId, (row) => {
        const storedSession = row['session'] as Record<string, unknown>;
        storedSession['finalizationContractGeneration'] = contractGeneration;
        storedSession['finalizationState'] = {
          status: 'pending',
          executionId: 'exec-winning',
          queuedAt: 10,
        };
      });
    });

    await expect(
      staleWriter.markFinalizationQueued(session.sessionId, {
        executionId: 'exec-stale',
        queuedAt: 11,
        contractGeneration,
      }),
    ).resolves.toMatchObject({ status: 'pending', executionId: 'exec-winning' });

    const cached = await staleWriter.getSession(session.sessionId);
    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(cached?.finalizationState).toMatchObject({ status: 'pending', executionId: 'exec-winning' });
    expect(persisted?.finalizationState).toMatchObject({ status: 'pending', executionId: 'exec-winning' });
  });

  it('rejects stale callback success for a competing execution ID', async () => {
    const staleCallbackStore = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleCallbackStore.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';

    await staleCallbackStore.markFinalizationQueued(session.sessionId, {
      executionId: 'exec-original',
      queuedAt: 10,
      contractGeneration,
    });
    client.runBeforeNextTransactWrite(() => {
      client.mutateSessionRow(session.sessionId, (row) => {
        const storedSession = row['session'] as Record<string, unknown>;
        storedSession['finalizationState'] = {
          status: 'pending',
          executionId: 'exec-current',
          queuedAt: 20,
        };
      });
    });

    await expect(
      staleCallbackStore.markFinalizationSucceeded(session.sessionId, {
        executionId: 'exec-original',
        queuedAt: 10,
        startedAt: 11,
        completedAt: 12,
        contractGeneration,
        finalizationResult: buildFinalizationResult('exec-original'),
      }),
    ).resolves.toMatchObject({ status: 'pending', executionId: 'exec-current' });

    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(persisted?.finalizationState).toMatchObject({ status: 'pending', executionId: 'exec-current' });
    expect(persisted?.finalized).toBe(false);
  });

  it('returns the persisted USER_CANCELLED failed state when DynamoDB CAS loses to a same-execution success race', async () => {
    const staleCallbackStore = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleCallbackStore.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';
    const executionId = 'exec-dynamo-same-id-cas-race';
    const queuedAt = 10;
    const failedAt = 30;
    const expectedFailedState = {
      status: 'failed' as const,
      executionId,
      queuedAt,
      failedAt,
      error: { code: 'USER_CANCELLED', message: 'User cancelled finalization' },
    };

    await staleCallbackStore.markFinalizationQueued(session.sessionId, {
      executionId,
      queuedAt,
      contractGeneration,
    });

    client.runBeforeNextTransactWrite(() => {
      client.mutateSessionRow(session.sessionId, (row) => {
        row['finalized'] = false;
        const storedSession = row['session'] as Record<string, unknown>;
        storedSession['finalized'] = false;
        storedSession['finalizationState'] = expectedFailedState;
        delete storedSession['finalizationResult'];
      });
    });

    await expect(
      staleCallbackStore.markAwsFinalizationSucceeded(session.sessionId, {
        executionId,
        queuedAt,
        startedAt: 20,
        completedAt: 40,
        contractGeneration,
        finalizationResult: buildFinalizationResult(executionId),
      }),
    ).resolves.toEqual(expectedFailedState);

    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(persisted?.finalizationState).toEqual(expectedFailedState);
    expect(persisted?.finalized).toBe(false);
    expect(persisted?.finalizationResult).toBeUndefined();
  });

  it('fails sync finalize on a stale DynamoDB condition and restores the cache', async () => {
    const staleWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleWriter.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';

    client.runBeforeNextTransactWrite(() => {
      client.mutateSessionRow(session.sessionId, (row) => {
        const storedSession = row['session'] as Record<string, unknown>;
        storedSession['finalizationContractGeneration'] = contractGeneration;
        storedSession['finalizationState'] = {
          status: 'pending',
          executionId: 'exec-async',
          queuedAt: 10,
        };
      });
    });

    await expect(
      staleWriter.finalizeSession(
        session.sessionId,
        buildFinalizationResult('exec-sync'),
        contractGeneration,
        'exec-sync',
      ),
    ).rejects.toThrow('ConditionalCheckFailedException');

    const cached = await staleWriter.getSession(session.sessionId);
    expect(cached?.finalized).toBe(false);
    expect(cached?.finalizationState).toMatchObject({ status: 'pending', executionId: 'exec-async' });
  });

  it('atomically rejects stale receipt publication without consuming a board index or overwriting the winner', async () => {
    const staleWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const winningWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleWriter.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';

    client.runBeforeNextTransactWrite(async () => {
      await winningWriter.finalizeSessionWithReceiptPublication(
        session.sessionId,
        buildFinalizationResult('exec-winning'),
        contractGeneration,
        {
          receipt: '{"receipt":"winning"}',
          timestamp: 2000,
        },
        'exec-winning',
      );
    });

    await expect(
      staleWriter.finalizeSessionWithReceiptPublication(
        session.sessionId,
        buildFinalizationResult('exec-stale'),
        contractGeneration,
        {
          receipt: '{"receipt":"stale"}',
          timestamp: 1000,
        },
        'exec-stale',
      ),
    ).rejects.toThrow('ConditionalCheckFailedException');

    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    const persistedResult = parseAwsPersistedFinalizationResult(persisted?.finalizationResult);
    expect(getVerificationExecutionId(persisted?.finalizationResult)).toBe('exec-winning');
    expect(persistedResult?.receiptPublication).toMatchObject({
      boardIndex: 100,
      timestamp: 2000,
    });
    expect(client.sessionRow('RECEIPT_BOARD_COUNTER')).toMatchObject({ value: 100 });
    expect(client.receiptRow(session.sessionId)).toMatchObject({
      receiptEntry: {
        boardIndex: 100,
        receipt: {
          receipt: '{"receipt":"winning"}',
          timestamp: 2000,
        },
      },
    });

    const cached = await staleWriter.getSession(session.sessionId);
    expect(getVerificationExecutionId(cached?.finalizationResult)).toBe('exec-winning');
  });

  it('retries verified receipt counter contention for concurrent finalizations in different sessions', async () => {
    const firstWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const secondWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const firstSession = await firstWriter.createSession();
    const secondSession = await secondWriter.createSession();
    const firstContractGeneration = firstSession.contractGeneration ?? 'current';
    const secondContractGeneration = secondSession.contractGeneration ?? 'current';
    const secondPublications: Array<{ receiptHash: string; boardIndex: number }> = [];

    client.runBeforeNextTransactWrite(async () => {
      const publication = await secondWriter.finalizeSessionWithReceiptPublication(
        secondSession.sessionId,
        buildFinalizationResult('exec-second'),
        secondContractGeneration,
        {
          receipt: '{"receipt":"second"}',
          timestamp: 2000,
        },
        'exec-second',
      );
      secondPublications.push(publication);
    });

    const firstPublication = await firstWriter.finalizeSessionWithReceiptPublication(
      firstSession.sessionId,
      buildFinalizationResult('exec-first'),
      firstContractGeneration,
      {
        receipt: '{"receipt":"first"}',
        timestamp: 1000,
      },
      'exec-first',
    );

    expect(secondPublications).toHaveLength(1);
    const secondPublication = secondPublications[0];
    expect(secondPublication).toMatchObject({ boardIndex: 100 });
    expect(firstPublication).toMatchObject({ boardIndex: 101 });
    expect(client.sessionRow('RECEIPT_BOARD_COUNTER')).toMatchObject({ value: 101 });
    expect(client.receiptRow(secondSession.sessionId)).toMatchObject({
      receiptEntry: {
        boardIndex: 100,
        receiptHash: strictDefined(secondPublication).receiptHash,
      },
    });
    expect(client.receiptRow(firstSession.sessionId)).toMatchObject({
      receiptEntry: {
        boardIndex: 101,
        receiptHash: firstPublication.receiptHash,
      },
    });

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    await expect(reader.getSession(firstSession.sessionId)).resolves.toMatchObject({
      finalizationResult: { receiptPublication: { boardIndex: 101 } },
    });
    await expect(reader.getSession(secondSession.sessionId)).resolves.toMatchObject({
      finalizationResult: { receiptPublication: { boardIndex: 100 } },
    });
  });

  it('preserves winning persisted authority on stale activity-only updateSession races', async () => {
    const staleWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleWriter.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';

    client.runBeforeNextTransactWrite(() => {
      client.mutateSessionRow(session.sessionId, (row) => {
        const storedSession = row['session'] as Record<string, unknown>;
        storedSession['finalizationContractGeneration'] = contractGeneration;
        storedSession['finalizationState'] = {
          status: 'pending',
          executionId: 'exec-winning',
          queuedAt: 10,
        };
      });
    });

    await expect(staleWriter.updateSession(session.sessionId)).resolves.toBeUndefined();
    const cached = await staleWriter.getSession(session.sessionId);
    expect(cached?.finalizationState).toMatchObject({ status: 'pending', executionId: 'exec-winning' });
  });

  it('preserves winning persisted authority on stale metadata updateSession races', async () => {
    const staleWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleWriter.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';

    client.runBeforeNextTransactWrite(() => {
      client.mutateSessionRow(session.sessionId, (row) => {
        const storedSession = row['session'] as Record<string, unknown>;
        storedSession['electionId'] = 'winning-election';
        storedSession['finalizationContractGeneration'] = contractGeneration;
        storedSession['finalizationState'] = {
          status: 'pending',
          executionId: 'exec-winning',
          queuedAt: 10,
        };
      });
    });

    const result = await staleWriter.updateSession(session.sessionId, { electionId: 'stale-election' });

    expect(result).toMatchObject({
      electionId: 'winning-election',
      finalizationState: { status: 'pending', executionId: 'exec-winning' },
    });
    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(persisted?.electionId).toBe('winning-election');
    expect(persisted?.finalizationState).toMatchObject({ status: 'pending', executionId: 'exec-winning' });
  });

  it('preserves winning persisted authority on stale finalization-result update races', async () => {
    const staleWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleWriter.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';
    await staleWriter.finalizeSession(
      session.sessionId,
      buildFinalizationResult('exec-original'),
      contractGeneration,
      'exec-original',
    );

    client.runBeforeNextTransactWrite(() => {
      client.mutateSessionRow(session.sessionId, (row) => {
        row['finalized'] = true;
        const storedSession = row['session'] as Record<string, unknown>;
        storedSession['finalized'] = true;
        storedSession['finalizationContractGeneration'] = contractGeneration;
        storedSession['finalizationResult'] = buildFinalizationResult('exec-winning');
        storedSession['finalizationState'] = {
          status: 'succeeded',
          executionId: 'exec-winning',
          queuedAt: 10,
          startedAt: 11,
          completedAt: 12,
        };
      });
    });

    await expect(
      staleWriter.markVerificationRunning(session.sessionId, { executionId: 'exec-stale' }),
    ).rejects.toThrow();
    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(parseAwsPersistedFinalizationResult(persisted?.finalizationResult)?.verificationExecutionId).not.toBe(
      'exec-stale',
    );
    expect(persisted?.finalizationState).toMatchObject({ status: 'succeeded', executionId: 'exec-winning' });
  });

  it('rejects stale updateSession writes after a newer vote write without desynchronizing CT authority', async () => {
    const staleWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const winningWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleWriter.createSession();
    const voteId = generateVoteId();

    client.runBeforeNextTransactWrite(async () => {
      await winningWriter.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    });

    await expect(staleWriter.updateSession(session.sessionId, { electionId: 'stale-election' })).resolves.toMatchObject(
      {
        electionId: session.electionId,
        userVoteIndex: 0,
      },
    );

    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(persisted?.electionId).toBe(session.electionId);
    expect(persisted?.userVoteIndex).toBe(0);
    expect(persisted?.botCount).toBe(0);
    expect(persisted?.votes.size).toBe(1);
    expect(persisted?.bulletinRootHistory).toHaveLength(1);
    await expect(
      new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getVoteByIdWithProof(
        session.sessionId,
        voteId,
      ),
    ).resolves.toMatchObject({ leafIndex: 0 });
  });

  it('rejects stale bot-vote persistence without overwriting finalization authority', async () => {
    const staleWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await staleWriter.createSession();
    const contractGeneration = session.contractGeneration ?? 'current';
    const userVoteId = generateVoteId();
    const staleBotVoteId = generateVoteId();

    await staleWriter.addVote(session.sessionId, buildVote(userVoteId, VoteChoice.A, 'a'));

    client.runBeforeNextTransactWrite(() => {
      client.mutateSessionRow(session.sessionId, (row) => {
        const storedSession = row['session'] as Record<string, unknown>;
        storedSession['finalizationContractGeneration'] = contractGeneration;
        storedSession['finalizationState'] = {
          status: 'pending',
          executionId: 'exec-winning',
          queuedAt: 10,
        };
      });
    });

    await expect(
      staleWriter.addBotVotes(session.sessionId, [buildVote(staleBotVoteId, VoteChoice.B, 'b')]),
    ).rejects.toThrow('ConditionalCheckFailedException');

    const cached = await staleWriter.getSession(session.sessionId);
    const persisted = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getSession(
      session.sessionId,
    );
    expect(cached?.finalizationState).toMatchObject({ status: 'pending', executionId: 'exec-winning' });
    expect(persisted?.finalizationState).toMatchObject({ status: 'pending', executionId: 'exec-winning' });
    expect(cached?.botCount).toBe(0);
    expect(persisted?.botCount).toBe(0);
    expect(cached?.votes.size).toBe(1);
    expect(persisted?.votes.size).toBe(1);
    expect(client.votes.get(session.sessionId)?.size).toBe(1);
    expect(await staleWriter.getVoteById(session.sessionId, staleBotVoteId)).toBeNull();
  });

  it('counts only active recoverable DynamoDB sessions', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const activeSession = await store.createSession();
    const staleSession = await store.createSession();

    expect(await store.getActiveSessionCount()).toBe(2);

    client.expireSession(staleSession.sessionId);
    expect(await store.getActiveSessionCount()).toBe(1);
    expect(await store.getSession(activeSession.sessionId)).not.toBeNull();
  });

  it('fails closed when DynamoDB vote indices are sparse during CT restore', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();

    await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    await writer.addBotVotes(session.sessionId, [
      buildVote(generateVoteId(), VoteChoice.B, 'b'),
      buildVote(generateVoteId(), VoteChoice.B, 'c'),
    ]);
    client.deleteVoteRow(session.sessionId, 1);

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    await expect(reader.getVoteByIdWithProof(session.sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it.each([
    [
      'malformed encrypted vote',
      (row: Record<string, unknown>) => {
        row['vote'] = 'not-encrypted';
      },
    ],
    [
      'malformed encrypted rand',
      (row: Record<string, unknown>) => {
        row['rand'] = 'not-encrypted';
      },
    ],
    [
      'auth-tag decrypt failure',
      (row: Record<string, unknown>) => {
        row['vote'] = corruptEncryptedPayload(row['vote']);
      },
    ],
    [
      'invalid decrypted random hex',
      (row: Record<string, unknown>) => {
        row['rand'] = encryptVoteSecret('not-hex');
      },
    ],
  ])('fails closed when a DynamoDB vote row has %s', async (_name, mutate) => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();

    await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    client.mutateVoteRow(session.sessionId, 0, mutate);

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    await expect(reader.getVoteByIdWithProof(session.sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when DynamoDB vote indices are duplicated during CT restore', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();

    await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    client.duplicateVoteRow(session.sessionId, 0);

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    await expect(reader.getVoteByIdWithProof(session.sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when a DynamoDB vote row is missing rootAtCast', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();

    await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    client.mutateVoteRow(session.sessionId, 0, (row) => {
      delete row['rootAtCast'];
    });

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    await expect(reader.getVoteByIdWithProof(session.sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when a DynamoDB vote row rootAtCast differs from the reconstructed CT root', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();

    await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    client.mutateVoteRow(session.sessionId, 0, (row) => {
      row['rootAtCast'] = `0x${'3'.repeat(64)}`;
    });

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    await expect(reader.getVoteByIdWithProof(session.sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when persisted DynamoDB root history differs from reconstructed CT state', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();

    await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    client.mutateSessionRow(session.sessionId, (row) => {
      const storedSession = row['session'] as { bulletinRootHistory?: Array<Record<string, unknown>> };
      if (!storedSession.bulletinRootHistory?.[0]) {
        throw new Error('Missing persisted root history');
      }
      storedSession.bulletinRootHistory[0]['root'] = `0x${'4'.repeat(64)}`;
    });

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    await expect(reader.getVoteByIdWithProof(session.sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when finalized DynamoDB bulletin authority differs from restored CT state', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();

    await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));
    const persistedSession = await writer.getSession(session.sessionId);
    const bulletinRoot = persistedSession?.bulletinRootHistory?.at(-1)?.root;
    if (!bulletinRoot) {
      throw new Error('Expected bulletin root after vote');
    }
    client.mutateSessionRow(session.sessionId, (row) => {
      const storedSession = row['session'] as { finalizationResult?: Record<string, unknown> };
      storedSession.finalizationResult = {
        ...buildFinalizationResultFromJournal({
          journal: {
            ...createTestJournal({ totalExpected: 1, validVotes: 1, seenIndicesCount: 1 }),
            bulletinRoot,
            treeSize: 1,
            totalExpected: 1,
          },
          imageId: `0x${'1'.repeat(64)}`,
        }),
        journal: {
          ...createTestJournal({ totalExpected: 1, validVotes: 1, seenIndicesCount: 1 }),
          bulletinRoot: `0x${'5'.repeat(64)}`,
          treeSize: 1,
          totalExpected: 1,
        },
        bulletinRoot: `0x${'5'.repeat(64)}`,
      };
    });

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    await expect(reader.getVoteByIdWithProof(session.sessionId, voteId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('does not expose sessionless vote proof lookup as target acceptance evidence', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const voteId = generateVoteId();

    await store.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'c'));

    await expect(store.getVoteProof(voteId)).resolves.toBeNull();
  });

  it('keeps session summaries free of raw vote openings and private sidecars', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    await store.addVote(session.sessionId, buildVote(generateVoteId(), VoteChoice.A, 'd'));

    const summary = await store.getSessionSummary(session.sessionId);

    expect(typeof summary?.contractGeneration).toBe('string');
    expect(summary).toEqual({
      sessionId: session.sessionId,
      botCount: 0,
      contractGeneration: summary?.contractGeneration,
      finalizationArtifactState: undefined,
      finalized: false,
      userVoteIndex: 0,
    });
    expect(JSON.stringify(summary)).not.toContain('rand');
    expect(JSON.stringify(summary)).not.toContain('s3BundleKey');
    expect(JSON.stringify(summary)).not.toContain('verification.json');
  });

  it('derives session summary vote metadata from canonical vote rows when persisted metadata is stale', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    await writer.addVote(session.sessionId, buildVote(generateVoteId(), VoteChoice.A, 'd'));
    await writer.addBotVotes(session.sessionId, [
      buildVote(generateVoteId(), VoteChoice.B, 'e'),
      buildVote(generateVoteId(), VoteChoice.B, 'f'),
    ]);
    client.mutateSessionRow(session.sessionId, (row) => {
      const persistedSession = row['session'] as { botCount: number; userVoteIndex?: number };
      persistedSession.botCount = 99;
      persistedSession.userVoteIndex = 99;
    });

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const summary = await reader.getSessionSummary(session.sessionId);

    expect(summary).toEqual(
      expect.objectContaining({
        botCount: 2,
        userVoteIndex: 0,
      }),
    );
  });

  it('rejects stale concurrent user-vote persistence with a DynamoDB condition', async () => {
    const firstWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const secondWriter = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await firstWriter.createSession();

    const results = await Promise.allSettled([
      firstWriter.addVote(session.sessionId, buildVote(generateVoteId(), VoteChoice.A, '1')),
      secondWriter.addVote(session.sessionId, buildVote(generateVoteId(), VoteChoice.B, '2')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const persisted = await firstWriter.getSession(session.sessionId);
    expect(persisted?.userVoteIndex).toBe(0);
    expect(persisted?.votes.size).toBe(1);
  });

  it.each([
    {
      field: 'commitment',
      mutate: (row: Record<string, unknown>) => {
        row['commit'] = `0x${'f'.repeat(64)}`;
      },
      expectReloadFailure: true,
    },
    {
      field: 'vote opening',
      mutate: (row: Record<string, unknown>) => {
        row['vote'] = encryptVoteSecret(VoteChoice.B);
      },
      expectReloadFailure: false,
    },
    {
      field: 'random opening',
      mutate: (row: Record<string, unknown>) => {
        row['rand'] = encryptVoteSecret(`0x${'9'.repeat(64)}`);
      },
      expectReloadFailure: false,
    },
    {
      field: 'timestamp',
      mutate: (row: Record<string, unknown>) => {
        row['timestamp'] = Number(strictDefined(row['timestamp'])) + 1;
      },
      expectReloadFailure: false,
    },
    {
      field: 'CT root',
      mutate: (row: Record<string, unknown>) => {
        row['rootAtCast'] = `0x${'8'.repeat(64)}`;
      },
      expectReloadFailure: true,
    },
  ])('does not overwrite an existing same-voteId vote row after concurrent $field mutation', async (testCase) => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();
    await writer.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'a'));

    client.runBeforeNextTransactWrite(() => {
      client.mutateVoteRow(session.sessionId, 0, testCase.mutate);
    });

    if (testCase.expectReloadFailure) {
      await expect(writer.updateSession(session.sessionId, { electionId: 'updated-election' })).rejects.toThrow(
        'CT_PROOF_UNAVAILABLE',
      );
    } else {
      await expect(writer.updateSession(session.sessionId, { electionId: 'updated-election' })).resolves.toMatchObject({
        electionId: session.electionId,
      });
    }

    const row = client.firstVoteRow(session.sessionId);
    expect(row).toBeDefined();
    expect(row?.['voteId']).toBe(voteId);
    if (testCase.field === 'commitment') {
      expect(row?.['commit']).toBe(`0x${'f'.repeat(64)}`);
    }
    if (testCase.field === 'timestamp') {
      expect(row?.['timestamp']).not.toBe(session.votes.get(0)?.timestamp);
    }
    expect(client.sessionRow(session.sessionId)?.['session']).toMatchObject({ electionId: session.electionId });
  });

  it('persists encrypted vote openings while restoring domain vote data', async () => {
    const writer = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await writer.createSession();
    const voteId = generateVoteId();
    const rawRandom = `0x${'e'.repeat(64)}`;

    await writer.addVote(session.sessionId, {
      voteId,
      vote: VoteChoice.A,
      rand: rawRandom,
      commit: `0x${'0'.repeat(64)}`,
      path: [],
      timestamp: 123,
    });

    const storedVoteRow = client.firstVoteRow(session.sessionId);
    expect(storedVoteRow?.['voteData']).toBeUndefined();
    expect(storedVoteRow?.['vote']).toMatch(/^enc:v1:/);
    expect(storedVoteRow?.['rand']).toMatch(/^enc:v1:/);
    expect(JSON.stringify(storedVoteRow)).not.toContain(`"vote":"${VoteChoice.A}"`);
    expect(JSON.stringify(storedVoteRow)).not.toContain(rawRandom);

    const reader = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const restoredVote = await reader.getVoteById(session.sessionId, voteId);
    expect(restoredVote?.voteData.vote).toBe(VoteChoice.A);
    expect(restoredVote?.voteData.rand).toBe(rawRandom);
  });

  it('keeps heavyweight finalization payloads out of DynamoDB session rows', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const s3BundleKey = `sessions/${session.sessionId}/exec-1/bundle.zip`;
    const s3ReportKey = `sessions/${session.sessionId}/exec-1/verification.json`;
    const finalizationResult = {
      ...buildFinalizationResultFromJournal({
        journal: createTestJournal(),
        imageId: `0x${'1'.repeat(64)}`,
      }),
      verificationExecutionId: 'exec-1',
      s3BundleKey,
      s3UploadedAt: '2026-01-01T00:00:00.000Z',
      receipt: { seal: 'receipt-seal', journal: 'receipt-journal', imageId: `0x${'1'.repeat(64)}` },
      bitmapData: {
        includedBitmap: [true],
        includedBitmapRoot: `0x${'2'.repeat(64)}`,
        seenBitmap: [true],
        seenBitmapRoot: `0x${'3'.repeat(64)}`,
        treeSize: 1,
        finalizedAt: 123,
      },
      verificationResult: {
        status: 'success' as const,
        report: {
          status: 'success' as const,
          verifier_version: 'test',
          verified_at: '2026-01-01T00:00:00.000Z',
          duration_ms: 1,
          expected_image_id: `0x${'1'.repeat(64)}`,
          receipt_image_id: `0x${'1'.repeat(64)}`,
          bundle_path: '/tmp/private-bundle',
          receipt_path: '/tmp/private-receipt',
          dev_mode_receipt: false,
        },
        s3BundleKey,
        s3ReportKey,
        executionId: 'exec-1',
      },
    };

    await store.finalizeSession(
      session.sessionId,
      finalizationResult,
      session.contractGeneration ?? 'current',
      'exec-1',
    );

    const storedSession = client.sessionRow(session.sessionId);
    if (!storedSession) {
      throw new Error('Expected finalized session row to be persisted.');
    }
    const storedFinalizationResult = (storedSession['session'] as { finalizationResult?: Record<string, unknown> })
      .finalizationResult;
    const storedVerificationResult = storedFinalizationResult?.['verificationResult'] as
      Record<string, unknown> | undefined;
    const storedSessionJson = JSON.stringify(storedSession);
    expect(storedFinalizationResult).not.toHaveProperty('receipt');
    expect(storedFinalizationResult).not.toHaveProperty('receiptRaw');
    expect(storedFinalizationResult).not.toHaveProperty('bitmapData');
    expect(storedVerificationResult).not.toHaveProperty('report');
    expect(storedSessionJson).not.toContain('receiptRaw');
    expect(storedSessionJson).not.toContain('private-bundle');
    expect(storedSessionJson).not.toContain('receipt-seal');
    expect(storedSessionJson).toContain(s3BundleKey);
    expect(storedSessionJson).toContain(s3ReportKey);
  });

  it('saves and reads bitmap sidecars only for sessions with writable finalization authority', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const includedBitmap = [true, false];
    const seenBitmap = [true, true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
    const journal = {
      ...createTestJournal({ totalExpected: includedBitmap.length, validVotes: 1, seenIndicesCount: 2 }),
      treeSize: includedBitmap.length,
      totalExpected: includedBitmap.length,
      includedBitmapRoot,
      seenBitmapRoot,
    };

    await expect(
      store.saveBitmapData(session.sessionId, {
        includedBitmap: [true],
        includedBitmapRoot: computeIncludedBitmapRoot([true]),
        treeSize: 1,
        finalizedAt: 123,
      }),
    ).rejects.toThrow('Session finalization wrapper is not available');

    await store.markFinalizationSucceeded(session.sessionId, {
      executionId: 'exec-bitmap',
      queuedAt: 10,
      startedAt: 20,
      completedAt: 30,
      contractGeneration: session.contractGeneration ?? 'current',
      finalizationResult: buildFinalizationResult('exec-bitmap', { journal }),
    });

    await store.saveBitmapData(session.sessionId, {
      includedBitmap,
      includedBitmapRoot,
      seenBitmap,
      seenBitmapRoot,
      treeSize: includedBitmap.length,
      finalizedAt: 456,
    });

    const bitmap = await new DynamoSessionStore({ documentClient: asDocumentClient(client) }).getBitmapData(
      session.sessionId,
    );
    expect(bitmap).toEqual({
      sessionId: session.sessionId,
      includedBitmap,
      includedBitmapRoot,
      seenBitmap,
      seenBitmapRoot,
      treeSize: includedBitmap.length,
      finalizedAt: 456,
    });

    await expect(
      store.saveBitmapData('missing-session', {
        includedBitmap: [true],
        includedBitmapRoot: computeIncludedBitmapRoot([true]),
        treeSize: 1,
        finalizedAt: 789,
      }),
    ).rejects.toThrow('Session not found');
  });

  it.each([
    ['included root', { includedBitmapRoot: `0x${'2'.repeat(64)}` }],
    ['seen root', { seenBitmapRoot: `0x${'3'.repeat(64)}` }],
    ['tree size', { treeSize: 3 }],
    ['included bits', { includedBitmap: [false, false] }],
  ])('rejects corrupted bitmap sidecar evidence for %s mismatch', async (_label, corruptPatch) => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    const includedBitmap = [true, false];
    const seenBitmap = [true, true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
    const journal = {
      ...createTestJournal({ totalExpected: includedBitmap.length, validVotes: 1, seenIndicesCount: 2 }),
      treeSize: includedBitmap.length,
      totalExpected: includedBitmap.length,
      includedBitmapRoot,
      seenBitmapRoot,
    };

    await store.markFinalizationSucceeded(session.sessionId, {
      executionId: 'exec-bitmap-corrupt',
      queuedAt: 10,
      startedAt: 20,
      completedAt: 30,
      contractGeneration: session.contractGeneration ?? 'current',
      finalizationResult: buildFinalizationResult('exec-bitmap-corrupt', { journal }),
    });

    client.putBitmapSidecar(session.sessionId, {
      includedBitmap,
      includedBitmapRoot,
      seenBitmap,
      seenBitmapRoot,
      treeSize: includedBitmap.length,
      finalizedAt: 456,
      ...corruptPatch,
    });

    await expect(store.getBitmapData(session.sessionId)).resolves.toBeNull();
  });

  it('treats expired sessions and bitmap sidecars as absent before DynamoDB TTL deletion', async () => {
    const store = new DynamoSessionStore({ documentClient: asDocumentClient(client) });
    const session = await store.createSession();
    await store.addVote(session.sessionId, buildVote(generateVoteId(), VoteChoice.A, 'f'));
    const bitmap = [true];
    const bitmapRoot = computeIncludedBitmapRoot(bitmap);
    const votedSession = await store.getSession(session.sessionId);
    const bulletinRoot = votedSession?.bulletinRootHistory?.at(-1)?.root;
    if (!bulletinRoot) {
      throw new Error('Expected bulletin root after vote');
    }
    const journal = {
      ...createTestJournal({ totalExpected: 1, validVotes: 1, seenIndicesCount: 1 }),
      bulletinRoot,
      treeSize: 1,
      totalExpected: 1,
      includedBitmapRoot: bitmapRoot,
    };
    await store.finalizeSession(
      session.sessionId,
      buildFinalizationResult('exec-ttl-bitmap', { journal }),
      session.contractGeneration ?? 'current',
      'exec-ttl-bitmap',
    );
    client.putBitmapSidecar(session.sessionId, {
      includedBitmap: bitmap,
      includedBitmapRoot: bitmapRoot,
      treeSize: 1,
      finalizedAt: 123,
    });

    expect(await store.getSession(session.sessionId)).not.toBeNull();
    expect(await store.getBitmapData(session.sessionId)).not.toBeNull();

    client.expireSession(session.sessionId);
    expect(await store.getSession(session.sessionId)).toBeNull();
    expect(await store.getVoteById(session.sessionId, generateVoteId())).toBeNull();
    expect(await store.getBitmapData(session.sessionId)).toBeNull();

    const freshSession = await store.createSession();
    await store.finalizeSession(
      freshSession.sessionId,
      buildFinalizationResult('exec-expired-bitmap', { journal }),
      freshSession.contractGeneration ?? 'current',
      'exec-expired-bitmap',
    );
    client.putBitmapSidecar(freshSession.sessionId, {
      includedBitmap: bitmap,
      includedBitmapRoot: bitmapRoot,
      treeSize: 1,
      finalizedAt: 123,
    });
    client.expireSidecar(`BITMAP#${freshSession.sessionId}`);
    expect(await store.getBitmapData(freshSession.sessionId)).toBeNull();
  });
});

import { isDeepStrictEqual } from 'node:util';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import { encryptVoteSecret } from '@stark-ballot/aws-adapters/security/voteSecretCipher';
import { logger } from '@stark-ballot/diagnostics/logger';
import type { BotVoteCommand, UserVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { DynamoSessionStore } from './dynamoSessionStore';
import { defineSessionStoreContract } from './test-support/sessionStoreContract';

type CommandLike = {
  constructor: { name: string };
  input: Record<string, unknown>;
};

type TransactionItem = Record<string, Record<string, unknown>>;

class FakeDynamoDocumentClient {
  readonly sessions = new Map<string, Record<string, unknown>>();
  readonly votes = new Map<string, Map<number, Record<string, unknown>>>();
  readonly extraVoteRows = new Map<string, Array<Record<string, unknown>>>();
  transactWriteCalls = 0;
  lastTransactWriteItemCount = 0;

  private beforeNextTransactWrite: (() => Promise<void> | void) | null = null;
  private beforeNextPut: (() => Promise<void> | void) | null = null;
  private nextTransactWriteError: Error | null = null;
  private nextPutError: Error | null = null;
  private readonly sessionsTableName: string;
  private readonly votesTableName: string;

  constructor(sessionsTableName = 'sessions', votesTableName = 'votes') {
    this.sessionsTableName = sessionsTableName;
    this.votesTableName = votesTableName;
  }

  async send(command: CommandLike): Promise<Record<string, unknown>> {
    switch (command.constructor.name) {
      case 'GetCommand':
        return this.get(command.input);
      case 'PutCommand':
        if (this.beforeNextPut) {
          const callback = this.beforeNextPut;
          this.beforeNextPut = null;
          await callback();
        }
        if (this.nextPutError) {
          const error = this.nextPutError;
          this.nextPutError = null;
          throw error;
        }
        return this.put(command.input);
      case 'QueryCommand':
        return this.query(command.input);
      case 'ScanCommand':
        return this.scan(command.input);
      case 'TransactWriteCommand':
        return this.transactWrite(command.input);
      default:
        throw new Error(`Unsupported command: ${command.constructor.name}`);
    }
  }

  sessionRow(key: string): Record<string, unknown> | undefined {
    return structuredClone(this.sessions.get(key));
  }

  firstVoteRow(sessionId: string): Record<string, unknown> | undefined {
    return structuredClone(this.votes.get(sessionId)?.get(0));
  }

  mutateSessionRow(key: string, mutate: (row: Record<string, unknown>) => void): void {
    const row = this.sessions.get(key);
    if (!row) {
      throw new Error(`Missing session-table row: ${key}`);
    }
    mutate(row);
  }

  mutateVoteRow(sessionId: string, voteIndex: number, mutate: (row: Record<string, unknown>) => void): void {
    const row = this.votes.get(sessionId)?.get(voteIndex);
    if (!row) {
      throw new Error(`Missing vote row: ${sessionId}/${voteIndex}`);
    }
    mutate(row);
  }

  deleteVoteRow(sessionId: string, voteIndex: number): void {
    this.votes.get(sessionId)?.delete(voteIndex);
  }

  duplicateVoteRow(sessionId: string, voteIndex: number): void {
    const row = this.votes.get(sessionId)?.get(voteIndex);
    if (!row) {
      throw new Error(`Missing vote row: ${sessionId}/${voteIndex}`);
    }
    const extra = this.extraVoteRows.get(sessionId) ?? [];
    extra.push(structuredClone(row));
    this.extraVoteRows.set(sessionId, extra);
  }

  expireRow(key: string): void {
    this.mutateSessionRow(key, (row) => {
      row['expiresAt'] = Math.floor(Date.now() / 1000) - 1;
    });
  }

  runBeforeNextTransactWrite(callback: () => Promise<void> | void): void {
    this.beforeNextTransactWrite = callback;
  }

  runBeforeNextPut(callback: () => Promise<void> | void): void {
    this.beforeNextPut = callback;
  }

  failNextTransactWrite(error = new Error('forced transaction failure')): void {
    this.nextTransactWriteError = error;
  }

  failNextPut(error = new Error('forced put failure')): void {
    this.nextPutError = error;
  }

  restoreSnapshotTo(sessionsTableName: string, votesTableName: string): FakeDynamoDocumentClient {
    const restored = new FakeDynamoDocumentClient(sessionsTableName, votesTableName);
    for (const [key, value] of this.sessions) {
      restored.sessions.set(key, structuredClone(value));
    }
    for (const [sessionId, rows] of this.votes) {
      restored.votes.set(sessionId, new Map(Array.from(rows, ([index, row]) => [index, structuredClone(row)])));
    }
    for (const [sessionId, rows] of this.extraVoteRows) {
      restored.extraVoteRows.set(sessionId, structuredClone(rows));
    }
    return restored;
  }

  private get(input: Record<string, unknown>): Record<string, unknown> {
    this.assertTable(input, this.sessionsTableName);
    const key = input['Key'] as { sessionId: string };
    return { Item: structuredClone(this.sessions.get(key.sessionId)) };
  }

  private query(input: Record<string, unknown>): Record<string, unknown> {
    this.assertTable(input, this.votesTableName);
    const values = input['ExpressionAttributeValues'] as { ':sessionId': string };
    const rows = this.votes.get(values[':sessionId']);
    return {
      Items: [
        ...(rows ? Array.from(rows.values(), (row) => structuredClone(row)) : []),
        ...(this.extraVoteRows.get(values[':sessionId']) ?? []).map((row) => structuredClone(row)),
      ],
    };
  }

  private scan(input: Record<string, unknown>): Record<string, unknown> {
    this.assertTable(input, this.sessionsTableName);
    return {
      Items: Array.from(this.sessions.values(), (row) => structuredClone(row)),
    };
  }

  private put(input: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.requireString(input['TableName'], 'TableName');
    const item = input['Item'] as Record<string, unknown>;
    if (tableName === this.sessionsTableName) {
      const key = this.requireString(item['sessionId'], 'sessionId');
      const existing = this.sessions.get(key);
      this.assertCondition(input, existing);
      this.sessions.set(key, structuredClone(item));
      return {};
    }
    if (tableName === this.votesTableName) {
      const sessionId = this.requireString(item['sessionId'], 'sessionId');
      const voteIndex = this.requireNumber(item['voteIndex'], 'voteIndex');
      const rows = this.votes.get(sessionId) ?? new Map<number, Record<string, unknown>>();
      const existing = rows.get(voteIndex);
      this.assertCondition(input, existing);
      rows.set(voteIndex, structuredClone(item));
      this.votes.set(sessionId, rows);
      return {};
    }
    throw new Error(`Unexpected table: ${tableName}`);
  }

  private update(input: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.requireString(input['TableName'], 'TableName');
    const key = input['Key'] as { sessionId: string; voteIndex?: number };
    const existing =
      tableName === this.sessionsTableName
        ? this.sessions.get(key.sessionId)
        : tableName === this.votesTableName && key.voteIndex !== undefined
          ? this.votes.get(key.sessionId)?.get(key.voteIndex)
          : undefined;
    this.assertCondition(input, existing);
    if (!existing) {
      throw this.conditionalError();
    }
    const expression = this.requireString(input['UpdateExpression'], 'UpdateExpression');
    const names = (input['ExpressionAttributeNames'] ?? {}) as Record<string, string>;
    const values = (input['ExpressionAttributeValues'] ?? {}) as Record<string, unknown>;
    const match = /^SET (#[A-Za-z0-9_]+) = (:[A-Za-z0-9_]+)$/.exec(expression);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Unsupported update expression: ${expression}`);
    }
    const attribute = names[match[1]];
    if (!attribute) {
      throw new Error(`Missing update attribute name: ${match[1]}`);
    }
    existing[attribute] = structuredClone(values[match[2]]);
    return {};
  }

  private delete(input: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.requireString(input['TableName'], 'TableName');
    const key = input['Key'] as { sessionId: string; voteIndex?: number };
    if (tableName === this.sessionsTableName) {
      const existing = this.sessions.get(key.sessionId);
      this.assertCondition(input, existing);
      this.sessions.delete(key.sessionId);
      return {};
    }
    if (tableName === this.votesTableName && key.voteIndex !== undefined) {
      const existing = this.votes.get(key.sessionId)?.get(key.voteIndex);
      this.assertCondition(input, existing);
      this.votes.get(key.sessionId)?.delete(key.voteIndex);
      return {};
    }
    throw new Error(`Unexpected delete target: ${tableName}`);
  }

  private conditionCheck(input: Record<string, unknown>): Record<string, unknown> {
    const tableName = this.requireString(input['TableName'], 'TableName');
    const key = input['Key'] as { sessionId: string; voteIndex?: number };
    const existing =
      tableName === this.sessionsTableName
        ? this.sessions.get(key.sessionId)
        : key.voteIndex === undefined
          ? undefined
          : this.votes.get(key.sessionId)?.get(key.voteIndex);
    this.assertCondition(input, existing);
    return {};
  }

  private async transactWrite(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.transactWriteCalls += 1;
    this.lastTransactWriteItemCount = ((input['TransactItems'] ?? []) as TransactionItem[]).length;
    if (this.beforeNextTransactWrite) {
      const callback = this.beforeNextTransactWrite;
      this.beforeNextTransactWrite = null;
      await callback();
    }
    if (this.nextTransactWriteError) {
      const error = this.nextTransactWriteError;
      this.nextTransactWriteError = null;
      throw error;
    }
    const sessionSnapshot = structuredClone(Array.from(this.sessions.entries()));
    const voteSnapshot = structuredClone(
      Array.from(this.votes, ([sessionId, rows]) => [sessionId, Array.from(rows.entries())] as const),
    );
    const extraSnapshot = structuredClone(Array.from(this.extraVoteRows.entries()));
    const items = (input['TransactItems'] ?? []) as TransactionItem[];
    let itemIndex = 0;
    try {
      for (const [index, item] of items.entries()) {
        itemIndex = index;
        if (item['Put']) {
          this.put(item['Put']);
        } else if (item['Update']) {
          this.update(item['Update']);
        } else if (item['Delete']) {
          this.delete(item['Delete']);
        } else if (item['ConditionCheck']) {
          this.conditionCheck(item['ConditionCheck']);
        } else {
          throw new Error('Unsupported transaction item');
        }
      }
      return {};
    } catch (error) {
      this.sessions.clear();
      for (const [key, row] of sessionSnapshot) {
        this.sessions.set(key, row);
      }
      this.votes.clear();
      for (const [sessionId, rows] of voteSnapshot) {
        this.votes.set(sessionId, new Map(rows));
      }
      this.extraVoteRows.clear();
      for (const [sessionId, rows] of extraSnapshot) {
        this.extraVoteRows.set(sessionId, rows);
      }
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        throw new TransactionCanceledException({
          $metadata: {},
          message: 'Transaction cancelled',
          CancellationReasons: items.map((_, index) =>
            index === itemIndex
              ? { Code: 'ConditionalCheckFailed', Message: 'The conditional request failed' }
              : { Code: 'None' },
          ),
        });
      }
      throw error;
    }
  }

  private assertCondition(input: Record<string, unknown>, existing: Record<string, unknown> | undefined): void {
    const expression = input['ConditionExpression'];
    if (typeof expression !== 'string' || expression.length === 0) {
      return;
    }
    const names = (input['ExpressionAttributeNames'] ?? {}) as Record<string, string>;
    const values = (input['ExpressionAttributeValues'] ?? {}) as Record<string, unknown>;
    for (const part of expression.split(/\s+AND\s+/u)) {
      const notExists = /^attribute_not_exists\((#[A-Za-z0-9_]+)\)$/.exec(part);
      if (notExists?.[1]) {
        const attribute = names[notExists[1]];
        if (attribute && existing?.[attribute] !== undefined) {
          throw this.conditionalError();
        }
        continue;
      }
      const exists = /^attribute_exists\((#[A-Za-z0-9_]+)\)$/.exec(part);
      if (exists?.[1]) {
        const attribute = names[exists[1]];
        if (!attribute || existing?.[attribute] === undefined) {
          throw this.conditionalError();
        }
        continue;
      }
      const equality = /^(#[A-Za-z0-9_]+) = (:[A-Za-z0-9_]+)$/.exec(part);
      if (equality?.[1] && equality[2]) {
        const attribute = names[equality[1]];
        if (!attribute || !isDeepStrictEqual(existing?.[attribute], values[equality[2]])) {
          throw this.conditionalError();
        }
        continue;
      }
      throw new Error(`Unsupported condition expression: ${part}`);
    }
  }

  private conditionalError(): Error {
    const error = new Error('ConditionalCheckFailedException');
    error.name = 'ConditionalCheckFailedException';
    return error;
  }

  private assertTable(input: Record<string, unknown>, expected: string): void {
    const actual = this.requireString(input['TableName'], 'TableName');
    if (actual !== expected) {
      throw new Error(`Unexpected table: ${actual}; expected ${expected}`);
    }
  }

  private requireString(value: unknown, label: string): string {
    if (typeof value !== 'string') {
      throw new Error(`Expected ${label} to be a string`);
    }
    return value;
  }

  private requireNumber(value: unknown, label: string): number {
    if (typeof value !== 'number') {
      throw new Error(`Expected ${label} to be a number`);
    }
    return value;
  }
}

function asDocumentClient(client: FakeDynamoDocumentClient): DynamoDBDocumentClient {
  return client as unknown as DynamoDBDocumentClient;
}

const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 1,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

function buildVote(voteId: string, vote: 'A' | 'B' | 'C', randomNibble: string): UserVoteCommand {
  return {
    voteId,
    vote,
    rand: `0x${randomNibble.repeat(64)}`,
    timestamp: 1_730_000_000_000,
  };
}

function buildBotVote(randomNibble: string): BotVoteCommand {
  return {
    vote: 'B',
    rand: `0x${randomNibble.repeat(64)}`,
  };
}

function buildIndexedBotVote(index: number): BotVoteCommand {
  return {
    vote: 'B',
    rand: `0x${index.toString(16).padStart(64, '0')}`,
  };
}

function buildFinalizationResult(journal = createTestJournal()): FinalizationResultAuthority {
  return buildFinalizationResultFromJournal({
    journal,
    imageId: journal.imageId ?? `0x${'1'.repeat(64)}`,
  });
}

function buildSucceededRecord(
  sessionId: SessionId,
  finalizationId: string,
  result = buildFinalizationResult(),
): Extract<FinalizationRecord, { state: { status: 'succeeded' } }> {
  const admittedFinalizationId = asFinalizationId(finalizationId);
  return {
    sessionId,
    finalizationId: admittedFinalizationId,
    scenarioContext,
    state: {
      status: 'succeeded',
      finalizationId: admittedFinalizationId,
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
    },
    finalizationResult: {
      finalizationId: admittedFinalizationId,
      ...result,
    },
  };
}

function createStore(
  client: FakeDynamoDocumentClient,
  sessionsTableName = 'sessions',
  votesTableName = 'votes',
): DynamoSessionStore {
  return new DynamoSessionStore({
    sessionsTableName,
    votesTableName,
    documentClient: asDocumentClient(client),
  });
}

async function finalizeSucceeded(
  store: DynamoSessionStore,
  sessionId: SessionId,
  finalizationId: string,
  result = buildFinalizationResult(),
): Promise<FinalizationRecord> {
  return store.markFinalizationSucceeded(sessionId, {
    finalizationId: asFinalizationId(finalizationId),
    queuedAtMs: 10,
    startedAtMs: 20,
    completedAtMs: 30,
    scenarioContext,
    finalizationResult: result,
  });
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
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  it('does not fall back to process environment table identifiers', () => {
    expect(
      () =>
        new DynamoSessionStore({
          documentClient: asDocumentClient(client),
        } as never),
    ).toThrow('DYNAMODB_SESSIONS_TABLE must be set for DynamoDB session storage.');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  defineSessionStoreContract({
    name: 'DynamoSessionStore deterministic client',
    capabilities: {
      durableReload: true,
      lifecycleWriteFailure: true,
    },
    createHarness: () =>
      Promise.resolve({
        store: createStore(client),
        reload: () => Promise.resolve(createStore(client)),
        failNextLifecycleWrite: () => {
          client.failNextTransactWrite();
          return Promise.resolve();
        },
      }),
  });

  it('does not expose standalone receipt-board publication', () => {
    const store = createStore(client) as unknown as Record<string, unknown>;
    expect(store['publishReceipt']).toBeUndefined();
    expect(store['getSession']).toBeUndefined();
    expect(store['updateSession']).toBeUndefined();
  });

  it('persists separate complete identity and voting records', async () => {
    const identity = await createStore(client).createSession();
    const identityRow = client.sessionRow(identity.sessionId);
    const votingRow = client.sessionRow(`VOTING#${identity.sessionId}`);
    expect(identityRow).toMatchObject({
      itemType: 'SESSION_IDENTITY',
      identity,
    });
    expect(votingRow).toMatchObject({
      itemType: 'SESSION_VOTING',
      record: {
        sessionId: identity.sessionId,
        botCount: 0,
        userParticipation: { status: 'not_cast' },
      },
      revision: 0,
    });
    expect(identityRow).not.toHaveProperty('session');
    expect(votingRow).not.toHaveProperty('finalizationState');
  });

  it('atomically extends identity, voting, and existing vote rows on activity', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    await store.addBotVotes(identity.sessionId, [buildBotVote('b')]);

    vi.setSystemTime(new Date('2026-01-01T00:04:50.000Z'));
    await store.touchSession(identity.sessionId);

    const expectedExpiresAt = Math.floor(Date.now() / 1000) + 300;
    expect(client.sessionRow(identity.sessionId)?.['expiresAt']).toBe(expectedExpiresAt);
    expect(client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt']).toBe(expectedExpiresAt);
    expect(client.votes.get(identity.sessionId)?.get(0)?.['expiresAt']).toBe(expectedExpiresAt);
    expect(client.votes.get(identity.sessionId)?.get(1)?.['expiresAt']).toBe(expectedExpiresAt);
  });

  it('atomically aligns existing and new vote rows with the refreshed session deadline', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));

    vi.setSystemTime(new Date('2026-01-01T00:04:50.000Z'));
    await store.addBotVotes(identity.sessionId, [buildBotVote('b')]);

    const expectedExpiresAt = Math.floor(Date.now() / 1000) + 300;
    expect(client.sessionRow(identity.sessionId)?.['expiresAt']).toBe(expectedExpiresAt);
    expect(client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt']).toBe(expectedExpiresAt);
    expect(client.votes.get(identity.sessionId)?.get(0)?.['expiresAt']).toBe(expectedExpiresAt);
    expect(client.votes.get(identity.sessionId)?.get(1)?.['expiresAt']).toBe(expectedExpiresAt);
  });

  it('leaves every session-owned deadline unchanged when an activity transaction fails', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    const before = {
      identity: client.sessionRow(identity.sessionId)?.['expiresAt'],
      voting: client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt'],
      vote: client.votes.get(identity.sessionId)?.get(0)?.['expiresAt'],
    };

    vi.setSystemTime(new Date('2026-01-01T00:04:50.000Z'));
    client.failNextTransactWrite();
    await expect(store.touchSession(identity.sessionId)).rejects.toThrow('forced transaction failure');

    expect({
      identity: client.sessionRow(identity.sessionId)?.['expiresAt'],
      voting: client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt'],
      vote: client.votes.get(identity.sessionId)?.get(0)?.['expiresAt'],
    }).toEqual(before);
  });

  it('rejects a duplicate vote ID without changing persisted vote or bulletin indexes', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const voteId = generateVoteId();
    await store.addVote(identity.sessionId, buildVote(voteId, 'A', 'a'));
    const before = await store.getVotingRecord(identity.sessionId);
    await expect(store.addVote(identity.sessionId, buildVote(voteId, 'B', 'b'))).resolves.toEqual({
      ok: false,
      error: { code: 'DUPLICATE_VOTE', details: { duplicateKind: 'voteId' } },
    });
    const after = await store.getVotingRecord(identity.sessionId);
    expect(after?.votes).toEqual(before?.votes);
    expect(after?.bulletinRootHistory).toEqual(before?.bulletinRootHistory);
  });

  it('atomically records one verification observation across concurrent store instances', async () => {
    const first = createStore(client);
    const second = createStore(client);
    const identity = await first.createSession();
    await finalizeSucceeded(first, identity.sessionId, 'observation-race');
    const input = { fingerprint: 'a'.repeat(64), observedAt: 100 };
    const results = await Promise.all([
      first.recordVerificationObservation(identity.sessionId, 'observation-race', input),
      second.recordVerificationObservation(identity.sessionId, 'observation-race', {
        ...input,
        observedAt: 101,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['idempotent', 'recorded']);
  });

  it('keeps duplicate observation writes idempotent and rejects stale execution ids', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'observation-current');
    const input = { fingerprint: 'b'.repeat(64), observedAt: 100 };
    await expect(
      store.recordVerificationObservation(identity.sessionId, 'observation-current', input),
    ).resolves.toEqual({ status: 'recorded' });
    await expect(
      store.recordVerificationObservation(identity.sessionId, 'observation-current', {
        ...input,
        observedAt: 101,
      }),
    ).resolves.toEqual({ status: 'idempotent' });
    await expect(store.recordVerificationObservation(identity.sessionId, 'observation-stale', input)).resolves.toEqual({
      status: 'conflict',
      reason: 'finalization_mismatch',
    });
  });

  it('returns recorded when the observation commits before a competing activity write wins', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'observation-touch-race');
    const conditionalFailure = new Error('ConditionalCheckFailedException');
    conditionalFailure.name = 'ConditionalCheckFailedException';
    vi.spyOn(store, 'touchSession').mockRejectedValueOnce(conditionalFailure);

    await expect(
      store.recordVerificationObservation(identity.sessionId, 'observation-touch-race', {
        fingerprint: 'c'.repeat(64),
        observedAt: 100,
      }),
    ).resolves.toEqual({ status: 'recorded' });
    await expect(store.getVerificationObservation(identity.sessionId, 'observation-touch-race')).resolves.toMatchObject(
      {
        fingerprint: 'c'.repeat(64),
      },
    );
  });

  it('returns recorded when a post-commit activity touch fails outside the observation transaction', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'observation-touch-error');
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(store, 'touchSession').mockRejectedValueOnce(new Error('simulated network failure'));

    await expect(
      store.recordVerificationObservation(identity.sessionId, 'observation-touch-error', {
        fingerprint: 'e'.repeat(64),
        observedAt: 100,
      }),
    ).resolves.toEqual({ status: 'recorded' });
    await expect(
      store.getVerificationObservation(identity.sessionId, 'observation-touch-error'),
    ).resolves.toMatchObject({
      fingerprint: 'e'.repeat(64),
    });
    expect(warning).toHaveBeenCalledWith('[DynamoSessionStore] Post-commit activity touch failed', {
      operation: 'verification_observation',
      errorName: 'Error',
    });
  });

  it('does not introduce lifecycle observations for synchronous finalization persistence', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'sync-no-observation');
    expect(client.sessionRow(`OBSERVATION#${identity.sessionId}#sync-no-observation`)).toBeUndefined();
  });

  it('does not overwrite unrelated fields changed concurrently with an observation write', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'observation-isolated');
    await store.recordAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('observation-isolated'), {
      verificationWorkQueuedAtMs: 55,
    });
    await store.recordVerificationObservation(identity.sessionId, 'observation-isolated', {
      fingerprint: 'c'.repeat(64),
      observedAt: 100,
    });
    await expect(
      store.getAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('observation-isolated')),
    ).resolves.toEqual({ verificationWorkQueuedAtMs: 55 });
  });

  it('does not let an activity write erase a concurrently recorded observation', async () => {
    const first = createStore(client);
    const second = createStore(client);
    const identity = await first.createSession();
    await finalizeSucceeded(first, identity.sessionId, 'observation-activity');
    await second.recordVerificationObservation(identity.sessionId, 'observation-activity', {
      fingerprint: 'd'.repeat(64),
      observedAt: 100,
    });
    await first.touchSession(identity.sessionId);
    await expect(first.getVerificationObservation(identity.sessionId, 'observation-activity')).resolves.toMatchObject({
      fingerprint: 'd'.repeat(64),
    });
  });

  it('persists sessions and restores exact session-scoped CT proofs from vote rows', async () => {
    const writer = createStore(client);
    const identity = await writer.createSession();
    const voteId = generateVoteId();
    const cast = await writer.addVote(identity.sessionId, buildVote(voteId, 'A', 'a'));
    if (!cast.ok) {
      throw new Error(`Expected vote persistence, received ${cast.error.code}`);
    }
    const reader = createStore(client);
    await expect(reader.getVoteByIdWithProof(identity.sessionId, voteId)).resolves.toMatchObject({
      leafIndex: 0,
      treeSize: 1,
      bulletinRootAtCast: cast.value.bulletinRootAtCast,
    });
  });

  it('restores complete exact records from a distinct replacement-table fixture', async () => {
    const writer = createStore(client);
    const identity = await writer.createSession();
    const voteId = generateVoteId();
    await writer.addVote(identity.sessionId, buildVote(voteId, 'A', 'a'));
    await finalizeSucceeded(writer, identity.sessionId, 'replacement-finalization');
    const replacement = client.restoreSnapshotTo('replacement-sessions', 'replacement-votes');
    const reader = createStore(replacement, 'replacement-sessions', 'replacement-votes');
    await expect(reader.getSessionIdentity(identity.sessionId)).resolves.toEqual(identity);
    await expect(reader.getVoteById(identity.sessionId, voteId)).resolves.toMatchObject({
      index: 0,
      voteData: { voteId },
    });
    await expect(reader.getCurrentFinalizationRecord(identity.sessionId)).resolves.toMatchObject({
      finalizationId: 'replacement-finalization',
    });
  });

  it('exposes only explicit activity mutation and rejects missing session authority', async () => {
    const store = createStore(client) as DynamoSessionStore & Record<string, unknown>;
    const identity = await store.createSession();
    await expect(store.touchSession(identity.sessionId)).resolves.toBeUndefined();
    await expect(store.touchSession(asSessionId('missing-session'))).rejects.toThrow('Session not found');
    expect(store['updateSession']).toBeUndefined();
  });

  it('persists DynamoDB finalization transitions across reloads', async () => {
    const writer = createStore(client);
    const identity = await writer.createSession();
    await writer.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('reload-lifecycle'),
      queuedAtMs: 10,
      scenarioContext,
    });
    await writer.markFinalizationRunning(identity.sessionId, {
      finalizationId: asFinalizationId('reload-lifecycle'),
      queuedAtMs: 10,
      startedAtMs: 20,
    });
    const reader = createStore(client);
    await expect(reader.getCurrentFinalizationRecord(identity.sessionId)).resolves.toMatchObject({
      state: { status: 'running', finalizationId: 'reload-lifecycle' },
    });
  });

  it('persists direct terminal states and keeps them sticky', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const failed = await store.markFinalizationFailed(identity.sessionId, {
      finalizationId: asFinalizationId('direct-failed'),
      queuedAtMs: 10,
      failedAtMs: 20,
      scenarioContext,
      error: { code: 'FINALIZATION_FAILED', message: 'failed' },
    });
    await expect(
      store.markFinalizationSucceeded(identity.sessionId, {
        finalizationId: asFinalizationId('direct-failed'),
        queuedAtMs: 10,
        startedAtMs: 30,
        completedAtMs: 40,
        finalizationResult: buildFinalizationResult(),
      }),
    ).resolves.toEqual(failed);
  });

  it('persists scenario context with the first queued finalization record', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('scenario-context'),
      queuedAtMs: 10,
      scenarioContext,
    });
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toMatchObject({
      scenarioContext,
    });
  });

  it('fails closed for a malformed current-finalization pointer', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('malformed-pointer'),
      queuedAtMs: 10,
      scenarioContext,
    });
    client.mutateSessionRow(`FINALIZATION_CURRENT#${identity.sessionId}`, (row) => {
      row['currentFinalizationId'] = 123;
    });
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).rejects.toThrow(
      'Failed to load current finalization record',
    );
  });

  it('fails closed for a corrupt exact finalization record before applying a transition', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('corrupt-record'),
      queuedAtMs: 10,
      scenarioContext,
    });
    client.mutateSessionRow(`FINALIZATION#${identity.sessionId}#corrupt-record`, (row) => {
      row['record'] = {};
    });
    await expect(
      store.markFinalizationRunning(identity.sessionId, {
        finalizationId: asFinalizationId('corrupt-record'),
        queuedAtMs: 10,
        startedAtMs: 20,
      }),
    ).rejects.toThrow();
  });

  it('does not emit a successful transition or retain mutations when persistence fails', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    client.failNextTransactWrite();
    await expect(
      store.markFinalizationQueued(identity.sessionId, {
        finalizationId: asFinalizationId('failed-write'),
        queuedAtMs: 10,
        scenarioContext,
      }),
    ).rejects.toThrow();
    expect(await store.getCurrentFinalizationRecord(identity.sessionId)).toBeNull();
    expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(0);
  });

  it.each([
    ['capacity failure', 'ProvisionedThroughputExceeded', false],
    ['mixed capacity failure', 'ProvisionedThroughputExceeded', true],
    ['validation failure', 'ValidationError', false],
    ['mixed validation failure', 'ValidationError', true],
    ['transaction conflict', 'TransactionConflict', false],
    ['mixed transaction conflict', 'TransactionConflict', true],
    ['unknown code', 'FutureFailure', false],
    ['mixed unknown code', 'FutureFailure', true],
  ] as const)('does not retry a transaction with %s', async (_label, code, mixed) => {
    const store = createStore(client);
    const identity = await store.createSession();
    const beforeCalls = client.transactWriteCalls;
    const failure = new TransactionCanceledException({ $metadata: {}, message: 'ConditionalCheckFailedException' });
    client.runBeforeNextTransactWrite(() => {
      failure.CancellationReasons = Array.from({ length: client.lastTransactWriteItemCount }, (_, index) => ({
        Code: index === 0 && mixed ? 'ConditionalCheckFailed' : index === 1 ? code : 'None',
      }));
      client.failNextTransactWrite(failure);
    });
    await expect(
      store.markFinalizationQueued(identity.sessionId, {
        finalizationId: asFinalizationId('transaction-mixed-failure'),
        queuedAtMs: 10,
        scenarioContext,
      }),
    ).rejects.toMatchObject({ message: 'Failed to persist finalization transition', cause: failure });
    expect(client.transactWriteCalls).toBe(beforeCalls + 1);
    expect(await store.getCurrentFinalizationRecord(identity.sessionId)).toBeNull();
  });

  it.each([
    ['absent reasons', () => undefined],
    ['null reasons', () => null],
    ['non-array reasons', () => ({ Code: 'ConditionalCheckFailed' })],
    ['empty reasons', () => []],
    ['incomplete reasons', () => [{ Code: 'ConditionalCheckFailed' }]],
    ['extra reasons', (count: number) => Array.from({ length: count + 1 }, () => ({ Code: 'ConditionalCheckFailed' }))],
    [
      'sparse reasons',
      (count: number) => Object.assign(new Array<unknown>(count), { 0: { Code: 'ConditionalCheckFailed' } }),
    ],
    ['missing codes', (count: number) => Array.from({ length: count }, () => ({}))],
    ['null entry', (count: number) => Array.from({ length: count }, () => null)],
    ['invalid codes', (count: number) => Array.from({ length: count }, () => ({ Code: 1 }))],
    [
      'invalid message',
      (count: number) => Array.from({ length: count }, () => ({ Code: 'ConditionalCheckFailed', Message: 1 })),
    ],
    ['no failure', (count: number) => Array.from({ length: count }, () => ({ Code: 'None' }))],
  ])('does not infer conditional contention from %s', async (_label, reasons) => {
    const store = createStore(client);
    const identity = await store.createSession();
    const beforeCalls = client.transactWriteCalls;
    client.runBeforeNextTransactWrite(() => {
      client.failNextTransactWrite(
        Object.assign(new Error('ConditionalCheckFailedException'), {
          name: 'TransactionCanceledException',
          CancellationReasons: reasons(client.lastTransactWriteItemCount),
        }),
      );
    });
    await expect(
      store.markFinalizationQueued(identity.sessionId, {
        finalizationId: asFinalizationId('transaction-invalid-reasons'),
        queuedAtMs: 10,
        scenarioContext,
      }),
    ).rejects.toThrow('Failed to persist finalization transition');
    expect(client.transactWriteCalls).toBe(beforeCalls + 1);
    expect(await store.getCurrentFinalizationRecord(identity.sessionId)).toBeNull();
  });

  it.each([0, 1, 2, 3])('retries a conditional transaction failure at ordered item %i', async (failedIndex) => {
    const store = createStore(client);
    const identity = await store.createSession();
    const beforeCalls = client.transactWriteCalls;
    client.runBeforeNextTransactWrite(() => {
      expect(client.lastTransactWriteItemCount).toBe(4);
      client.failNextTransactWrite(
        new TransactionCanceledException({
          $metadata: {},
          message: 'Transaction cancelled',
          CancellationReasons: Array.from({ length: client.lastTransactWriteItemCount }, (_, index) => ({
            Code: index === failedIndex ? 'ConditionalCheckFailed' : 'None',
          })),
        }),
      );
    });
    await expect(
      store.markFinalizationQueued(identity.sessionId, {
        finalizationId: asFinalizationId('transaction-condition'),
        queuedAtMs: 10,
        scenarioContext,
      }),
    ).resolves.toMatchObject({ state: { status: 'pending' } });
    expect(client.transactWriteCalls).toBe(beforeCalls + 2);
  });

  it('does not turn a transaction failure into idempotent success after an identical concurrent write', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const payload = { finalizationId: asFinalizationId('concurrent-write-failure'), queuedAtMs: 10, scenarioContext };
    const failure = new TransactionCanceledException({ $metadata: {}, message: 'Transaction cancelled' });
    const beforeCalls = client.transactWriteCalls;
    client.runBeforeNextTransactWrite(async () => {
      await store.markFinalizationQueued(identity.sessionId, payload);
      failure.CancellationReasons = Array.from({ length: client.lastTransactWriteItemCount }, (_, index) => ({
        Code: index === 0 ? 'ValidationError' : 'None',
      }));
      client.failNextTransactWrite(failure);
    });
    await expect(store.markFinalizationQueued(identity.sessionId, payload)).rejects.toMatchObject({
      message: 'Failed to persist finalization transition',
      cause: failure,
    });
    expect(client.transactWriteCalls).toBe(beforeCalls + 2);
    expect(await store.getCurrentFinalizationRecord(identity.sessionId)).toMatchObject({
      state: { status: 'pending' },
    });
  });

  it('rejects a conditional reason at an unconditional transaction item', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const finalizationId = asFinalizationId('unconditional-item-failure');
    await finalizeSucceeded(store, identity.sessionId, finalizationId);
    await store.markVerificationRunning(identity.sessionId, finalizationId);
    const beforeCalls = client.transactWriteCalls;
    const failure = new TransactionCanceledException({
      $metadata: {},
      message: 'Transaction cancelled',
      // Completion conditionally writes verification, then unconditionally removes rollback metadata.
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    client.failNextTransactWrite(failure);
    await expect(
      store.completeVerificationResult(identity.sessionId, finalizationId, { status: 'success' }),
    ).rejects.toBe(failure);
    expect(client.lastTransactWriteItemCount).toBe(2);
    expect(client.transactWriteCalls).toBe(beforeCalls + 1);
    expect(await store.getVerificationResultRecord(identity.sessionId, finalizationId)).toMatchObject({
      verificationResult: { status: 'running' },
    });
  });

  it('does not infer a single-item conditional failure from the message', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const finalizationId = asFinalizationId('put-failure-message');
    const failure = new Error('ConditionalCheckFailedException');
    client.failNextPut(failure);
    await expect(
      store.markAwsFinalizationRunning(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
        scenarioContext,
        stepFunctionsArn: 'arn:aws:states:local:000000000000:execution:test:metadata',
      }),
    ).rejects.toBe(failure);
    expect(await store.getAwsFinalizationRuntimeMetadata(identity.sessionId, finalizationId)).toBeUndefined();
  });

  it('keeps USER_CANCELLED failed state when same-finalizationId running arrives through the Dynamo wrapper path', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('cancelled'),
      queuedAtMs: 10,
      scenarioContext,
    });
    const cancelled = await store.markFinalizationFailed(identity.sessionId, {
      finalizationId: asFinalizationId('cancelled'),
      queuedAtMs: 10,
      failedAtMs: 20,
      error: { code: 'USER_CANCELLED', message: 'cancelled' },
    });
    await expect(
      store.markAwsFinalizationRunning(identity.sessionId, {
        finalizationId: asFinalizationId('cancelled'),
        queuedAtMs: 10,
        startedAtMs: 30,
        stepFunctionsArn: 'arn:aws:states:local:execution:late',
      }),
    ).resolves.toEqual(cancelled.state);
    await expect(
      store.getAwsFinalizationRuntimeMetadata(identity.sessionId, asFinalizationId('cancelled')),
    ).resolves.toBeUndefined();
  });

  it('rejects widened pure lifecycle payloads that include AWS runtime metadata before DynamoDB persistence', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await expect(
      store.markFinalizationRunning(identity.sessionId, {
        finalizationId: 'widened',
        queuedAtMs: 10,
        startedAtMs: 20,
        scenarioContext,
        stepFunctionsArn: 'arn:forbidden',
      } as never),
    ).rejects.toThrow('Invalid running finalization payload');
    expect(await store.getCurrentFinalizationRecord(identity.sessionId)).toBeNull();
  });

  it('persists AWS callback bundle metadata separately from semantic finalization authority', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.markAwsFinalizationSucceeded(identity.sessionId, {
      finalizationId: asFinalizationId('aws-success'),
      queuedAtMs: 10,
      startedAtMs: 20,
      completedAtMs: 30,
      scenarioContext,
      finalizationResult: buildFinalizationResult(),
      stepFunctionsArn: 'arn:aws:states:local:execution:success',
      bundleMetadata: {
        s3BundleKey: `sessions/${identity.sessionId}/aws-success/bundle.zip`,
        s3UploadedAtMs: 30,
      },
    });
    const record = await store.getCurrentFinalizationRecord(identity.sessionId);
    expect(record).not.toHaveProperty('stepFunctionsArn');
    expect(record?.finalizationResult).not.toHaveProperty('s3BundleKey');
    await expect(
      store.getAwsFinalizationRuntimeMetadata(identity.sessionId, asFinalizationId('aws-success')),
    ).resolves.toMatchObject({
      stepFunctionsArn: 'arn:aws:states:local:execution:success',
      bundleMetadata: {
        s3BundleKey: `sessions/${identity.sessionId}/aws-success/bundle.zip`,
      },
    });
    await expect(
      store.getAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('aws-success')),
    ).resolves.toMatchObject({
      s3BundleKey: `sessions/${identity.sessionId}/aws-success/bundle.zip`,
    });
  });

  it.each(['running', 'succeeded', 'failed', 'timeout'] as const)(
    'rejects an empty Step Functions ARN before the AWS %s lifecycle transition is persisted',
    async (transition) => {
      const store = createStore(client);
      const identity = await store.createSession();
      const finalizationId = asFinalizationId(`invalid-${transition}-arn`);
      let operation: Promise<FinalizationState>;
      switch (transition) {
        case 'running':
          operation = store.markAwsFinalizationRunning(identity.sessionId, {
            finalizationId,
            queuedAtMs: 10,
            startedAtMs: 20,
            scenarioContext,
            stepFunctionsArn: '',
          });
          break;
        case 'succeeded':
          operation = store.markAwsFinalizationSucceeded(identity.sessionId, {
            finalizationId,
            queuedAtMs: 10,
            startedAtMs: 20,
            completedAtMs: 30,
            scenarioContext,
            finalizationResult: buildFinalizationResult(),
            stepFunctionsArn: '',
          });
          break;
        case 'failed':
          operation = store.markAwsFinalizationFailed(identity.sessionId, {
            finalizationId,
            queuedAtMs: 10,
            failedAtMs: 20,
            scenarioContext,
            error: { code: 'FINALIZATION_FAILED', message: 'failed' },
            stepFunctionsArn: '',
          });
          break;
        case 'timeout':
          operation = store.markAwsFinalizationTimedOut(identity.sessionId, {
            finalizationId,
            queuedAtMs: 10,
            timeoutAtMs: 20,
            scenarioContext,
            stepFunctionsArn: '',
          });
          break;
      }

      await expect(operation).rejects.toThrow('Invalid AWS finalization runtime metadata');
      await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
    },
  );

  it('rejects malformed bundle metadata before the succeeded lifecycle transition is persisted', async () => {
    const store = createStore(client);
    const identity = await store.createSession();

    await expect(
      store.markAwsFinalizationSucceeded(identity.sessionId, {
        finalizationId: asFinalizationId('invalid-bundle-metadata'),
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: buildFinalizationResult(),
        bundleMetadata: { s3BundleKey: '', s3UploadedAtMs: 30 },
      }),
    ).rejects.toThrow('Invalid AWS finalization runtime metadata');
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toBeNull();
  });

  it('rejects a stale DynamoDB finalization transition without creating a second record', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const current = await store.markFinalizationRunning(identity.sessionId, {
      finalizationId: asFinalizationId('current-id'),
      queuedAtMs: 10,
      startedAtMs: 20,
      scenarioContext,
    });
    await expect(
      store.markFinalizationQueued(identity.sessionId, {
        finalizationId: asFinalizationId('stale-id'),
        queuedAtMs: 30,
        scenarioContext,
      }),
    ).resolves.toEqual(current);
    expect(client.sessionRow(`FINALIZATION#${identity.sessionId}#stale-id`)).toBeUndefined();
  });

  it('emits one transition only after a DynamoDB finalization write succeeds', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('event-success'),
      queuedAtMs: 10,
      scenarioContext,
    });
    expect(info.mock.calls.filter(([message]) => message === 'finalization_admitted')).toHaveLength(1);
    expect(info.mock.calls.filter(([message]) => message === 'finalize_state_transition')).toHaveLength(1);
  });

  it('emits changed false when a competing DynamoDB writer already persisted the requested state', async () => {
    const first = createStore(client);
    const second = createStore(client);
    const identity = await first.createSession();
    const payload = { finalizationId: asFinalizationId('idempotent'), queuedAtMs: 10, scenarioContext };
    await first.markFinalizationQueued(identity.sessionId, payload);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    await second.markFinalizationQueued(identity.sessionId, payload);
    expect(info.mock.calls.filter(([message]) => message === 'finalization_admitted')).toHaveLength(0);
    expect(
      info.mock.calls.some(
        ([message, detail]) =>
          message === 'finalize_state_transition' && (detail as { changed?: unknown } | undefined)?.changed === false,
      ),
    ).toBe(true);
  });

  it('observes a retried transition from the exact lifecycle snapshot evaluated after a stale write', async () => {
    const first = createStore(client);
    const second = createStore(client);
    const identity = await first.createSession();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    client.runBeforeNextTransactWrite(async () => {
      await second.markFinalizationQueued(identity.sessionId, {
        finalizationId: asFinalizationId('observed-retry'),
        queuedAtMs: 10,
        scenarioContext,
      });
    });

    await first.markFinalizationFailed(identity.sessionId, {
      finalizationId: asFinalizationId('observed-retry'),
      queuedAtMs: 10,
      failedAtMs: 20,
      scenarioContext,
      error: { code: 'FINALIZATION_FAILED', message: 'failed' },
    });

    expect(
      info.mock.calls.some(
        ([message, detail]) =>
          message === 'finalize_state_transition' &&
          (detail as { changed?: unknown; from?: unknown; to?: unknown } | undefined)?.changed === true &&
          (detail as { from?: unknown } | undefined)?.from === 'pending' &&
          (detail as { to?: unknown } | undefined)?.to === 'failed',
      ),
    ).toBe(true);
  });

  it('reloads an exact same-ID lifecycle revision instead of overwriting newer scenario authority', async () => {
    const first = createStore(client);
    const second = createStore(client);
    const identity = await first.createSession();
    await first.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('same-id'),
      queuedAtMs: 10,
      scenarioContext,
    });
    const replacement = {
      ...scenarioContext,
      claimedTotalVotes: 2,
      claimedCounts: { ...scenarioContext.claimedCounts, A: 2 },
    };
    await second.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('same-id'),
      queuedAtMs: 20,
      scenarioContext: replacement,
    });
    await expect(first.getCurrentFinalizationRecord(identity.sessionId)).resolves.toMatchObject({
      scenarioContext: replacement,
      state: { queuedAtMs: 20 },
    });
  });

  it('preserves and merges runtime locators on idempotent enrichment', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const payload = {
      finalizationId: asFinalizationId('runtime-merge'),
      queuedAtMs: 10,
      startedAtMs: 20,
      scenarioContext,
    };
    await store.markFinalizationRunning(identity.sessionId, payload);
    await store.markAwsFinalizationRunning(identity.sessionId, {
      ...payload,
      stepFunctionsArn: 'arn:aws:states:local:execution:winning',
    });
    await store.recordAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('runtime-merge'), {
      verificationWorkQueuedAtMs: 25,
    });
    await expect(
      store.getAwsFinalizationRuntimeMetadata(identity.sessionId, asFinalizationId('runtime-merge')),
    ).resolves.toEqual({
      stepFunctionsArn: 'arn:aws:states:local:execution:winning',
    });
    await expect(
      store.getAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('runtime-merge')),
    ).resolves.toEqual({ verificationWorkQueuedAtMs: 25 });
  });

  it('rejects stale callback success for a competing execution ID', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const current = await store.markFinalizationRunning(identity.sessionId, {
      finalizationId: asFinalizationId('winner'),
      queuedAtMs: 10,
      startedAtMs: 20,
      scenarioContext,
    });
    await expect(
      store.markAwsFinalizationSucceeded(identity.sessionId, {
        finalizationId: asFinalizationId('loser'),
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: buildFinalizationResult(),
        bundleMetadata: { s3BundleKey: 'loser/bundle.zip', s3UploadedAtMs: 30 },
      }),
    ).resolves.toEqual(current.state);
    await expect(
      store.getAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('loser')),
    ).resolves.toBeUndefined();
  });

  it('does not attach running metadata to a stale callback with another finalization ID', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const current = await store.markFinalizationRunning(identity.sessionId, {
      finalizationId: asFinalizationId('running-winner'),
      queuedAtMs: 10,
      startedAtMs: 20,
      scenarioContext,
    });

    await expect(
      store.markAwsFinalizationRunning(identity.sessionId, {
        finalizationId: asFinalizationId('running-loser'),
        queuedAtMs: 10,
        startedAtMs: 20,
        scenarioContext,
        stepFunctionsArn: 'arn:aws:states:local:execution:running-loser',
      }),
    ).resolves.toEqual(current.state);
    await expect(
      store.getAwsFinalizationRuntimeMetadata(identity.sessionId, asFinalizationId('running-loser')),
    ).resolves.toBeUndefined();
  });

  it('does not attach bundle metadata to a stale succeeded callback with another finalization ID', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const current = await finalizeSucceeded(store, identity.sessionId, 'succeeded-winner');

    await expect(
      store.markAwsFinalizationSucceeded(identity.sessionId, {
        finalizationId: asFinalizationId('succeeded-loser'),
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: buildFinalizationResult(),
        stepFunctionsArn: 'arn:aws:states:local:execution:succeeded-loser',
        bundleMetadata: {
          s3BundleKey: 'sessions/stale/succeeded-loser/bundle.zip',
          s3UploadedAtMs: 30,
        },
      }),
    ).resolves.toEqual(current.state);
    await expect(
      store.getAwsFinalizationRuntimeMetadata(identity.sessionId, asFinalizationId('succeeded-loser')),
    ).resolves.toBeUndefined();
    await expect(
      store.getAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('succeeded-loser')),
    ).resolves.toBeUndefined();
  });

  it('returns the persisted USER_CANCELLED failed state when success loses to cancellation', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId: asFinalizationId('cancel-race'),
      queuedAtMs: 10,
      scenarioContext,
    });
    const cancelled = await store.markFinalizationFailed(identity.sessionId, {
      finalizationId: asFinalizationId('cancel-race'),
      queuedAtMs: 10,
      failedAtMs: 20,
      error: { code: 'USER_CANCELLED', message: 'cancelled' },
    });
    await expect(finalizeSucceeded(store, identity.sessionId, 'cancel-race')).resolves.toEqual(cancelled);
  });

  it('fails sync finalize on stale DynamoDB authority without overwriting the winner', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const winner = await store.markFinalizationFailed(identity.sessionId, {
      finalizationId: asFinalizationId('winner-sync'),
      queuedAtMs: 10,
      failedAtMs: 20,
      scenarioContext,
      error: { code: 'FINALIZATION_FAILED', message: 'winner' },
    });
    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(identity.sessionId, 'loser-sync'),
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow('Stale successful finalization commit');
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(winner);
  });

  it('leaves every successful-finalization artifact unchanged when the atomic transaction fails and admits retry', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const finalizationId = asFinalizationId('atomic-success-retry');
    await store.markFinalizationQueued(identity.sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    const bitmap = [true];
    const bitmapRoot = computeIncludedBitmapRoot(bitmap);
    const result = buildFinalizationResult({
      ...createTestJournal({ totalExpected: 1, validVotes: 1, seenIndicesCount: 1 }),
      includedBitmapRoot: bitmapRoot,
      seenBitmapRoot: bitmapRoot,
    });
    const input = {
      record: buildSucceededRecord(identity.sessionId, finalizationId, result),
      receipt: { receipt: '{"atomic":true}', timestamp: 100 },
      verificationResult: { status: 'success' as const },
      bitmap: {
        availability: 'available' as const,
        data: {
          includedBitmap: bitmap,
          includedBitmapRoot: bitmapRoot,
          seenBitmap: bitmap,
          seenBitmapRoot: bitmapRoot,
          treeSize: 1,
          finalizedAtMs: 30,
        },
      },
      runtimeMetadata: {
        stepFunctionsArn: 'arn:aws:states:local:execution:atomic-success-retry',
        bundleMetadata: {
          s3BundleKey: `sessions/${identity.sessionId}/${finalizationId}/bundle.zip`,
          s3UploadedAtMs: 31,
        },
      },
    };
    const pending = await store.getCurrentFinalizationRecord(identity.sessionId);

    client.failNextTransactWrite();
    await expect(store.commitSuccessfulFinalization(input)).rejects.toThrow('forced transaction failure');

    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(pending);
    expect(client.sessionRow(`RECEIPT#${identity.sessionId}#${finalizationId}`)).toBeUndefined();
    expect(client.sessionRow('RECEIPT_BOARD_COUNTER')).toBeUndefined();
    await expect(store.getVerificationResultRecord(identity.sessionId, finalizationId)).resolves.toBeNull();
    await expect(store.getBitmapData(identity.sessionId, finalizationId)).resolves.toBeNull();
    await expect(store.getAwsFinalizationRuntimeMetadata(identity.sessionId, finalizationId)).resolves.toBeUndefined();
    await expect(store.getAwsVerificationDeliveryMetadata(identity.sessionId, finalizationId)).resolves.toBeUndefined();

    await expect(store.commitSuccessfulFinalization(input)).resolves.toMatchObject({
      record: { state: { status: 'succeeded' } },
      bitmap: { availability: 'available' },
      receiptPublication: { timestamp: 100 },
    });
    await expect(store.getVerificationResultRecord(identity.sessionId, finalizationId)).resolves.toMatchObject({
      verificationResult: { status: 'success' },
    });
    await expect(store.getBitmapData(identity.sessionId, finalizationId)).resolves.toMatchObject({
      includedBitmap: bitmap,
      includedBitmapRoot: bitmapRoot,
    });
    await expect(store.getAwsFinalizationRuntimeMetadata(identity.sessionId, finalizationId)).resolves.toEqual(
      input.runtimeMetadata,
    );
    await expect(store.getAwsVerificationDeliveryMetadata(identity.sessionId, finalizationId)).resolves.toEqual({
      s3BundleKey: input.runtimeMetadata.bundleMetadata.s3BundleKey,
      s3UploadedAtMs: 31,
    });
  });

  it.each(['bitmap', 'verification'] as const)(
    'rejects a malformed persisted %s sibling on an idempotent successful commit',
    async (kind) => {
      const store = createStore(client);
      const identity = await store.createSession();
      const finalizationId = asFinalizationId(`malformed-${kind}-sibling`);
      const input = {
        record: buildSucceededRecord(identity.sessionId, finalizationId),
        bitmap: { availability: 'unavailable' as const },
      };
      await store.commitSuccessfulFinalization(input);
      const key =
        kind === 'bitmap'
          ? `BITMAP#${identity.sessionId}#${finalizationId}`
          : `VERIFICATION#${identity.sessionId}#${finalizationId}`;
      client.sessions.set(key, { sessionId: key, expiresAt: Math.floor(Date.now() / 1000) + 1_000 });

      await expect(store.commitSuccessfulFinalization(input)).rejects.toThrow(
        kind === 'bitmap' ? 'Invalid persisted finalization bitmap' : 'Invalid persisted verification result record',
      );
    },
  );

  it('routes direct success through the atomic commit and rejects a preterminal bitmap orphan', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const finalizationId = asFinalizationId('direct-success-bitmap-orphan');
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const result = buildFinalizationResult({
      ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    });
    const pending = await store.markFinalizationQueued(identity.sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    const key = `BITMAP#${identity.sessionId}#${finalizationId}`;
    client.sessions.set(key, {
      sessionId: key,
      itemType: 'FINALIZATION_BITMAP',
      ownerSessionId: identity.sessionId,
      finalizationId,
      bitmap: {
        sessionId: identity.sessionId,
        finalizationId,
        includedBitmap,
        includedBitmapRoot,
        treeSize: 1,
        finalizedAtMs: 30,
      },
      expiresAt: Math.floor(Date.now() / 1000) + 1_000,
    });

    await expect(
      store.markFinalizationSucceeded(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        startedAtMs: 20,
        completedAtMs: 30,
        scenarioContext,
        finalizationResult: result,
      }),
    ).rejects.toThrow('Successful finalization artifacts exist before terminal authority');
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(pending);
  });

  it.each(['bitmap', 'verification'] as const)(
    'rejects a preterminal %s orphan and preserves pending authority',
    async (kind) => {
      const store = createStore(client);
      const identity = await store.createSession();
      const finalizationId = asFinalizationId(`preterminal-${kind}-orphan`);
      const includedBitmap = [true];
      const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
      const result = buildFinalizationResult({
        ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
        includedBitmapRoot,
        seenBitmapRoot: includedBitmapRoot,
      });
      const pending = await store.markFinalizationQueued(identity.sessionId, {
        finalizationId,
        queuedAtMs: 10,
        scenarioContext,
      });
      const expiresAt = Math.floor(Date.now() / 1000) + 1_000;
      if (kind === 'bitmap') {
        const key = `BITMAP#${identity.sessionId}#${finalizationId}`;
        client.sessions.set(key, {
          sessionId: key,
          itemType: 'FINALIZATION_BITMAP',
          ownerSessionId: identity.sessionId,
          finalizationId,
          bitmap: {
            sessionId: identity.sessionId,
            finalizationId,
            includedBitmap,
            includedBitmapRoot,
            treeSize: 1,
            finalizedAtMs: 30,
          },
          expiresAt,
        });
      } else {
        const key = `VERIFICATION#${identity.sessionId}#${finalizationId}`;
        client.sessions.set(key, {
          sessionId: key,
          itemType: 'VERIFICATION_RESULT',
          ownerSessionId: identity.sessionId,
          finalizationId,
          record: {
            sessionId: identity.sessionId,
            finalizationId,
            verificationResult: { status: 'running' },
          },
          revision: 1,
          expiresAt,
        });
      }

      await expect(
        store.commitSuccessfulFinalization({
          record: buildSucceededRecord(identity.sessionId, finalizationId, result),
          bitmap: { availability: 'unavailable' },
        }),
      ).rejects.toThrow('Successful finalization artifacts exist before terminal authority');
      await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(pending);
    },
  );

  it('atomically detects a bitmap orphan created after admission but before the terminal transaction', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const finalizationId = asFinalizationId('bitmap-orphan-transaction-race');
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const result = buildFinalizationResult({
      ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    });
    const pending = await store.markFinalizationQueued(identity.sessionId, {
      finalizationId,
      queuedAtMs: 10,
      scenarioContext,
    });
    client.runBeforeNextTransactWrite(() => {
      const key = `BITMAP#${identity.sessionId}#${finalizationId}`;
      client.sessions.set(key, {
        sessionId: key,
        itemType: 'FINALIZATION_BITMAP',
        ownerSessionId: identity.sessionId,
        finalizationId,
        bitmap: {
          sessionId: identity.sessionId,
          finalizationId,
          includedBitmap,
          includedBitmapRoot,
          treeSize: 1,
          finalizedAtMs: 30,
        },
        expiresAt: Math.floor(Date.now() / 1000) + 1_000,
      });
    });

    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(identity.sessionId, finalizationId, result),
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow('Successful finalization artifacts exist before terminal authority');
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(pending);
  });

  it.each(['missing', 'not-advanced'] as const)(
    'rejects an idempotent receipt replay when the global counter is %s',
    async (counterState) => {
      const store = createStore(client);
      const identity = await store.createSession();
      const finalizationId = asFinalizationId(`receipt-counter-${counterState}`);
      const input = {
        record: buildSucceededRecord(identity.sessionId, finalizationId),
        receipt: { receipt: '{"counter":true}', timestamp: 30 },
        bitmap: { availability: 'unavailable' as const },
      };
      const committed = await store.commitSuccessfulFinalization(input);
      if (counterState === 'missing') {
        client.sessions.delete('RECEIPT_BOARD_COUNTER');
      } else {
        client.mutateSessionRow('RECEIPT_BOARD_COUNTER', (row) => {
          row['nextBoardIndex'] = committed.receiptPublication?.boardIndex ?? 100;
        });
      }

      await expect(store.commitSuccessfulFinalization(input)).rejects.toThrow(
        'Receipt board counter does not cover the persisted publication',
      );
      await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(committed.record);
    },
  );

  it.each(['extra-key', 'hash-mismatch'] as const)(
    'rejects a persisted receipt with %s before idempotent replay',
    async (corruption) => {
      const store = createStore(client);
      const identity = await store.createSession();
      const finalizationId = asFinalizationId(`receipt-${corruption}`);
      const input = {
        record: buildSucceededRecord(identity.sessionId, finalizationId),
        receipt: { receipt: '{"exact":true}', timestamp: 30 },
        bitmap: { availability: 'unavailable' as const },
      };
      const committed = await store.commitSuccessfulFinalization(input);
      client.mutateSessionRow(`RECEIPT#${identity.sessionId}#${finalizationId}`, (row) => {
        if (corruption === 'extra-key') {
          const receipt = row['receipt'] as Record<string, unknown>;
          receipt['unexpected'] = true;
        } else {
          row['receiptHash'] = `0x${'f'.repeat(64)}`;
        }
      });

      await expect(store.commitSuccessfulFinalization(input)).rejects.toThrow('Invalid persisted finalization receipt');
      await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(committed.record);
    },
  );

  it('atomically rejects stale receipt publication without consuming a board index or overwriting the winner', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'receipt-winner');
    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(identity.sessionId, 'receipt-loser'),
        receipt: { receipt: '{"loser":true}', timestamp: 100 },
        bitmap: { availability: 'unavailable' },
      }),
    ).rejects.toThrow('Stale successful finalization commit');
    expect(client.sessionRow('RECEIPT_BOARD_COUNTER')).toBeUndefined();
  });

  it('retries receipt counter contention for concurrent finalizations in different sessions', async () => {
    const first = createStore(client);
    const second = createStore(client);
    const firstIdentity = await first.createSession();
    const secondIdentity = await second.createSession();
    const [left, right] = await Promise.all([
      first.commitSuccessfulFinalization({
        record: buildSucceededRecord(firstIdentity.sessionId, 'receipt-first'),
        receipt: { receipt: '{"first":true}', timestamp: 100 },
        bitmap: { availability: 'unavailable' },
      }),
      second.commitSuccessfulFinalization({
        record: buildSucceededRecord(secondIdentity.sessionId, 'receipt-second'),
        receipt: { receipt: '{"second":true}', timestamp: 101 },
        bitmap: { availability: 'unavailable' },
      }),
    ]);
    expect(new Set([left.receiptPublication?.boardIndex, right.receiptPublication?.boardIndex]).size).toBe(2);
    expect(client.sessionRow('RECEIPT_BOARD_COUNTER')).toMatchObject({ nextBoardIndex: 102 });
  });

  it('preserves lifecycle authority across activity-only CAS writes', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'activity-separate');
    await store.touchSession(identity.sessionId);
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toMatchObject({
      finalizationId: 'activity-separate',
    });
  });

  it('does not shorten finalized artifact retention during an activity-only CAS write', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    await finalizeSucceeded(store, identity.sessionId, 'activity-retention');
    const finalizedExpiry = client.sessionRow(`FINALIZATION#${identity.sessionId}#activity-retention`)?.['expiresAt'];

    await store.touchSession(identity.sessionId);

    expect(client.sessionRow(identity.sessionId)?.['expiresAt']).toBe(finalizedExpiry);
    expect(client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt']).toBe(finalizedExpiry);
    expect(client.firstVoteRow(identity.sessionId)?.['expiresAt']).toBe(finalizedExpiry);
    expect(client.sessionRow(`FINALIZATION#${identity.sessionId}#activity-retention`)?.['expiresAt']).toBe(
      finalizedExpiry,
    );
  });

  it('does not shorten a longer session-row TTL when promoting successful finalization artifacts', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    const longerExpiresAt = Math.floor(Date.now() / 1000) + 20_000;
    client.mutateSessionRow(identity.sessionId, (row) => {
      row['expiresAt'] = longerExpiresAt;
    });
    client.mutateSessionRow(`VOTING#${identity.sessionId}`, (row) => {
      row['expiresAt'] = longerExpiresAt;
    });
    client.mutateVoteRow(identity.sessionId, 0, (row) => {
      row['expiresAt'] = longerExpiresAt;
    });

    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(identity.sessionId, 'longer-artifact-ttl'),
      bitmap: { availability: 'unavailable' },
    });

    expect(client.sessionRow(identity.sessionId)?.['expiresAt']).toBe(longerExpiresAt);
    expect(client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt']).toBe(longerExpiresAt);
    expect(client.firstVoteRow(identity.sessionId)?.['expiresAt']).toBe(longerExpiresAt);
    expect(client.sessionRow(`FINALIZATION#${identity.sessionId}#longer-artifact-ttl`)?.['expiresAt']).toBe(
      longerExpiresAt,
    );
  });

  it('retries a live touch that races finalization and preserves the promoted artifact TTL', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    client.runBeforeNextTransactWrite(async () => {
      await store.commitSuccessfulFinalization({
        record: buildSucceededRecord(identity.sessionId, 'artifact-ttl-race'),
        bitmap: { availability: 'unavailable' },
      });
    });

    await store.touchSession(identity.sessionId);

    const artifactExpiresAt = client.sessionRow(`FINALIZATION#${identity.sessionId}#artifact-ttl-race`)?.['expiresAt'];
    expect(client.sessionRow(identity.sessionId)?.['expiresAt']).toBe(artifactExpiresAt);
    expect(client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt']).toBe(artifactExpiresAt);
    expect(client.firstVoteRow(identity.sessionId)?.['expiresAt']).toBe(artifactExpiresAt);
    expect(client.sessionRow(`FINALIZATION#${identity.sessionId}#artifact-ttl-race`)?.['expiresAt']).toBe(
      artifactExpiresAt,
    );
  });

  it('admits the configured 64-vote maximum below the DynamoDB transaction item limit', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    await store.addBotVotes(
      identity.sessionId,
      Array.from({ length: 63 }, (_, index) => buildIndexedBotVote(index + 1)),
    );

    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(identity.sessionId, 'maximum-session-transaction'),
      bitmap: { availability: 'unavailable' },
    });

    expect(client.lastTransactWriteItemCount).toBeLessThanOrEqual(100);
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toMatchObject({
      finalizationId: 'maximum-session-transaction',
    });
  });

  it.each(['expired', 'missing'] as const)(
    'does not revive an %s vote row or partially update the remaining session TTL authority',
    async (rowState) => {
      const store = createStore(client);
      const identity = await store.createSession();
      await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
      const identityExpiresAt = client.sessionRow(identity.sessionId)?.['expiresAt'];
      const votingExpiresAt = client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt'];
      if (rowState === 'expired') {
        client.mutateVoteRow(identity.sessionId, 0, (row) => {
          row['expiresAt'] = Math.floor(Date.now() / 1000) - 1;
        });
      } else {
        client.deleteVoteRow(identity.sessionId, 0);
      }

      await expect(store.touchSession(identity.sessionId)).rejects.toThrow();

      expect(client.sessionRow(identity.sessionId)?.['expiresAt']).toBe(identityExpiresAt);
      expect(client.sessionRow(`VOTING#${identity.sessionId}`)?.['expiresAt']).toBe(votingExpiresAt);
      if (rowState === 'expired') {
        expect(client.firstVoteRow(identity.sessionId)?.['expiresAt']).toBeLessThan(Math.floor(Date.now() / 1000));
      } else {
        expect(client.firstVoteRow(identity.sessionId)).toBeUndefined();
      }
    },
  );

  it('rejects an oversized TTL transaction before sending it to DynamoDB', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    const rows = client.votes.get(identity.sessionId);
    const first = rows?.get(0);
    if (!rows || !first) {
      throw new Error('Expected first vote row');
    }
    for (let voteIndex = 1; voteIndex < 100; voteIndex += 1) {
      rows.set(voteIndex, { ...structuredClone(first), voteIndex });
    }
    client.mutateSessionRow(`VOTING#${identity.sessionId}`, (row) => {
      const record = row['record'] as Record<string, unknown>;
      record['bulletinRootHistory'] = Array.from({ length: 100 }, (_, index) => ({
        timestamp: index + 1,
        root: first['rootAtCast'],
        treeSize: index + 1,
      }));
    });
    const callsBefore = client.transactWriteCalls;

    await expect(store.touchSession(identity.sessionId)).rejects.toThrow('DynamoDB transaction item limit exceeded');

    expect(client.transactWriteCalls).toBe(callsBefore);
  });

  it('preserves voting authority across delivery metadata writes', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const voteId = generateVoteId();
    await store.addVote(identity.sessionId, buildVote(voteId, 'A', 'a'));
    await store.recordAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('metadata-only'), {
      s3ReportKey: 'reports/report.json',
      verificationWorkQueuedAtMs: 50,
    });
    await expect(store.getVoteById(identity.sessionId, voteId)).resolves.toMatchObject({
      voteData: { voteId },
    });
  });

  it('preserves finalization authority across verification-result writes', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const finalization = await finalizeSucceeded(store, identity.sessionId, 'verification-separate');
    await store.markVerificationRunning(identity.sessionId, asFinalizationId('verification-separate'));
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(finalization);
  });

  it('does not rewrite a committed running result when its activity touch loses a CAS race', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'running-touch-race');
    const conditionalFailure = new Error('ConditionalCheckFailedException');
    conditionalFailure.name = 'ConditionalCheckFailedException';
    client.failNextPut(conditionalFailure);

    await expect(
      store.markVerificationRunning(identity.sessionId, asFinalizationId('running-touch-race')),
    ).resolves.toMatchObject({ verificationResult: { status: 'running' } });

    expect(client.sessionRow(`VERIFICATION#${identity.sessionId}#running-touch-race`)).toMatchObject({ revision: 1 });
  });

  it('returns a committed terminal result when its activity touch fails', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'completion-touch-error');
    await store.markVerificationRunning(identity.sessionId, asFinalizationId('completion-touch-error'));
    client.failNextPut(new Error('simulated activity failure'));

    await expect(
      store.completeVerificationResult(identity.sessionId, asFinalizationId('completion-touch-error'), {
        status: 'failed',
        failureCategory: 'unknown',
      }),
    ).resolves.toMatchObject({ verificationResult: { status: 'failed' } });
    await expect(
      store.getVerificationResultRecord(identity.sessionId, asFinalizationId('completion-touch-error')),
    ).resolves.toMatchObject({ verificationResult: { status: 'failed' } });
  });

  it('retains verification delivery metadata when completion persistence fails and is retried', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'verification-retry');
    await store.recordAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('verification-retry'), {
      s3ReportKey: 'reports/retry.json',
      verificationWorkQueuedAtMs: 40,
    });
    await store.markVerificationRunning(identity.sessionId, asFinalizationId('verification-retry'));
    client.failNextTransactWrite();
    await expect(
      store.completeVerificationResult(identity.sessionId, asFinalizationId('verification-retry'), {
        status: 'failed',
        failureCategory: 'unknown',
      }),
    ).rejects.toThrow();
    await expect(
      store.getAwsVerificationDeliveryMetadata(identity.sessionId, asFinalizationId('verification-retry')),
    ).resolves.toEqual({
      s3ReportKey: 'reports/retry.json',
      verificationWorkQueuedAtMs: 40,
    });
  });

  it('retains the verification rollback snapshot when rollback persistence fails and is retried', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'rollback-retry');
    await store.markVerificationRunning(identity.sessionId, asFinalizationId('rollback-retry'));
    client.failNextTransactWrite();
    await expect(
      store.rollbackVerificationResult(identity.sessionId, asFinalizationId('rollback-retry')),
    ).rejects.toThrow();
    await expect(
      store.getVerificationResultRecord(identity.sessionId, asFinalizationId('rollback-retry')),
    ).resolves.toMatchObject({ verificationResult: { status: 'running' } });
    await store.rollbackVerificationResult(identity.sessionId, asFinalizationId('rollback-retry'));
    await expect(
      store.getVerificationResultRecord(identity.sessionId, asFinalizationId('rollback-retry')),
    ).resolves.toBeNull();
  });

  it('returns after a committed verification rollback when its activity touch fails', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'rollback-touch-error');
    await store.markVerificationRunning(identity.sessionId, asFinalizationId('rollback-touch-error'));
    client.failNextPut(new Error('simulated activity failure'));

    await expect(
      store.rollbackVerificationResult(identity.sessionId, asFinalizationId('rollback-touch-error')),
    ).resolves.toBeUndefined();
    await expect(
      store.getVerificationResultRecord(identity.sessionId, asFinalizationId('rollback-touch-error')),
    ).resolves.toBeNull();
    expect(client.sessionRow(`VERIFICATION_ROLLBACK#${identity.sessionId}#rollback-touch-error`)).toBeUndefined();
  });

  it('does not replace the verification rollback snapshot before a repeated running state is durable', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'rollback-stable');
    await store.markVerificationRunning(identity.sessionId, asFinalizationId('rollback-stable'));
    await store.markVerificationRunning(identity.sessionId, asFinalizationId('rollback-stable'));
    await store.rollbackVerificationResult(identity.sessionId, asFinalizationId('rollback-stable'));
    await expect(
      store.getVerificationResultRecord(identity.sessionId, asFinalizationId('rollback-stable')),
    ).resolves.toBeNull();
  });

  it('rejects stale vote writes after a concurrent voting revision without desynchronizing CT authority', async () => {
    const first = createStore(client);
    const second = createStore(client);
    const identity = await first.createSession();
    const results = await Promise.allSettled([
      first.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a')),
      second.addVote(identity.sessionId, buildVote(generateVoteId(), 'B', 'b')),
    ]);
    const outcomes = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    expect(outcomes).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([{ ok: false, error: { code: 'ALREADY_VOTED' } }]);
    expect((await first.getVotingRecord(identity.sessionId))?.votes.size).toBe(1);
  });

  it('rejects stale bot-vote persistence without overwriting finalization authority', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    const finalization = await finalizeSucceeded(store, identity.sessionId, 'bot-blocked');
    await expect(store.addBotVotes(identity.sessionId, [buildBotVote('b')])).resolves.toEqual({
      ok: false,
      error: { code: 'SESSION_FINALIZED' },
    });
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(finalization);
  });

  it('rejects stale user-vote persistence without overwriting finalization authority', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const finalization = await finalizeSucceeded(store, identity.sessionId, 'vote-blocked');
    await expect(store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'))).resolves.toEqual({
      ok: false,
      error: { code: 'SESSION_FINALIZED' },
    });
    await expect(store.getCurrentFinalizationRecord(identity.sessionId)).resolves.toEqual(finalization);
  });

  it('counts only active recoverable DynamoDB identity/voting pairs', async () => {
    const store = createStore(client);
    const active = await store.createSession();
    const expired = await store.createSession();
    client.expireRow(expired.sessionId);
    client.sessions.set('unrelated', { sessionId: 'unrelated', itemType: 'OTHER' });
    await expect(store.getActiveSessionCount()).resolves.toBe(1);
    expect(await store.getSessionIdentity(active.sessionId)).not.toBeNull();
  });

  it('fails closed when DynamoDB vote indices are sparse during CT restore', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    await store.addBotVotes(identity.sessionId, [buildBotVote('b')]);
    client.deleteVoteRow(identity.sessionId, 0);
    await expect(store.getVotingRecord(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it.each([
    ['malformed encrypted vote', (row: Record<string, unknown>) => (row['vote'] = 'invalid')],
    ['malformed encrypted rand', (row: Record<string, unknown>) => (row['rand'] = 'invalid')],
    [
      'auth-tag decrypt failure',
      (row: Record<string, unknown>) => {
        const value = String(row['vote']);
        row['vote'] = `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
      },
    ],
    [
      'invalid decrypted random hex',
      (row: Record<string, unknown>) => {
        row['rand'] = encryptVoteSecret('not-hex');
      },
    ],
  ])('fails closed when a DynamoDB vote row has %s', async (_label, mutate) => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    client.mutateVoteRow(identity.sessionId, 0, mutate);
    await expect(store.getVotingRecord(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when DynamoDB vote indices are duplicated during CT restore', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    client.duplicateVoteRow(identity.sessionId, 0);
    await expect(store.getVotingRecord(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when a DynamoDB vote row is missing rootAtCast', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    client.mutateVoteRow(identity.sessionId, 0, (row) => {
      delete row['rootAtCast'];
    });
    await expect(store.getVotingRecord(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when a DynamoDB vote row rootAtCast differs from the reconstructed CT root', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    client.mutateVoteRow(identity.sessionId, 0, (row) => {
      row['rootAtCast'] = `0x${'f'.repeat(64)}`;
    });
    await expect(store.getVotingRecord(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when persisted DynamoDB root history differs from reconstructed CT state', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    client.mutateSessionRow(`VOTING#${identity.sessionId}`, (row) => {
      const record = row['record'] as { bulletinRootHistory: Array<{ root: string }> };
      const firstSnapshot = record.bulletinRootHistory[0];
      if (!firstSnapshot) {
        throw new Error('Expected persisted bulletin root snapshot');
      }
      firstSnapshot.root = `0x${'f'.repeat(64)}`;
    });
    await expect(store.getVotingRecord(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('fails closed when finalized DynamoDB bulletin authority differs from restored CT state', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    await finalizeSucceeded(
      store,
      identity.sessionId,
      'wrong-journal-root',
      buildFinalizationResult({
        ...createTestJournal({ totalExpected: 1, validVotes: 1 }),
        bulletinRoot: `0x${'f'.repeat(64)}`,
      }),
    );
    await expect(store.getVotingRecord(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('does not expose sessionless vote proof lookup as target acceptance evidence', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const voteId = generateVoteId();
    await store.addVote(identity.sessionId, buildVote(voteId, 'A', 'a'));
    await expect(store.getVoteProof(voteId)).resolves.toBeNull();
  });

  it('keeps session summaries free of raw vote openings and private sidecars', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    const summary = await store.getSessionVotingSummary(identity.sessionId);
    expect(summary).toEqual({
      sessionId: identity.sessionId,
      botCount: 0,
      userParticipation: { status: 'cast', voteIndex: 0 },
    });
    expect(summary).not.toHaveProperty('votes');
    expect(summary).not.toHaveProperty('finalizationResult');
  });

  it('fails closed rather than repairing stale persisted voting metadata from vote rows', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await store.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a'));
    client.mutateSessionRow(`VOTING#${identity.sessionId}`, (row) => {
      (row['record'] as { botCount: number }).botCount = 10;
    });
    await expect(store.getSessionVotingSummary(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
  });

  it('rejects stale concurrent user-vote persistence with a DynamoDB condition', async () => {
    const first = createStore(client);
    const second = createStore(client);
    const identity = await first.createSession();
    const results = await Promise.allSettled([
      first.addVote(identity.sessionId, buildVote(generateVoteId(), 'A', 'a')),
      second.addVote(identity.sessionId, buildVote(generateVoteId(), 'B', 'b')),
    ]);
    const outcomes = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([{ ok: false, error: { code: 'ALREADY_VOTED' } }]);
    expect(client.votes.get(identity.sessionId)?.size).toBe(1);
  });

  it.each([
    ['commitment', (row: Record<string, unknown>) => (row['commit'] = `0x${'f'.repeat(64)}`)],
    ['vote opening', (row: Record<string, unknown>) => (row['vote'] = encryptVoteSecret('B'))],
    ['random opening', (row: Record<string, unknown>) => (row['rand'] = encryptVoteSecret(`0x${'f'.repeat(64)}`))],
    ['timestamp', (row: Record<string, unknown>) => (row['timestamp'] = 1)],
    ['CT root', (row: Record<string, unknown>) => (row['rootAtCast'] = `0x${'f'.repeat(64)}`)],
  ])('does not repair a concurrently mutated same-voteId %s', async (_label, mutate) => {
    const store = createStore(client);
    const identity = await store.createSession();
    const voteId = generateVoteId();
    await store.addVote(identity.sessionId, buildVote(voteId, 'A', 'a'));
    client.mutateVoteRow(identity.sessionId, 0, mutate);
    const persisted = client.firstVoteRow(identity.sessionId);
    await expect(store.getVotingRecord(identity.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');
    expect(client.firstVoteRow(identity.sessionId)).toEqual(persisted);
  });

  it('persists encrypted vote openings while restoring domain vote data', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const voteId = generateVoteId();
    await store.addVote(identity.sessionId, buildVote(voteId, 'A', 'a'));
    const row = client.firstVoteRow(identity.sessionId);
    expect(row?.['vote']).toMatch(/^enc:v1:/);
    expect(row?.['rand']).toMatch(/^enc:v1:/);
    await expect(store.getVoteById(identity.sessionId, voteId)).resolves.toMatchObject({
      voteData: { vote: 'A', rand: `0x${'a'.repeat(64)}` },
    });
  });

  it('keeps heavyweight finalization payloads out of identity and voting rows', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    await finalizeSucceeded(store, identity.sessionId, 'heavy-finalization');
    const identityRow = client.sessionRow(identity.sessionId);
    const votingRow = client.sessionRow(`VOTING#${identity.sessionId}`);
    const finalizationRow = client.sessionRow(`FINALIZATION#${identity.sessionId}#heavy-finalization`);
    expect(identityRow).not.toHaveProperty('finalizationResult');
    expect(votingRow).not.toHaveProperty('finalizationResult');
    expect(finalizationRow).toHaveProperty('record.finalizationResult.journal');
  });

  it('saves and reads bitmap sidecars only for exact succeeded finalization authority', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const includedBitmap = [true];
    const seenBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
    const journal = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
        seenIndicesCount: 1,
      }),
      includedBitmapRoot,
      seenBitmapRoot,
    };
    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(identity.sessionId, 'bitmap', buildFinalizationResult(journal)),
      bitmap: {
        availability: 'available',
        data: { includedBitmap, includedBitmapRoot, seenBitmap, seenBitmapRoot, treeSize: 1, finalizedAtMs: 40 },
      },
    });
    await expect(store.getBitmapData(identity.sessionId, asFinalizationId('bitmap'))).resolves.toEqual({
      sessionId: identity.sessionId,
      finalizationId: 'bitmap',
      includedBitmap,
      includedBitmapRoot,
      seenBitmap,
      seenBitmapRoot,
      treeSize: 1,
      finalizedAtMs: 40,
    });
    await expect(store.getBitmapData(identity.sessionId, asFinalizationId('stale-bitmap'))).resolves.toBeNull();
  });

  it('commits bitmap sidecar without a fallible post-terminal activity touch', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const journal = {
      ...createTestJournal({ totalExpected: 1, validVotes: 1, seenIndicesCount: 1 }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    };
    const touchSession = vi.spyOn(store, 'touchSession').mockRejectedValueOnce(new Error('simulated activity failure'));

    await expect(
      store.commitSuccessfulFinalization({
        record: buildSucceededRecord(identity.sessionId, 'bitmap-touch-error', buildFinalizationResult(journal)),
        bitmap: {
          availability: 'available',
          data: { includedBitmap, includedBitmapRoot, treeSize: 1, finalizedAtMs: 40 },
        },
      }),
    ).resolves.toMatchObject({ bitmap: { availability: 'available' } });
    expect(touchSession).not.toHaveBeenCalled();
    await expect(
      store.getBitmapData(identity.sessionId, asFinalizationId('bitmap-touch-error')),
    ).resolves.toMatchObject({
      finalizationId: 'bitmap-touch-error',
      includedBitmap,
      includedBitmapRoot,
    });
  });

  it.each([
    [
      'included root mismatch',
      (bitmap: Record<string, unknown>) => {
        bitmap['includedBitmapRoot'] = `0x${'f'.repeat(64)}`;
      },
    ],
    [
      'seen root mismatch',
      (bitmap: Record<string, unknown>) => {
        bitmap['seenBitmapRoot'] = `0x${'f'.repeat(64)}`;
      },
    ],
    [
      'seen bitmap without its root',
      (bitmap: Record<string, unknown>) => {
        delete bitmap['seenBitmapRoot'];
      },
    ],
    [
      'seen bitmap root without its bitmap',
      (bitmap: Record<string, unknown>) => {
        delete bitmap['seenBitmap'];
      },
    ],
    [
      'tree size mismatch',
      (bitmap: Record<string, unknown>) => {
        bitmap['treeSize'] = 2;
      },
    ],
    [
      'included bits mismatch',
      (bitmap: Record<string, unknown>) => {
        bitmap['includedBitmap'] = [false];
      },
    ],
  ])('rejects corrupted bitmap sidecar evidence for %s', async (_label, mutate) => {
    const store = createStore(client);
    const identity = await store.createSession();
    const includedBitmap = [true];
    const seenBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
    const journal = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
        seenIndicesCount: 1,
      }),
      includedBitmapRoot,
      seenBitmapRoot,
    };
    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(identity.sessionId, 'bitmap-corrupt', buildFinalizationResult(journal)),
      bitmap: {
        availability: 'available',
        data: { includedBitmap, includedBitmapRoot, seenBitmap, seenBitmapRoot, treeSize: 1, finalizedAtMs: 40 },
      },
    });
    client.mutateSessionRow(`BITMAP#${identity.sessionId}#bitmap-corrupt`, (row) => {
      mutate(row['bitmap'] as Record<string, unknown>);
    });
    await expect(store.getBitmapData(identity.sessionId, asFinalizationId('bitmap-corrupt'))).resolves.toBeNull();
  });

  it('treats expired identity and bitmap sidecars as absent before DynamoDB TTL deletion', async () => {
    const store = createStore(client);
    const identity = await store.createSession();
    client.expireRow(identity.sessionId);
    await expect(store.getSessionIdentity(identity.sessionId)).resolves.toBeNull();

    const second = await store.createSession();
    const includedBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const journal = {
      ...createTestJournal({
        totalExpected: 1,
        validVotes: 1,
      }),
      includedBitmapRoot,
      seenBitmapRoot: includedBitmapRoot,
    };
    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(second.sessionId, 'bitmap-expired', buildFinalizationResult(journal)),
      bitmap: {
        availability: 'available',
        data: { includedBitmap, includedBitmapRoot, treeSize: 1, finalizedAtMs: 40 },
      },
    });
    client.expireRow(`BITMAP#${second.sessionId}#bitmap-expired`);
    await expect(store.getBitmapData(second.sessionId, asFinalizationId('bitmap-expired'))).resolves.toBeNull();
  });
});

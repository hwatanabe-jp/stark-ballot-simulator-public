import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand as BaseQueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedTestContainer } from 'testcontainers';
import { DynamoRateLimitStore } from '@stark-ballot/aws-adapters/rate-limit/dynamoRateLimitStore';
import { DynamoSessionStore } from '@stark-ballot/aws-adapters/store/dynamoSessionStore';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';
import type { BotVoteCommand, UserVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationResultAuthority,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { defineSessionStoreContract } from './test-support/sessionStoreContract';

// Keep Docker-backed evidence opt-in so default Vitest runs never pull images implicitly.
const shouldRunDynamoDbLocalTests = process.env['RUN_DYNAMODB_LOCAL_TESTS'] === '1';
const VALID_VOTE_SECRET_ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const VoteChoice = {
  A: 'A' as const,
  B: 'B' as const,
};

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

function buildVote(voteId: string, vote: 'A' | 'B', randNibble: string): UserVoteCommand {
  return {
    voteId,
    vote,
    rand: `0x${randNibble.repeat(64)}`,
    timestamp: Date.now(),
  };
}

function buildBotVote(vote: 'A' | 'B', randNibble: string): BotVoteCommand {
  return {
    vote,
    rand: `0x${randNibble.repeat(64)}`,
  };
}

function buildFinalizationResult(journal = createTestJournal()): FinalizationResultAuthority {
  return buildFinalizationResultFromJournal({
    journal,
    imageId: `0x${'1'.repeat(64)}`,
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
      queuedAtMs: 1,
      startedAtMs: 2,
      completedAtMs: 3,
    },
    finalizationResult: {
      finalizationId: admittedFinalizationId,
      ...result,
    },
  };
}

function getReceiptPublication(record: FinalizationRecord | null | undefined) {
  const state = record?.finalizationResult?.artifacts.receiptPublication;
  return state?.availability === 'available' ? state.publication : undefined;
}

async function createSessionsTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: 'sessionId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}

async function createVotesTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'sessionId', AttributeType: 'S' },
        { AttributeName: 'voteIndex', AttributeType: 'N' },
        { AttributeName: 'voteId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'sessionId', KeyType: 'HASH' },
        { AttributeName: 'voteIndex', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'voteId-index',
          KeySchema: [{ AttributeName: 'voteId', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}

async function createRateLimitEventsTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'scope', AttributeType: 'S' },
        { AttributeName: 'eventKey', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'scope', KeyType: 'HASH' },
        { AttributeName: 'eventKey', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}

async function createRateLimitCountersTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: 'key', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'key', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
}

describe.skipIf(!shouldRunDynamoDbLocalTests)('DynamoSessionStore DynamoDB Local semantic evidence', () => {
  let container: StartedTestContainer;
  let client: DynamoDBClient;
  let documentClient: DynamoDBDocumentClient;
  let sessionsTableName: string;
  let votesTableName: string;
  let eventsTableName: string;
  let countersTableName: string;

  beforeAll(async () => {
    const { GenericContainer, Wait } = await import('testcontainers');
    container = await new GenericContainer('amazon/dynamodb-local:2.6.1')
      .withCommand(['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'])
      .withExposedPorts(8000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    client = new DynamoDBClient({
      endpoint: `http://${container.getHost()}:${container.getMappedPort(8000)}`,
      region: 'local',
      credentials: {
        accessKeyId: 'local',
        secretAccessKey: 'local',
      },
    });
    documentClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionsTableName = `sessions-${suffix}`;
    votesTableName = `votes-${suffix}`;
    eventsTableName = `rate-events-${suffix}`;
    countersTableName = `rate-counters-${suffix}`;

    await createSessionsTable(client, sessionsTableName);
    await createVotesTable(client, votesTableName);
    await createRateLimitEventsTable(client, eventsTableName);
    await createRateLimitCountersTable(client, countersTableName);
  }, 120_000);

  afterAll(async () => {
    client.destroy();
    await container.stop();
  });

  beforeEach(async () => {
    process.env['SESSION_LIVE_TTL_SECONDS'] = '300';
    process.env['VERIFICATION_ARTIFACT_TTL_SECONDS'] = '7200';
    process.env['VOTE_SECRET_ENCRYPTION_KEY'] = VALID_VOTE_SECRET_ENCRYPTION_KEY;
    await documentClient.send(
      new DeleteCommand({
        TableName: sessionsTableName,
        Key: { sessionId: 'RECEIPT_BOARD_COUNTER' },
      }),
    );
  });

  function createStore(): DynamoSessionStore {
    return new DynamoSessionStore({
      sessionsTableName,
      votesTableName,
      documentClient,
    });
  }

  defineSessionStoreContract({
    name: 'DynamoSessionStore DynamoDB Local',
    capabilities: {
      durableReload: true,
    },
    createHarness: () =>
      Promise.resolve({
        store: createStore(),
        reload: () => Promise.resolve(createStore()),
      }),
  });

  it('persists and queries session-scoped votes through DynamoDB-compatible tables and GSI', async () => {
    const store = createStore();
    const session = await store.createSession();
    const userVoteId = generateVoteId();

    const castResult = await store.addVote(session.sessionId, buildVote(userVoteId, VoteChoice.A, 'a'));
    if (!castResult.ok) {
      throw new Error(`Expected vote persistence, received ${castResult.error.code}`);
    }
    await expect(store.addBotVotes(session.sessionId, [buildBotVote(VoteChoice.B, 'b')])).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    const reader = createStore();
    const proof = await reader.getVoteByIdWithProof(session.sessionId, userVoteId);
    expect(proof?.leafIndex).toBe(0);
    expect(proof?.bulletinRootAtCast).toBe(castResult.value.bulletinRootAtCast);

    const sessionVotes = await documentClient.send(
      new QueryCommand({
        TableName: votesTableName,
        KeyConditionExpression: '#sessionId = :sessionId',
        ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        ExpressionAttributeValues: { ':sessionId': session.sessionId },
        ConsistentRead: true,
      }),
    );
    expect(sessionVotes.Items).toHaveLength(2);
    expect(sessionVotes.Items?.[0]?.['vote']).toMatch(/^enc:v1:/);
    expect(sessionVotes.Items?.[0]?.['rand']).toMatch(/^enc:v1:/);

    const voteIdIndexRows = await client.send(
      new BaseQueryCommand({
        TableName: votesTableName,
        IndexName: 'voteId-index',
        KeyConditionExpression: '#voteId = :voteId',
        ExpressionAttributeNames: { '#voteId': 'voteId' },
        ExpressionAttributeValues: { ':voteId': { S: userVoteId } },
      }),
    );
    expect(voteIdIndexRows.Items).toHaveLength(1);
    expect(voteIdIndexRows.Items?.[0]?.['sessionId']?.S).toBe(session.sessionId);
  });

  it('uses conditional writes to return one conflict for concurrent user-vote persistence', async () => {
    const firstWriter = createStore();
    const secondWriter = createStore();
    const session = await firstWriter.createSession();

    const results = await Promise.allSettled([
      firstWriter.addVote(session.sessionId, buildVote(generateVoteId(), VoteChoice.A, '1')),
      secondWriter.addVote(session.sessionId, buildVote(generateVoteId(), VoteChoice.B, '2')),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const outcomes = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([{ ok: false, error: { code: 'ALREADY_VOTED' } }]);

    const votes = await documentClient.send(
      new QueryCommand({
        TableName: votesTableName,
        KeyConditionExpression: '#sessionId = :sessionId',
        ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        ExpressionAttributeValues: { ':sessionId': session.sessionId },
        ConsistentRead: true,
      }),
    );
    expect(votes.Items).toHaveLength(1);
  });

  it('does not overwrite an existing same-voteId vote row after concurrent authority mutation', async () => {
    const seedStore = createStore();
    const session = await seedStore.createSession();
    const voteId = generateVoteId();
    await seedStore.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, '3'));

    await documentClient.send(
      new UpdateCommand({
        TableName: votesTableName,
        Key: { sessionId: session.sessionId, voteIndex: 0 },
        UpdateExpression: 'SET #commit = :commit',
        ExpressionAttributeNames: { '#commit': 'commit' },
        ExpressionAttributeValues: { ':commit': `0x${'f'.repeat(64)}` },
      }),
    );

    await expect(createStore().getVotingRecord(session.sessionId)).rejects.toThrow('CT_PROOF_UNAVAILABLE');

    const voteRow = await documentClient.send(
      new GetCommand({
        TableName: votesTableName,
        Key: { sessionId: session.sessionId, voteIndex: 0 },
        ConsistentRead: true,
      }),
    );
    expect(voteRow.Item?.['voteId']).toBe(voteId);
    expect(voteRow.Item?.['commit']).toBe(`0x${'f'.repeat(64)}`);

    const sessionRow = await documentClient.send(
      new GetCommand({
        TableName: sessionsTableName,
        Key: { sessionId: session.sessionId },
        ConsistentRead: true,
      }),
    );
    expect(sessionRow.Item?.['identity']).toMatchObject({ electionId: session.electionId });
  });

  it('saves and validates bitmap sidecars through DynamoDB-compatible reads', async () => {
    const store = createStore();
    const session = await store.createSession();
    await store.addVote(session.sessionId, buildVote(generateVoteId(), VoteChoice.A, 'a'));
    const votedSession = await store.getVotingRecord(session.sessionId);
    const bulletinRoot = votedSession?.bulletinRootHistory.at(-1)?.root;
    if (!bulletinRoot) {
      throw new Error('Expected bulletin root after vote');
    }
    const includedBitmap = [true];
    const seenBitmap = [true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
    const journal = {
      ...createTestJournal({ totalExpected: 1, validVotes: 1, seenIndicesCount: 1 }),
      bulletinRoot,
      includedBitmapRoot,
      seenBitmapRoot,
    };

    await store.commitSuccessfulFinalization({
      record: buildSucceededRecord(session.sessionId, 'exec-bitmap-local', buildFinalizationResult(journal)),
      bitmap: {
        availability: 'available',
        data: { includedBitmap, includedBitmapRoot, seenBitmap, seenBitmapRoot, treeSize: 1, finalizedAtMs: 123 },
      },
    });

    await expect(store.getBitmapData(session.sessionId, asFinalizationId('exec-bitmap-local'))).resolves.toEqual({
      sessionId: session.sessionId,
      finalizationId: 'exec-bitmap-local',
      includedBitmap,
      includedBitmapRoot,
      seenBitmap,
      seenBitmapRoot,
      treeSize: 1,
      finalizedAtMs: 123,
    });

    await documentClient.send(
      new UpdateCommand({
        TableName: sessionsTableName,
        Key: { sessionId: `BITMAP#${session.sessionId}#exec-bitmap-local` },
        UpdateExpression: 'SET bitmap.includedBitmapRoot = :root',
        ExpressionAttributeValues: {
          ':root': `0x${'f'.repeat(64)}`,
        },
      }),
    );

    await expect(store.getBitmapData(session.sessionId, asFinalizationId('exec-bitmap-local'))).resolves.toBeNull();
  });

  it('publishes one receipt sidecar for competing atomic finalizations without advancing stale board indices', async () => {
    const firstWriter = createStore();
    const secondWriter = createStore();
    const session = await firstWriter.createSession();

    const results = await Promise.allSettled([
      firstWriter.commitSuccessfulFinalization({
        record: buildSucceededRecord(session.sessionId, 'exec-local-first'),
        receipt: { receipt: '{"receipt":"first"}', timestamp: 1001 },
        bitmap: { availability: 'unavailable' },
      }),
      secondWriter.commitSuccessfulFinalization({
        record: buildSucceededRecord(session.sessionId, 'exec-local-second'),
        receipt: { receipt: '{"receipt":"second"}', timestamp: 1002 },
        bitmap: { availability: 'unavailable' },
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const persisted = await createStore().getCurrentFinalizationRecord(session.sessionId);
    expect(persisted?.state.status).toBe('succeeded');
    expect(getReceiptPublication(persisted)).toMatchObject({ boardIndex: 100 });

    const counterRow = await documentClient.send(
      new GetCommand({
        TableName: sessionsTableName,
        Key: { sessionId: 'RECEIPT_BOARD_COUNTER' },
        ConsistentRead: true,
      }),
    );
    expect(counterRow.Item?.['nextBoardIndex']).toBe(101);

    const receiptRow = await documentClient.send(
      new GetCommand({
        TableName: sessionsTableName,
        Key: { sessionId: `RECEIPT#${session.sessionId}#${persisted?.finalizationId}` },
        ConsistentRead: true,
      }),
    );
    expect(receiptRow.Item).toMatchObject({
      boardIndex: 100,
      receiptHash: getReceiptPublication(persisted)?.receiptHash,
    });
  });

  it('publishes distinct receipt-board indices for concurrent finalizations in different sessions', async () => {
    const firstWriter = createStore();
    const secondWriter = createStore();
    const firstSession = await firstWriter.createSession();
    const secondSession = await secondWriter.createSession();

    const results = await Promise.allSettled([
      firstWriter.commitSuccessfulFinalization({
        record: buildSucceededRecord(firstSession.sessionId, 'exec-local-cross-session-first'),
        receipt: { receipt: '{"receipt":"cross-session-first"}', timestamp: 2001 },
        bitmap: { availability: 'unavailable' },
      }),
      secondWriter.commitSuccessfulFinalization({
        record: buildSucceededRecord(secondSession.sessionId, 'exec-local-cross-session-second'),
        receipt: { receipt: '{"receipt":"cross-session-second"}', timestamp: 2002 },
        bitmap: { availability: 'unavailable' },
      }),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const publications = results.map((result) => {
      if (result.status !== 'fulfilled') {
        throw result.reason;
      }
      return result.value;
    });
    expect(new Set(publications.map((publication) => publication.receiptPublication?.boardIndex)).size).toBe(2);

    const firstPersisted = await createStore().getCurrentFinalizationRecord(firstSession.sessionId);
    const secondPersisted = await createStore().getCurrentFinalizationRecord(secondSession.sessionId);
    const persistedBoardIndices = [
      getReceiptPublication(firstPersisted)?.boardIndex,
      getReceiptPublication(secondPersisted)?.boardIndex,
    ];
    expect(persistedBoardIndices).toEqual(
      expect.arrayContaining(publications.map((publication) => publication.receiptPublication?.boardIndex)),
    );

    const counterRow = await documentClient.send(
      new GetCommand({
        TableName: sessionsTableName,
        Key: { sessionId: 'RECEIPT_BOARD_COUNTER' },
        ConsistentRead: true,
      }),
    );
    expect(counterRow.Item?.['nextBoardIndex']).toBe(
      Math.max(...publications.map((publication) => publication.receiptPublication?.boardIndex ?? -1)) + 1,
    );
  });

  it('rolls back all writes when a DynamoDB transaction condition fails', async () => {
    const sessionId = `atomic-${generateVoteId()}`;

    await expect(
      documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: votesTableName,
                Item: {
                  sessionId,
                  voteIndex: 0,
                  voteId: generateVoteId(),
                  vote: 'enc:v1:placeholder',
                  rand: 'enc:v1:placeholder',
                  commit: `0x${'1'.repeat(64)}`,
                  rootAtCast: `0x${'2'.repeat(64)}`,
                  isUserVote: true,
                  expiresAt: Math.floor(Date.now() / 1000) + 300,
                },
                ConditionExpression: 'attribute_not_exists(#sessionId)',
                ExpressionAttributeNames: { '#sessionId': 'sessionId' },
              },
            },
            {
              Put: {
                TableName: sessionsTableName,
                Item: {
                  sessionId,
                  itemType: 'SESSION',
                  session: {},
                  expiresAt: Math.floor(Date.now() / 1000) + 300,
                },
                ConditionExpression: 'attribute_exists(#sessionId)',
                ExpressionAttributeNames: { '#sessionId': 'sessionId' },
              },
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(Error);

    const voteRows = await documentClient.send(
      new QueryCommand({
        TableName: votesTableName,
        KeyConditionExpression: '#sessionId = :sessionId',
        ExpressionAttributeNames: { '#sessionId': 'sessionId' },
        ExpressionAttributeValues: { ':sessionId': sessionId },
        ConsistentRead: true,
      }),
    );
    const sessionRow = await client.send(
      new GetItemCommand({
        TableName: sessionsTableName,
        Key: { sessionId: { S: sessionId } },
        ConsistentRead: true,
      }),
    );
    expect(voteRows.Items).toHaveLength(0);
    expect(sessionRow.Item).toBeUndefined();
  });

  it('treats expired session rows as inaccessible before DynamoDB TTL deletion', async () => {
    const store = createStore();
    const session = await store.createSession();
    const voteId = generateVoteId();
    await store.addVote(session.sessionId, buildVote(voteId, VoteChoice.A, 'f'));

    await documentClient.send(
      new UpdateCommand({
        TableName: sessionsTableName,
        Key: { sessionId: session.sessionId },
        UpdateExpression: 'SET expiresAt = :expired',
        ExpressionAttributeValues: {
          ':expired': Math.floor(Date.now() / 1000) - 1,
        },
      }),
    );

    const reader = createStore();
    await expect(reader.getSessionIdentity(session.sessionId)).resolves.toBeNull();
    await expect(reader.getVoteById(session.sessionId, voteId)).resolves.toBeNull();
  });

  it('records, queries, and increments rate-limit table state through DynamoDB-compatible operations', async () => {
    const rateLimitStore = new DynamoRateLimitStore({
      eventsTableName,
      countersTableName,
      documentClient,
    });

    await rateLimitStore.recordEvent('vote:203.0.113.10', 1_700_000_000_123, 1_700_000_060_123);
    await rateLimitStore.recordEvent('vote:203.0.113.10', 1_700_000_000_123, 1_700_000_060_123);
    await rateLimitStore.recordEvent('vote:203.0.113.10', 1_700_000_000_500, 1_700_000_060_500);

    await expect(rateLimitStore.countEvents('vote:203.0.113.10', 1_700_000_000_122)).resolves.toBe(3);
    await expect(rateLimitStore.getOldestEventTimestamp('vote:203.0.113.10', 1_700_000_000_122)).resolves.toBe(
      1_700_000_000_123,
    );
    await expect(rateLimitStore.incrementCounter('zkvm:daily', 1_700_086_400_000)).resolves.toBe(1);
    await expect(rateLimitStore.incrementCounter('zkvm:daily', 1_700_086_400_000)).resolves.toBe(2);
    await expect(rateLimitStore.getCounter('zkvm:daily')).resolves.toBe(2);
  });
});

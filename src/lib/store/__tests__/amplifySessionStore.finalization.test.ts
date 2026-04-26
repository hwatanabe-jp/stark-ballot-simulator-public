import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encryptVoteSecret } from '@/lib/security/voteSecretCipher';
import type {
  FinalizationResult,
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
  SessionData,
} from '@/types/server';
import { resolveCurrentContractGeneration } from '@/lib/contract';
import { CURRENT_METHOD_VERSION, type ZkVMJournal } from '@/lib/zkvm/types';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { createTestJournal } from '@/lib/testing/test-helpers';

const TEST_IMAGE_ID = '0x' + '1'.repeat(64);

function createAuthoritativePublicInputArtifact(
  journal: Pick<
    ZkVMJournal,
    | 'electionId'
    | 'electionConfigHash'
    | 'methodVersion'
    | 'bulletinRoot'
    | 'treeSize'
    | 'totalExpected'
    | 'validVotes'
    | 'inputCommitment'
  >,
  overrides: Parameters<typeof createTestPublicInputArtifact>[0] = {},
) {
  return createTestPublicInputArtifact({
    ...overrides,
    typedAuthority: {
      electionId: journal.electionId,
      electionConfigHash: journal.electionConfigHash,
      methodVersion: journal.methodVersion,
      bulletinRoot: journal.bulletinRoot,
      treeSize: journal.treeSize,
      totalExpected: journal.totalExpected,
      votesCount: journal.validVotes,
      logId: '0x' + 'b'.repeat(64),
      timestamp: 123,
      recomputedInputCommitment: journal.inputCommitment,
      ...overrides.typedAuthority,
    },
  });
}

describe('AmplifySessionStore finalization serialization', () => {
  const originalEnv = process.env;
  let AmplifySessionStore: typeof import('../amplifySessionStore').AmplifySessionStore;

  type AmplifySessionRecord = {
    id: string;
    electionId: string;
    contractGeneration?: string | null;
    finalizationArtifactState?: string | null;
    electionConfigHash?: string | null;
    logId?: string | null;
    botCount?: number | null;
    finalized?: boolean | null;
    userVoteIndex?: number | null;
    ttl?: number | null;
    createdAt?: string | number | null;
    lastActivity?: string | number | null;
    finalizationResultJson?: unknown;
    bulletinRootHistoryJson?: unknown;
  };

  type AmplifyVoteRecord = {
    id: string;
    sessionId: string;
    voteIndex: number;
    choice: string;
    random: string;
    commitment: string;
    timestamp?: string | number | null;
    rootAtCast?: string | null;
    isUserVote?: boolean | null;
    path?: string[] | null;
  };

  const createTestStore = () => {
    class TestAmplifySessionStore extends AmplifySessionStore {
      public buildSessionDataForTest(session: AmplifySessionRecord, votes: AmplifyVoteRecord[]) {
        return this.buildSessionData(session, votes);
      }

      public serializeFinalizationPayloadForTest(
        result: FinalizationResultAuthority | FinalizationResult | null | undefined,
        state: FinalizationState | null | undefined,
        scenarioContext?: FinalizationScenarioContext | null,
        contractGeneration?: string,
      ) {
        return this.serializeFinalizationPayload(result, state, contractGeneration as string, scenarioContext);
      }
    }

    return new TestAmplifySessionStore();
  };

  const wrapFinalizationPayload = (payload: Record<string, unknown>): string =>
    JSON.stringify({
      contractGeneration: resolveCurrentContractGeneration(),
      ...payload,
    });

  const buildFinalizedSession = (now: number, finalized = true): SessionData => {
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
    });
    return {
      sessionId: 'session-finalized',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      logId: '0x' + 'b'.repeat(64),
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationContractGeneration: resolveCurrentContractGeneration(),
      votes: new Map(),
      bulletin: undefined,
      botCount: 0,
      finalized,
      createdAt: now,
      lastActivity: now,
      userVoteIndex: 0,
      bulletinRootHistory: [],
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: TEST_IMAGE_ID,
        journal,
        publicInputArtifact: createAuthoritativePublicInputArtifact(journal, {
          executionId: 'exec-1',
        }),
        verificationExecutionId: 'exec-1',
      },
    };
  };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql';
    process.env.AMPLIFY_DATA_TTL_SECONDS = '300';
    process.env.AMPLIFY_DATA_VERIFICATION_TTL_SECONDS = '7200';
    process.env.VOTE_SECRET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    ({ AmplifySessionStore } = await import('../amplifySessionStore'));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('serializes finalization result and state together when both provided', async () => {
    const store = createTestStore();
    const journal = {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      bulletinRoot: '0x' + 'b'.repeat(64),
      treeSize: 64,
      totalExpected: 64,
      sthDigest: '0x' + 'c'.repeat(64),
      verifiedTally: [32, 32, 0, 0, 0],
      totalVotes: 64,
      validVotes: 64,
      invalidVotes: 0,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      missingIndices: 0,
      invalidIndices: 0,
      countedIndices: 64,
      seenBitmapRoot: '0x' + 'd'.repeat(64),
      includedBitmapRoot: '0x' + 'e'.repeat(64),
      excludedSlots: 0,
      excludedCount: 0,
      inputCommitment: '0x' + 'f'.repeat(64),
      methodVersion: CURRENT_METHOD_VERSION,
      imageId: TEST_IMAGE_ID,
    };
    const baseSession: AmplifySessionRecord = {
      id: 'session-async',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      logId: null,
      botCount: 64,
      finalized: false,
      userVoteIndex: 0,
      ttl: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      finalizationResultJson: wrapFinalizationPayload({
        finalizationResult: {
          tally: {
            counts: { A: 32, B: 32, C: 0, D: 0, E: 0 } as const,
            totalVotes: 64,
            tamperedCount: 0,
          },
          imageId: TEST_IMAGE_ID,
          journal,
          publicInputArtifact: createAuthoritativePublicInputArtifact(journal, {
            executionId: 'exec-1',
          }),
          verificationExecutionId: 'exec-1',
        },
        finalizationState: {
          status: 'running',
          executionId: 'ulid-1',
          queuedAt: 1730000000000,
          startedAt: 1730000005000,
          stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-1',
        },
      }),
      bulletinRootHistoryJson: JSON.stringify([]),
    };

    const session = await store.buildSessionDataForTest(baseSession, []);

    expect(session.finalizationState).toEqual({
      status: 'running',
      executionId: 'ulid-1',
      queuedAt: 1730000000000,
      startedAt: 1730000005000,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-1',
    });

    expect(session.finalizationResult).toMatchObject({
      tally: {
        counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
        totalVotes: 64,
      },
      imageId: TEST_IMAGE_ID,
      verificationExecutionId: 'exec-1',
    });
  });

  it('fails closed on wrapped finalizationResultJson payloads with compatibility mirrors', async () => {
    const store = createTestStore();
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const session = await store.buildSessionDataForTest(
      {
        id: 'session-invalid-compat-mirrors',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 64,
        finalized: true,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: wrapFinalizationPayload({
          finalizationResult: {
            tally: {
              counts: { A: 32, B: 32, C: 0, D: 0, E: 0 } as const,
              totalVotes: 64,
              tamperedCount: 0,
            },
            bulletinRoot: journal.bulletinRoot,
            imageId: TEST_IMAGE_ID,
            missingIndices: journal.missingSlots,
            excludedCount: journal.excludedSlots,
            journal,
          },
          finalizationState: {
            status: 'running',
            executionId: 'ulid-1',
            queuedAt: 1730000000000,
            startedAt: 1730000005000,
          },
        }),
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationResult).toBeUndefined();
    expect(session.finalizationState).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('rejects wrapped finalization results that do not satisfy the authority boundary', async () => {
    const store = createTestStore();
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 64,
      missingIndices: 0,
      invalidIndices: 0,
    });
    const session = await store.buildSessionDataForTest(
      {
        id: 'session-invalid-authority',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 64,
        finalized: true,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: wrapFinalizationPayload({
          finalizationResult: {
            imageId: TEST_IMAGE_ID,
            journal,
          },
          finalizationState: null,
        }),
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationResult).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('strips journal-derived compatibility mirrors from serialized storage payloads', () => {
    const store = createTestStore();
    const journal = {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      bulletinRoot: '0x' + 'b'.repeat(64),
      treeSize: 64,
      totalExpected: 64,
      sthDigest: '0x' + 'c'.repeat(64),
      verifiedTally: [32, 32, 0, 0, 0],
      totalVotes: 64,
      validVotes: 64,
      invalidVotes: 0,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      missingIndices: 0,
      invalidIndices: 0,
      countedIndices: 64,
      seenBitmapRoot: '0x' + 'd'.repeat(64),
      includedBitmapRoot: '0x' + 'e'.repeat(64),
      excludedSlots: 0,
      excludedCount: 0,
      inputCommitment: '0x' + 'f'.repeat(64),
      methodVersion: CURRENT_METHOD_VERSION,
      imageId: TEST_IMAGE_ID,
    };

    const serialized = store.serializeFinalizationPayloadForTest(
      {
        tally: {
          counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        bulletinRoot: journal.bulletinRoot,
        verifiedTally: journal.verifiedTally,
        missingSlots: journal.missingSlots,
        invalidPresentedSlots: journal.invalidPresentedSlots,
        rejectedRecords: journal.rejectedRecords,
        missingIndices: journal.missingSlots,
        invalidIndices: journal.invalidPresentedSlots,
        countedIndices: journal.validVotes,
        totalExpected: journal.totalExpected,
        treeSize: journal.treeSize,
        excludedSlots: journal.excludedSlots,
        excludedCount: journal.excludedSlots,
        sthDigest: journal.sthDigest,
        seenBitmapRoot: journal.seenBitmapRoot,
        includedBitmapRoot: journal.includedBitmapRoot,
        inputCommitment: journal.inputCommitment,
        seenIndicesCount: journal.seenIndicesCount,
        imageId: TEST_IMAGE_ID,
        journal,
      },
      null,
      null,
      resolveCurrentContractGeneration(),
    );

    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized ?? '{}') as { finalizationResult?: Record<string, unknown> | null };
    expect(parsed.finalizationResult).toMatchObject({
      tally: {
        counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
        totalVotes: 64,
        tamperedCount: 0,
      },
      imageId: TEST_IMAGE_ID,
      journal,
    });
    expect(parsed.finalizationResult).not.toHaveProperty('bulletinRoot');
    expect(parsed.finalizationResult).not.toHaveProperty('verifiedTally');
    expect(parsed.finalizationResult).not.toHaveProperty('missingIndices');
    expect(parsed.finalizationResult).not.toHaveProperty('excludedCount');
  });

  it('does not synthesize finalization result when storage is missing', async () => {
    const store = createTestStore();
    const baseSession: AmplifySessionRecord = {
      id: 'session-no-finalize',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      logId: null,
      botCount: 1,
      finalized: false,
      userVoteIndex: 0,
      ttl: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      finalizationResultJson: null,
      bulletinRootHistoryJson: JSON.stringify([]),
    } as const;

    const votes: AmplifyVoteRecord[] = [
      {
        id: 'vote-1',
        sessionId: baseSession.id,
        voteIndex: 0,
        choice: encryptVoteSecret('A'),
        random: encryptVoteSecret('0x' + '1'.repeat(64)),
        commitment: '0x' + '2'.repeat(64),
        timestamp: new Date().toISOString(),
        rootAtCast: '0x' + '3'.repeat(64),
        isUserVote: true,
        path: [],
      },
    ];

    const session = await store.buildSessionDataForTest(baseSession, votes);

    expect(session.finalizationResult).toBeUndefined();
  });

  it('fails closed on unwrapped legacy finalizationResultJson payloads', async () => {
    const store = createTestStore();
    const journal = createTestJournal();
    const baseSession: AmplifySessionRecord = {
      id: 'session-legacy-finalize',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      logId: null,
      botCount: 1,
      finalized: true,
      userVoteIndex: 0,
      ttl: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      finalizationResultJson: JSON.stringify({
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        imageId: TEST_IMAGE_ID,
        journal,
      }),
      bulletinRootHistoryJson: JSON.stringify([]),
    } as const;

    const session = await store.buildSessionDataForTest(baseSession, []);

    expect(session.finalizationResult).toBeUndefined();
    expect(session.finalizationState).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('fails closed on wrapped seed-only finalizationResultJson payloads', async () => {
    const store = createTestStore();
    const baseSession: AmplifySessionRecord = {
      id: 'session-seed-only-finalize',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      logId: null,
      botCount: 1,
      finalized: true,
      userVoteIndex: 0,
      ttl: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      finalizationResultJson: wrapFinalizationPayload({
        finalizationResult: {
          tally: {
            counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
            totalVotes: 1,
            tamperedCount: 0,
          },
          imageId: TEST_IMAGE_ID,
          s3BundleKey: 'sessions/session-seed-only-finalize/exec-1/bundle.zip',
        },
        finalizationState: null,
      }),
      bulletinRootHistoryJson: JSON.stringify([]),
    } as const;

    const session = await store.buildSessionDataForTest(baseSession, []);

    expect(session.finalizationResult).toBeUndefined();
    expect(session.finalizationState).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('hydrates scenario context from finalizationResultJson', async () => {
    const store = createTestStore();
    const baseSession: AmplifySessionRecord = {
      id: 'session-with-scenario',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      logId: null,
      botCount: 64,
      finalized: false,
      userVoteIndex: 0,
      ttl: Math.floor(Date.now() / 1000) + 300,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      finalizationResultJson: wrapFinalizationPayload({
        finalizationResult: null,
        finalizationState: null,
        finalizationScenarioContext: {
          scenarios: ['S2'],
          tamperMode: 'claim',
          claimedCounts: { A: 0, B: 2, C: 1, D: 0, E: 0 },
          claimedTotalVotes: 3,
          summary: {
            ignoredCount: 0,
            recountedCount: 1,
            userRecountChoice: 'B',
          },
        },
      }),
      bulletinRootHistoryJson: JSON.stringify([]),
    } as const;

    const session = await store.buildSessionDataForTest(baseSession, []);

    expect(session.finalizationScenarioContext).toEqual({
      scenarios: ['S2'],
      tamperMode: 'claim',
      claimedCounts: { A: 0, B: 2, C: 1, D: 0, E: 0 },
      claimedTotalVotes: 3,
      summary: {
        ignoredCount: 0,
        recountedCount: 1,
        userRecountChoice: 'B',
      },
    });
  });

  it('returns null JSON when both result and state are empty', () => {
    const store = createTestStore();
    const serialize = store.serializeFinalizationPayloadForTest.bind(store);

    expect(serialize(undefined, undefined)).toBeNull();
    expect(serialize(null, null)).toBeNull();
  });

  it('serializes scenario context when result and state are empty', () => {
    const store = createTestStore();
    const serialize = store.serializeFinalizationPayloadForTest.bind(store);
    const scenarioContext: FinalizationScenarioContext = {
      scenarios: ['S2'],
      tamperMode: 'claim',
      claimedCounts: { A: 0, B: 2, C: 1, D: 0, E: 0 },
      claimedTotalVotes: 3,
      summary: {
        ignoredCount: 0,
        recountedCount: 1,
        userRecountChoice: 'B',
      },
    };

    expect(() => serialize(null, null, scenarioContext)).toThrow('contractGeneration');
  });

  it('serializes scenario context when contractGeneration is explicit', () => {
    const store = createTestStore();
    const serialize = store.serializeFinalizationPayloadForTest.bind(store);
    const scenarioContext: FinalizationScenarioContext = {
      scenarios: ['S2'],
      tamperMode: 'claim',
      claimedCounts: { A: 0, B: 2, C: 1, D: 0, E: 0 },
      claimedTotalVotes: 3,
      summary: {
        ignoredCount: 0,
        recountedCount: 1,
        userRecountChoice: 'B',
      },
    };

    const serialized = serialize(null, null, scenarioContext, resolveCurrentContractGeneration());
    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized ?? '{}') as Record<string, unknown>;
    expect(parsed.finalizationResult).toBeNull();
    expect(parsed.finalizationState).toBeNull();
    expect(parsed.finalizationScenarioContext).toEqual(scenarioContext);
  });

  it('classifies stale running wrappers before finalized=true', async () => {
    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        id: 'session-running-stale-wrapper',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 1,
        finalized: false,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: JSON.stringify({
          contractGeneration: 'stale-contract-generation',
          finalizationResult: null,
          finalizationState: {
            status: 'running',
            executionId: 'exec-running-stale',
            queuedAt: 1730000000000,
            startedAt: 1730000001000,
          },
        }),
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationState).toEqual({
      status: 'running',
      executionId: 'exec-running-stale',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
    });
    expect(session.finalizationArtifactState).toBe('unsupported_current_artifact');
  });

  it('treats generation-less running wrappers as corrupt after tightening', async () => {
    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        id: 'session-running-generationless-wrapper',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 1,
        finalized: false,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: JSON.stringify({
          finalizationResult: null,
          finalizationState: {
            status: 'running',
            executionId: 'exec-running-corrupt',
            queuedAt: 1730000000000,
            startedAt: 1730000001000,
          },
        }),
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationState).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('treats generation-less finalized wrappers as corrupt after tightening', async () => {
    const store = createTestStore();
    const journal = createTestJournal();
    const session = await store.buildSessionDataForTest(
      {
        id: 'session-finalized-generationless-wrapper',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        contractGeneration: resolveCurrentContractGeneration(),
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 1,
        finalized: true,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: JSON.stringify({
          finalizationResult: {
            tally: {
              counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
              totalVotes: 1,
              tamperedCount: 0,
            },
            imageId: TEST_IMAGE_ID,
            journal,
          },
          finalizationState: {
            status: 'succeeded',
            executionId: 'exec-finalized-generationless',
            queuedAt: 1730000000000,
            startedAt: 1730000001000,
            completedAt: 1730000002000,
          },
        }),
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationResult).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('treats current finalized wrappers without an authoritative result as corrupt', async () => {
    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        id: 'session-finalized-null-result-current-wrapper',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        contractGeneration: resolveCurrentContractGeneration(),
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 1,
        finalized: true,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: JSON.stringify({
          contractGeneration: resolveCurrentContractGeneration(),
          finalizationResult: null,
          finalizationState: {
            status: 'succeeded',
            executionId: 'exec-finalized-null',
            queuedAt: 1730000000000,
            startedAt: 1730000001000,
            completedAt: 1730000002000,
          },
        }),
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationResult).toBeUndefined();
    expect(session.finalizationState).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('fails closed when finalizationResultJson is malformed but the wrapper field exists', async () => {
    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        id: 'session-running-malformed-wrapper',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        contractGeneration: resolveCurrentContractGeneration(),
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 1,
        finalized: false,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: '{"contractGeneration":"stale-contract-generation"',
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationState).toBeUndefined();
    expect(session.finalizationResult).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('honors a persisted fail-closed tombstone even when the wrapper is unreadable', async () => {
    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        id: 'session-top-level-tombstone',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationArtifactState: 'corrupt_or_unreadable',
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 1,
        finalized: false,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: '{"broken":',
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationState).toBeUndefined();
    expect(session.finalizationResult).toBeUndefined();
    expect(session.finalizationArtifactState).toBe('corrupt_or_unreadable');
  });

  it('ignores persisted supported markers and re-classifies from the wrapper boundary', async () => {
    const store = createTestStore();
    const session = await store.buildSessionDataForTest(
      {
        id: 'session-supported-marker-ignored',
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        contractGeneration: resolveCurrentContractGeneration(),
        finalizationArtifactState: 'supported',
        electionConfigHash: '0x' + 'a'.repeat(64),
        logId: null,
        botCount: 1,
        finalized: false,
        userVoteIndex: 0,
        ttl: Math.floor(Date.now() / 1000) + 300,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        finalizationResultJson: JSON.stringify({
          contractGeneration: 'stale-contract-generation',
          finalizationResult: null,
          finalizationState: {
            status: 'running',
            executionId: 'exec-supported-marker-ignored',
            queuedAt: 1730000000000,
            startedAt: 1730000001000,
          },
        }),
        bulletinRootHistoryJson: JSON.stringify([]),
      },
      [],
    );

    expect(session.finalizationState).toEqual({
      status: 'running',
      executionId: 'exec-supported-marker-ignored',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
    });
    expect(session.finalizationArtifactState).toBe('unsupported_current_artifact');
  });

  it('uses the persisted wrapper generation for follow-up finalization writes', async () => {
    const store = createTestStore();
    const session = buildFinalizedSession(Date.now(), false);
    session.contractGeneration = 'stale-contract-generation';
    session.finalizationContractGeneration = resolveCurrentContractGeneration();
    session.finalizationState = {
      status: 'running',
      executionId: 'exec-follow-up',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
    };

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;

    await (
      store as unknown as {
        persistSessionMetadata: (
          sessionId: string,
          options: Record<string, unknown>,
          existingSession: SessionData,
        ) => Promise<void>;
      }
    ).persistSessionMetadata(
      session.sessionId,
      {
        finalizationState: {
          status: 'failed',
          executionId: 'exec-follow-up',
          queuedAt: 1730000000000,
          startedAt: 1730000001000,
          failedAt: 1730000002000,
          error: {
            code: 'FINALIZATION_FAILED',
            message: 'follow-up failed',
          },
        },
      },
      session,
    );

    const serializedPayload = capturedInput?.finalizationResultJson;
    const serialized = JSON.parse(typeof serializedPayload === 'string' ? serializedPayload : 'null') as {
      contractGeneration?: string;
    };
    expect(serialized.contractGeneration).toBe(resolveCurrentContractGeneration());
  });

  it('rejects follow-up writes when the persisted wrapper is generation-less', async () => {
    const store = createTestStore();
    const session = buildFinalizedSession(Date.now(), false);
    session.hasPersistedFinalizationBranch = true;
    session.finalizationContractGeneration = undefined;
    session.finalizationState = undefined;
    session.finalizationResult = undefined;
    session.finalizationScenarioContext = undefined;
    session.finalizationArtifactState = 'corrupt_or_unreadable';

    await expect(
      (
        store as unknown as {
          persistSessionMetadata: (
            sessionId: string,
            options: Record<string, unknown>,
            existingSession: SessionData,
          ) => Promise<void>;
        }
      ).persistSessionMetadata(
        session.sessionId,
        {
          finalizationState: {
            status: 'failed',
            executionId: 'exec-follow-up',
            queuedAt: 1730000000000,
            startedAt: 1730000001000,
            failedAt: 1730000002000,
            error: {
              code: 'FINALIZATION_FAILED',
              message: 'follow-up failed',
            },
          },
        },
        session,
      ),
    ).rejects.toMatchObject({
      code: 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
      artifactState: 'corrupt_or_unreadable',
    });
  });

  it('rejects follow-up writes when the persisted wrapper is already unsupported', async () => {
    const store = createTestStore();
    const session = buildFinalizedSession(Date.now(), false);
    session.finalizationContractGeneration = 'stale-contract-generation';
    session.finalizationState = {
      status: 'running',
      executionId: 'exec-follow-up',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
    };
    session.finalizationArtifactState = 'unsupported_current_artifact';

    await expect(
      (
        store as unknown as {
          persistSessionMetadata: (
            sessionId: string,
            options: Record<string, unknown>,
            existingSession: SessionData,
          ) => Promise<void>;
        }
      ).persistSessionMetadata(
        session.sessionId,
        {
          finalizationState: {
            status: 'failed',
            executionId: 'exec-follow-up',
            queuedAt: 1730000000000,
            startedAt: 1730000001000,
            failedAt: 1730000002000,
            error: {
              code: 'FINALIZATION_FAILED',
              message: 'follow-up failed',
            },
          },
        },
        session,
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_CURRENT_ARTIFACT',
      artifactState: 'unsupported_current_artifact',
    });
  });

  it('repairs stale wrapper generation patches by clearing the persisted tombstone', async () => {
    const store = createTestStore();
    const session = buildFinalizedSession(Date.now(), false);
    session.finalizationContractGeneration = 'stale-contract-generation';
    session.finalizationArtifactState = 'unsupported_current_artifact';
    session.finalizationState = {
      status: 'failed',
      executionId: 'exec-repair-wrapper',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      failedAt: 1730000002000,
      error: {
        code: 'UNSUPPORTED_CURRENT_ARTIFACT',
        message: 'stale boundary tombstone',
      },
    };

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await store.updateSession(session.sessionId, {
      finalizationContractGeneration: resolveCurrentContractGeneration(),
    });

    expect(capturedInput?.id).toBe(session.sessionId);
    expect(capturedInput?.finalizationArtifactState).toBeNull();
    expect(typeof capturedInput?.finalizationResultJson).toBe('string');
    expect(JSON.parse(String(capturedInput?.finalizationResultJson))).toMatchObject({
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationState: null,
    });
  });

  it('keeps verification TTL when saving bitmap data for finalized sessions', async () => {
    vi.useFakeTimers();
    const now = new Date('2025-01-01T00:00:00Z');
    vi.setSystemTime(now);

    const store = createTestStore();
    const session = buildFinalizedSession(now.getTime());

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await store.saveBitmapData(session.sessionId, {
      includedBitmap: [true],
      includedBitmapRoot: '0x' + '1'.repeat(64),
      treeSize: 1,
      finalizedAt: now.getTime(),
    });

    const expectedTtl = Math.floor(now.getTime() / 1000) + 7200;
    expect(capturedInput?.ttl).toBe(expectedTtl);
    expect(capturedInput?.finalized).toBe(true);

    vi.useRealTimers();
  });

  it('keeps verification TTL when updating finalizationResult for finalized sessions', async () => {
    vi.useFakeTimers();
    const now = new Date('2025-01-01T00:00:00Z');
    vi.setSystemTime(now);

    const store = createTestStore();
    const session = buildFinalizedSession(now.getTime());
    if (!session.finalizationResult) {
      throw new Error('Expected finalizationResult in test setup');
    }
    const finalizationResult = session.finalizationResult;
    const updatedResult: FinalizationResultAuthority = {
      ...finalizationResult,
      verificationExecutionId: 'exec-1',
    };

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await store.updateSession(session.sessionId, { finalizationResult: updatedResult });

    const expectedTtl = Math.floor(now.getTime() / 1000) + 7200;
    expect(capturedInput?.ttl).toBe(expectedTtl);
    expect(capturedInput?.finalized).toBeUndefined();

    vi.useRealTimers();
  });

  it('keeps live TTL when queueing finalization before finalized=true', async () => {
    vi.useFakeTimers();
    const now = new Date('2025-01-01T00:00:00Z');
    vi.setSystemTime(now);

    const store = createTestStore();
    const session = buildFinalizedSession(now.getTime(), false);
    session.finalizationResult = undefined;
    session.finalizationContractGeneration = undefined;

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await store.markFinalizationQueued(session.sessionId, {
      executionId: 'exec-pending',
      queuedAt: now.getTime(),
      contractGeneration: resolveCurrentContractGeneration(),
    });

    const expectedTtl = Math.floor(now.getTime() / 1000) + 300;
    expect(capturedInput?.ttl).toBe(expectedTtl);
    expect(capturedInput?.finalized).toBeUndefined();

    vi.useRealTimers();
  });

  it('leaves a top-level tombstone when a generation-less live record mismatches during queueing', async () => {
    const now = Date.now();
    const store = createTestStore();
    const session = buildFinalizedSession(now, false);
    session.contractGeneration = undefined;
    session.finalizationContractGeneration = undefined;
    session.finalizationResult = undefined;
    session.finalizationState = undefined;
    session.finalizationScenarioContext = undefined;
    session.finalizationArtifactState = undefined;

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    const nextState = await store.markFinalizationQueued(session.sessionId, {
      executionId: 'exec-generationless',
      queuedAt: now,
      contractGeneration: resolveCurrentContractGeneration(),
    });

    expect(nextState).toMatchObject({
      status: 'failed',
      error: {
        code: 'UNSUPPORTED_CURRENT_ARTIFACT',
      },
    });
    expect(capturedInput).toEqual({
      id: session.sessionId,
      finalizationArtifactState: 'unsupported_current_artifact',
      finalizationResultJson: null,
    });
  });

  it('converges stale branches before returning early on executionId mismatch', async () => {
    const now = Date.now();
    const store = createTestStore();
    const session = buildFinalizedSession(now, false);
    session.finalizationState = {
      status: 'running',
      executionId: 'exec-original',
      queuedAt: now,
      startedAt: now + 1000,
    };
    session.finalizationContractGeneration = 'stale-contract-generation';

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    const nextState = await store.markFinalizationFailed(session.sessionId, {
      executionId: 'exec-new',
      queuedAt: now + 5000,
      startedAt: now + 6000,
      failedAt: now + 7000,
      contractGeneration: resolveCurrentContractGeneration(),
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'later callback failed',
      },
    });

    expect(nextState).toMatchObject({
      status: 'failed',
      executionId: 'exec-original',
      queuedAt: now,
      startedAt: now + 1000,
      error: {
        code: 'UNSUPPORTED_CURRENT_ARTIFACT',
      },
    });

    const payloadJson = capturedInput?.finalizationResultJson;
    expect(capturedInput?.id).toBe(session.sessionId);
    expect(capturedInput?.finalizationArtifactState).toBe('unsupported_current_artifact');
    expect(typeof payloadJson).toBe('string');
    expect(JSON.parse(String(payloadJson))).toMatchObject({
      contractGeneration: 'stale-contract-generation',
      finalizationState: {
        status: 'failed',
        executionId: 'exec-original',
        queuedAt: now,
        startedAt: now + 1000,
        error: {
          code: 'UNSUPPORTED_CURRENT_ARTIFACT',
        },
      },
    });
  });

  it('does not regress TTL when bitmap data is saved with stale finalized flag', async () => {
    vi.useFakeTimers();
    const now = new Date('2025-01-01T00:00:00Z');
    vi.setSystemTime(now);

    const store = createTestStore();
    const session = buildFinalizedSession(now.getTime(), false);

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);

    await store.saveBitmapData(session.sessionId, {
      includedBitmap: [true],
      includedBitmapRoot: '0x' + '1'.repeat(64),
      treeSize: 1,
      finalizedAt: now.getTime(),
    });

    const expectedTtl = Math.floor(now.getTime() / 1000) + 7200;
    expect(capturedInput?.ttl).toBe(expectedTtl);
    expect(capturedInput?.finalized).toBe(true);

    vi.useRealTimers();
  });

  it('classifies fail-closed finalization branches in getSessionSummary', async () => {
    const store = createTestStore();
    const journal = createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
    });

    const executeStub = vi.fn((query: string) => {
      if (query.includes('query GetVotingSession')) {
        return {
          getVotingSession: {
            id: 'session-summary-stale',
            electionId: '550e8400-e29b-41d4-a716-446655440000',
            contractGeneration: resolveCurrentContractGeneration(),
            finalizationArtifactState: null,
            electionConfigHash: '0x' + 'a'.repeat(64),
            electionConfigJson: JSON.stringify({}),
            logId: null,
            botCount: 9,
            finalized: false,
            userVoteIndex: 0,
            ttl: Math.floor(Date.now() / 1000) + 300,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString(),
            finalizationResultJson: JSON.stringify({
              contractGeneration: 'stale-contract-generation',
              finalizationResult: {
                tally: {
                  counts: { A: 1, B: 0, C: 0, D: 0, E: 0 } as const,
                  totalVotes: 1,
                  tamperedCount: 0,
                },
                imageId: TEST_IMAGE_ID,
                journal,
              },
            }),
            bulletinRootHistoryJson: JSON.stringify([]),
          },
        };
      }
      if (query.includes('query VotesBySession')) {
        return {
          listVoteBySessionIdAndVoteIndex: {
            items: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                sessionId: 'session-summary-stale',
                voteIndex: 0,
                choice: encryptVoteSecret('A'),
                random: encryptVoteSecret('0x' + '1'.repeat(64)),
                commitment: '0x' + '2'.repeat(64),
                timestamp: new Date().toISOString(),
                rootAtCast: '0x' + '3'.repeat(64),
                isUserVote: true,
              },
            ],
            nextToken: null,
          },
        };
      }

      throw new Error(`Unexpected query: ${query}`);
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;

    const summary = await store.getSessionSummary('session-summary-stale');

    expect(summary).toEqual({
      sessionId: 'session-summary-stale',
      botCount: 0,
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationArtifactState: 'unsupported_current_artifact',
      userVoteIndex: 0,
      finalized: false,
    });
    expect(executeStub).toHaveBeenCalledTimes(2);
  });

  it('reconciles stale botCount in getSessionSummary from persisted vote records', async () => {
    const store = createTestStore();
    const now = new Date().toISOString();

    const executeStub = vi.fn((query: string) => {
      if (query.includes('query GetVotingSession')) {
        return {
          getVotingSession: {
            id: 'session-summary-reconciled',
            electionId: '550e8400-e29b-41d4-a716-446655440000',
            contractGeneration: resolveCurrentContractGeneration(),
            finalizationArtifactState: null,
            electionConfigHash: '0x' + 'a'.repeat(64),
            electionConfigJson: JSON.stringify({}),
            logId: 'log-summary-reconciled',
            botCount: 9,
            finalized: false,
            userVoteIndex: 0,
            ttl: Math.floor(Date.now() / 1000) + 300,
            createdAt: now,
            lastActivity: now,
            finalizationResultJson: null,
            bulletinRootHistoryJson: JSON.stringify([]),
          },
        };
      }
      if (query.includes('query VotesBySession')) {
        return {
          listVoteBySessionIdAndVoteIndex: {
            items: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                sessionId: 'session-summary-reconciled',
                voteIndex: 0,
                choice: encryptVoteSecret('A'),
                random: encryptVoteSecret('0x' + '1'.repeat(64)),
                commitment: '0x' + '2'.repeat(64),
                timestamp: now,
                rootAtCast: '0x' + '3'.repeat(64),
                isUserVote: true,
              },
              {
                id: '22222222-2222-4222-8222-222222222222',
                sessionId: 'session-summary-reconciled',
                voteIndex: 1,
                choice: encryptVoteSecret('B'),
                random: encryptVoteSecret('0x' + '4'.repeat(64)),
                commitment: '0x' + '5'.repeat(64),
                timestamp: now,
                rootAtCast: '0x' + '6'.repeat(64),
                isUserVote: false,
              },
            ],
            nextToken: null,
          },
        };
      }

      throw new Error(`Unexpected query: ${query}`);
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;

    const summary = await store.getSessionSummary('session-summary-reconciled');

    expect(summary).toEqual({
      sessionId: 'session-summary-reconciled',
      botCount: 1,
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationArtifactState: undefined,
      userVoteIndex: 0,
      finalized: false,
    });
  });

  it('persists finalized=true when async finalization succeeds', async () => {
    vi.useFakeTimers();
    const now = new Date('2025-01-01T00:00:00Z');
    vi.setSystemTime(now);

    const store = createTestStore();
    const session = buildFinalizedSession(now.getTime(), false);
    session.finalizationState = {
      status: 'running',
      executionId: 'exec-123',
      queuedAt: now.getTime() - 2_000,
      startedAt: now.getTime() - 1_000,
    };

    let capturedInput: Record<string, unknown> | undefined;
    const executeStub = vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation UpdateVotingSession')) {
        capturedInput = (variables?.input ?? {}) as Record<string, unknown>;
      }
      return {};
    });

    (store as unknown as { execute: typeof executeStub }).execute = executeStub;
    vi.spyOn(store, 'getSession').mockResolvedValue(session);
    if (!session.finalizationResult) {
      throw new Error('Expected finalizationResult in test setup');
    }
    const finalizationResult = session.finalizationResult;

    await store.markFinalizationSucceeded(session.sessionId, {
      executionId: 'exec-123',
      queuedAt: now.getTime() - 2_000,
      startedAt: now.getTime() - 1_000,
      completedAt: now.getTime(),
      contractGeneration: resolveCurrentContractGeneration(),
      finalizationResult,
    });

    expect(capturedInput?.finalized).toBe(true);

    vi.useRealTimers();
  });
});

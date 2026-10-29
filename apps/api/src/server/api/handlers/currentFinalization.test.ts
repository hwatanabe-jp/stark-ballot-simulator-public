import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import type { MockVoteStore } from '../../test-support/mockVoteStore';
import {
  CurrentFinalizationResponseSchema,
  type CurrentFinalizationResponse,
} from '@stark-ballot/api-contract/schemas/finalizations';
import { createMockVoteStore } from '../../test-support/mockVoteStore';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type { SessionIdentityRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { getCurrentFinalizationHandler } from './currentFinalization';

const capabilitySecret = 'session-status-handler-secret-0123456789abcdef';
const sessionId = asSessionId('session-status-1');
const finalizationId = asFinalizationId('exec-status-1');
const fixedNow = 1_730_000_000_000;
const logId = `0x${'2'.repeat(64)}`;
const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 0,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

function buildSucceededScenarioContext(journal: ReturnType<typeof createTestJournal>): FinalizationScenarioContext {
  const [A, B, C, D, E] = journal.verifiedTally;
  return {
    ...scenarioContext,
    claimedCounts: { A, B, C, D, E },
    claimedTotalVotes: journal.validVotes,
  };
}

type TargetRuntimeProfile = Extract<ResolvedRuntimeProfile, { readonly target: { readonly kind: 'aws' } }>;
type ReconciliationState = Exclude<FinalizationState, { status: 'succeeded' }>;
type RunningFinalizationState = Extract<FinalizationState, { status: 'running' }>;

function isTargetRuntimeProfile(profile: ResolvedRuntimeProfile): profile is TargetRuntimeProfile {
  return profile.name === 'target-aws-async' || profile.name === 'target-aws-async-quiesced';
}

function requireTargetRuntimeProfile(profile: ResolvedRuntimeProfile): TargetRuntimeProfile {
  if (!isTargetRuntimeProfile(profile)) {
    throw new Error('Expected target AWS runtime profile');
  }
  return profile;
}

const asyncRuntimeProfile = requireTargetRuntimeProfile(targetRuntimeProfile());
const stateMachineArn = asyncRuntimeProfile.external.asyncRuntime.proverStateMachineArn;
const executionArn = `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${finalizationId}`;

function buildIdentity(): SessionIdentityRecord {
  return {
    sessionId,
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: `0x${'1'.repeat(64)}`,
    electionConfig: {
      totalExpected: 1,
      choices: ['A', 'B', 'C', 'D', 'E'],
      version: 'test-v1',
      botCount: 0,
      merkleTreeDepth: 1,
    },
    logId,
    createdAtMs: fixedNow - 10_000,
  };
}

function buildVotingRecord(): SessionVotingRecord {
  return {
    sessionId,
    votes: new Map(),
    bulletin: new SimpleBulletinBoard(logId),
    bulletinRootHistory: [],
    botCount: 0,
    userParticipation: { status: 'not_cast' },
    lastActivityMs: fixedNow - 1000,
  };
}

function buildFinalizationRecord(state: ReconciliationState): FinalizationRecord {
  return {
    sessionId,
    finalizationId,
    scenarioContext,
    state,
  };
}

function buildPendingState(queuedAtMs: number): Extract<FinalizationState, { status: 'pending' }> {
  return {
    status: 'pending',
    finalizationId,
    queuedAtMs,
  };
}

function buildRunningState(startedAtMs: number): RunningFinalizationState {
  return {
    status: 'running',
    finalizationId,
    queuedAtMs: startedAtMs - 1000,
    startedAtMs,
  };
}

function buildStore(finalizationState: ReconciliationState, overrides: Partial<MockVoteStore> = {}): MockVoteStore {
  const identity = buildIdentity();
  const voting = buildVotingRecord();
  const finalization = buildFinalizationRecord(finalizationState);
  return createMockVoteStore({
    getSessionIdentity: (requestedSessionId) => Promise.resolve(requestedSessionId === sessionId ? identity : null),
    getVotingRecord: (requestedSessionId) => Promise.resolve(requestedSessionId === sessionId ? voting : null),
    getCurrentFinalizationRecord: (requestedSessionId) =>
      Promise.resolve(requestedSessionId === sessionId ? finalization : null),
    getAwsFinalizationRuntimeMetadata: (requestedSessionId, requestedFinalizationId) =>
      Promise.resolve(
        requestedSessionId === sessionId &&
          requestedFinalizationId === finalizationId &&
          finalizationState.status === 'running'
          ? { stepFunctionsArn: executionArn }
          : undefined,
      ),
    ...overrides,
  });
}

async function readStatusResponse(response: Response): Promise<CurrentFinalizationResponse['data']> {
  const body: unknown = await response.json();
  return CurrentFinalizationResponseSchema.parse(body).data;
}

async function loadSessionReadModel(store: MockVoteStore): Promise<SessionReadModel> {
  const [identity, voting, finalization] = await Promise.all([
    store.getSessionIdentity(sessionId),
    store.getVotingRecord(sessionId),
    store.getCurrentFinalizationRecord(sessionId),
  ]);
  if (!identity || !voting) {
    throw new Error('Expected exact status test records to exist.');
  }
  return { identity, voting, finalization };
}

async function requestStatusResponse(
  store: MockVoteStore,
  runtimeProfile: ResolvedRuntimeProfile = asyncRuntimeProfile,
): Promise<Response> {
  const session = await loadSessionReadModel(store);
  return getCurrentFinalizationHandler({
    input: {
      params: { sessionId },
      headers: {
        [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId }, capabilitySecret),
      },
    },
    context: {
      store,
      requestId: 'session-status-test-request',
      requestOrigin: 'http://localhost',
      operatorGatedDevelop: false,
      runtimeProfile,
      sessionId,
      session,
    },
  });
}

async function requestStatus(
  store: MockVoteStore,
  runtimeProfile: ResolvedRuntimeProfile = asyncRuntimeProfile,
): Promise<CurrentFinalizationResponse['data']> {
  const response = await requestStatusResponse(store, runtimeProfile);
  expect(response.status).toBe(200);
  return readStatusResponse(response);
}

describe('getCurrentFinalizationHandler persisted authority', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('projects bitmap availability from the admitted finalization sidecar', async () => {
    const journal = createTestJournal({ totalExpected: 1, validVotes: 1 });
    journal.includedBitmapRoot = computeIncludedBitmapRoot([true]);
    journal.seenBitmapRoot = journal.includedBitmapRoot;
    const succeededScenarioContext = buildSucceededScenarioContext(journal);
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: `0x${'1'.repeat(64)}`,
      scenarioContext: succeededScenarioContext,
    });
    const succeeded: FinalizationRecord = {
      sessionId,
      finalizationId,
      scenarioContext: succeededScenarioContext,
      state: {
        status: 'succeeded',
        finalizationId,
        queuedAtMs: fixedNow - 3000,
        startedAtMs: fixedNow - 2000,
        completedAtMs: fixedNow - 1000,
      },
      finalizationResult: { finalizationId, ...authority },
    };
    const getBitmapData = vi.fn().mockResolvedValue({
      sessionId,
      finalizationId,
      includedBitmap: [true],
      includedBitmapRoot: journal.includedBitmapRoot,
      treeSize: journal.treeSize,
      finalizedAtMs: fixedNow - 1000,
    });
    const store = createMockVoteStore({
      getSessionIdentity: () => Promise.resolve(buildIdentity()),
      getVotingRecord: () => Promise.resolve(buildVotingRecord()),
      getCurrentFinalizationRecord: () => Promise.resolve(succeeded),
      getBitmapData,
    });

    const payload = await requestStatus(store, localRuntimeProfile());

    expect(getBitmapData).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(payload?.status).toBe('succeeded');
    expect(payload?.status === 'succeeded' ? payload.result.artifactAvailability.includedBitmap : null).toBe(
      'available',
    );
  });

  it.each([
    ['root', { includedBitmapRoot: `0x${'0'.repeat(64)}` }],
    ['treeSize', { treeSize: 2 }],
    ['length', { includedBitmap: [true, false] }],
  ])('keeps bitmap unavailable when persisted sidecar %s does not match the journal', async (_label, mismatch) => {
    const journal = createTestJournal({ totalExpected: 1, validVotes: 1 });
    journal.includedBitmapRoot = computeIncludedBitmapRoot([true]);
    journal.seenBitmapRoot = journal.includedBitmapRoot;
    const succeededScenarioContext = buildSucceededScenarioContext(journal);
    const authority = buildFinalizationResultFromJournal({
      journal,
      imageId: `0x${'1'.repeat(64)}`,
      scenarioContext: succeededScenarioContext,
    });
    const succeeded: FinalizationRecord = {
      sessionId,
      finalizationId,
      scenarioContext: succeededScenarioContext,
      state: {
        status: 'succeeded',
        finalizationId,
        queuedAtMs: fixedNow - 3000,
        startedAtMs: fixedNow - 2000,
        completedAtMs: fixedNow - 1000,
      },
      finalizationResult: { finalizationId, ...authority },
    };
    const store = createMockVoteStore({
      getSessionIdentity: () => Promise.resolve(buildIdentity()),
      getVotingRecord: () => Promise.resolve(buildVotingRecord()),
      getCurrentFinalizationRecord: () => Promise.resolve(succeeded),
      getBitmapData: () =>
        Promise.resolve({
          sessionId,
          finalizationId,
          includedBitmap: [true],
          includedBitmapRoot: journal.includedBitmapRoot,
          treeSize: journal.treeSize,
          finalizedAtMs: fixedNow - 1000,
          ...mismatch,
        }),
    });

    const payload = await requestStatus(store, localRuntimeProfile());

    expect(payload?.status === 'succeeded' ? payload.result.artifactAvailability.includedBitmap : null).toBe(
      'unavailable',
    );
  });

  it('fails closed without fallback when a succeeded exact record is missing result authority', async () => {
    const runningState = buildRunningState(fixedNow - 120_000);
    const markFailed = vi.fn<MockVoteStore['markAwsFinalizationFailed']>();

    const invalidSucceededRecord = {
      sessionId,
      finalizationId,
      scenarioContext,
      state: {
        status: 'succeeded',
        finalizationId,
        queuedAtMs: runningState.queuedAtMs,
        startedAtMs: runningState.startedAtMs,
        completedAtMs: fixedNow - 5000,
      },
    } as unknown as FinalizationRecord;
    const store = buildStore(runningState, {
      getCurrentFinalizationRecord: () => Promise.resolve(invalidSucceededRecord),
      getAwsFinalizationRuntimeMetadata: () => Promise.resolve(undefined),
      markAwsFinalizationFailed: markFailed,
    });

    await expect(requestStatusResponse(store)).rejects.toThrow(
      'Succeeded finalization is missing canonical result authority',
    );

    expect(markFailed).not.toHaveBeenCalled();
  });

  it.each([buildPendingState(fixedNow - 1_000_000), buildRunningState(fixedNow - 120_000)])(
    'returns persisted $status without observing or mutating execution state',
    async (state) => {
      const markFinalizationFailed = vi.fn();
      const markFinalizationTimedOut = vi.fn();
      const getAwsFinalizationRuntimeMetadata = vi.fn().mockRejectedValue(new Error('unavailable'));
      const store = buildStore(state, {
        markFinalizationFailed,
        markFinalizationTimedOut,
        getAwsFinalizationRuntimeMetadata,
      });
      const result = await requestStatus(store);
      expect(result?.status).toBe(state.status);
      expect(result?.runtimeDiagnostics).not.toHaveProperty('orchestrator');
      expect(result?.runtimeDiagnostics.queue).not.toBeNull();
      if (state.status === 'running') expect(result?.runtimeDiagnostics.progress?.phase).toBe('running');
      expect(getAwsFinalizationRuntimeMetadata).not.toHaveBeenCalled();
      expect(markFinalizationFailed).not.toHaveBeenCalled();
      expect(markFinalizationTimedOut).not.toHaveBeenCalled();
    },
  );
});

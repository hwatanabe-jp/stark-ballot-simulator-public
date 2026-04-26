import type { VoteChoice } from '@/lib/session/types';
import type { VerificationResult, VerificationStatus } from '@/types/server';
import type { VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';
import { isRecord } from '@/lib/utils/guards';
import { addHexPrefix } from '@/lib/utils/hex';
import { RFC6962MerkleTree } from '@/lib/merkle/rfc6962-merkle-tree';
import { VOTE_CHOICES } from '@/shared/constants';
import { CURRENT_METHOD_VERSION, type CurrentZkVMJournal, computeCommitment } from '@/lib/zkvm/types';
import { VERIFICATION_CHECK_DEFINITIONS } from '@/lib/verification/verification-checks';
import { projectVerificationResultForPublicResponse } from '@/lib/verification/public-verification-result';
import type { MockState } from './state';
import type { ScenarioId } from './types';
import sessionFixture from './fixtures/json/session.post.json';
import voteFixture from './fixtures/json/vote.post.json';
import progressFixture from './fixtures/json/progress.get.json';
import finalizeAcceptedFixture from './fixtures/json/finalize.post.accepted.json';
import finalizeSyncFixture from './fixtures/json/finalize.post.sync.json';
import statusPendingFixture from './fixtures/json/sessions.status.pending.json';
import statusRunningFixture from './fixtures/json/sessions.status.running.json';
import statusSucceededFixture from './fixtures/json/sessions.status.succeeded.json';
import verifyS0Fixture from './fixtures/json/verify.get.S0.json';
import verifyS1Fixture from './fixtures/json/verify.get.S1.json';
import verifyS2Fixture from './fixtures/json/verify.get.S2.json';
import verifyS3Fixture from './fixtures/json/verify.get.S3.json';
import verifyS4Fixture from './fixtures/json/verify.get.S4.json';
import verifyS5Fixture from './fixtures/json/verify.get.S5.json';
import verificationRunFixture from './fixtures/json/verification.run.post.json';
import botDataFixture from './fixtures/json/botdata.get.json';

const BASE_COUNTS: Record<VoteChoice, number> = {
  A: 13,
  B: 12,
  C: 14,
  D: 11,
  E: 14,
};

const BASE_TOTAL = 64;

const createHex = (char: string) => `0x${char.repeat(64)}`;

const createIndexedHex = (index: number) => {
  const normalized = Math.max(0, Math.floor(index));
  return `0x${normalized.toString(16).padStart(64, '0')}`;
};

const resolveBotChoice = (botId: number): VoteChoice => {
  const choice = VOTE_CHOICES[botId % VOTE_CHOICES.length];
  return choice;
};

const resolveBotRandom = (botId: number): string => createIndexedHex(botId + 100);

const resolveBotCommitment = (electionId: string, botId: number): string => {
  const choice = resolveBotChoice(botId);
  const choiceIndex = Math.max(0, VOTE_CHOICES.indexOf(choice));
  return computeCommitment(electionId, choiceIndex, resolveBotRandom(botId));
};

const resolveBotVote = (state: MockState, botId: number) => {
  const choice = resolveBotChoice(botId);
  const random = resolveBotRandom(botId);
  const choiceIndex = Math.max(0, VOTE_CHOICES.indexOf(choice));
  const commitment = computeCommitment(state.electionId, choiceIndex, random);
  return {
    choice,
    random,
    commitment,
  };
};

const ensureVoteData = (state: MockState, overrides?: { bulletinRootAtCast?: string; now?: number }) => ({
  choice: state.voteChoice ?? 'A',
  random: state.random ?? createHex('d'),
  commitment: state.commitment ?? createHex('e'),
  voteId: state.voteId ?? '00000000-0000-4000-8000-000000000001',
  bulletinIndex: state.bulletinIndex ?? 0,
  bulletinRootAtCast: overrides?.bulletinRootAtCast ?? state.bulletinRootAtCast ?? createHex('f'),
  timestamp: state.voteTimestamp ?? overrides?.now ?? Date.now(),
});

const buildCommitments = (state: MockState, vote: ReturnType<typeof ensureVoteData>): string[] =>
  Array.from({ length: BASE_TOTAL }, (_, index) => {
    if (index === vote.bulletinIndex) {
      return vote.commitment;
    }
    return resolveBotCommitment(state.electionId, index);
  });

const buildRootHistory = (tree: RFC6962MerkleTree, treeSize: number, now: number) =>
  Array.from({ length: treeSize }, (_, index) => ({
    timestamp: now - (treeSize - (index + 1)) * 1000,
    bulletinRoot: addHexPrefix(tree.getRootAtSize(index + 1)),
    treeSize: index + 1,
  }));

const buildBulletinSnapshot = (state: MockState, now: number) => {
  const vote = ensureVoteData(state, { now });
  const commitments = buildCommitments(state, vote);
  const tree = new RFC6962MerkleTree();
  commitments.forEach((commitment) => tree.append(commitment));
  const treeSize = commitments.length;
  const castSize = Math.min(treeSize, Math.max(1, vote.bulletinIndex + 1));
  return {
    vote,
    commitments,
    tree,
    treeSize,
    bulletinRoot: addHexPrefix(tree.getRootAtSize(treeSize)),
    bulletinRootAtCast: addHexPrefix(tree.getRootAtSize(castSize)),
    rootHistory: buildRootHistory(tree, treeSize, now),
  };
};

const verifyFixtures: Record<ScenarioId, Record<string, unknown>> = {
  S0: verifyS0Fixture,
  S1: verifyS1Fixture,
  S2: verifyS2Fixture,
  S3: verifyS3Fixture,
  S4: verifyS4Fixture,
  S5: verifyS5Fixture,
};

const cloneFixture = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const ensureRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const ensureData = (payload: Record<string, unknown>): Record<string, unknown> => {
  if (isRecord(payload.data)) {
    return payload.data;
  }
  const data: Record<string, unknown> = {};
  payload.data = data;
  return data;
};

const readNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number') {
    return undefined;
  }
  return Number.isFinite(value) ? value : undefined;
};

const readRequiredNumber = (value: Record<string, unknown>, key: string, label: string): number => {
  const number = readNumber(value[key]);
  if (number === undefined) {
    throw new Error(`[mock-api] Missing current-contract numeric field ${label}.${key}`);
  }
  return number;
};

const getVerifyFixtureData = (scenarioId: ScenarioId): Record<string, unknown> => {
  const fixture = verifyFixtures[scenarioId];
  if (isRecord(fixture.data)) {
    return fixture.data;
  }
  return fixture;
};

const getAffectedBotIds = (scenarioId: ScenarioId): number[] => {
  const data = getVerifyFixtureData(scenarioId);
  const summary = isRecord(data.botVotesSummary) ? data.botVotesSummary : undefined;
  if (!summary || !Array.isArray(summary.affectedBotIds)) {
    return [];
  }
  return summary.affectedBotIds.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
};

const getTamperedCount = (scenarioId: ScenarioId): number => {
  const data = getVerifyFixtureData(scenarioId);
  const tally = isRecord(data.tally) ? data.tally : undefined;
  const count = tally ? readNumber(tally.tamperedCount) : undefined;
  return count ?? 0;
};

const getTamperSummary = (scenarioId: ScenarioId): Record<string, unknown> => {
  const data = getVerifyFixtureData(scenarioId);
  const summary = isRecord(data.tamperSummary) ? data.tamperSummary : {};
  return { ...summary };
};

const normalizeCountsRecord = (value: unknown): Record<VoteChoice, number> | null => {
  if (!isRecord(value)) {
    return null;
  }
  const record: Record<VoteChoice, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
  };
  for (const choice of VOTE_CHOICES) {
    const count = value[choice];
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      return null;
    }
    record[choice] = count;
  }
  return record;
};

const resolveScenarioTally = (scenarioId: ScenarioId): { counts: Record<VoteChoice, number>; totalVotes: number } => {
  const data = getVerifyFixtureData(scenarioId);
  const tally = isRecord(data.tally) ? data.tally : undefined;
  const countsSource = isRecord(tally) ? tally.counts : undefined;
  const counts = normalizeCountsRecord(isRecord(countsSource) ? countsSource : undefined) ?? { ...BASE_COUNTS };
  const totalVotes =
    readNumber(isRecord(tally) ? tally.totalVotes : undefined) ??
    Object.values(counts).reduce((sum, value) => sum + value, 0);
  return { counts, totalVotes };
};

const isCurrentContractVerifiedTally = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length === VOTE_CHOICES.length &&
  value.every((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0);

const resolveScenarioVerifiedTally = (scenarioId: ScenarioId): number[] => {
  const data = getVerifyFixtureData(scenarioId);
  const verified = data.verifiedTally;
  if (isCurrentContractVerifiedTally(verified)) {
    return [...verified];
  }
  if (verified === undefined) {
    throw new Error(`[mock-api] Missing current-contract verifiedTally in verify fixture ${scenarioId}`);
  }
  throw new Error(`[mock-api] Invalid current-contract verifiedTally in verify fixture ${scenarioId}`);
};

const resolveScenarioMetrics = (
  scenarioId: ScenarioId,
): {
  missingSlots: number;
  invalidPresentedSlots: number;
  rejectedRecords: number;
  excludedSlots: number;
  seenIndicesCount: number;
  totalExpected: number;
} => {
  const data = getVerifyFixtureData(scenarioId);
  const totalExpected = readRequiredNumber(data, 'totalExpected', `verify fixture ${scenarioId}`);
  const missingSlots = readRequiredNumber(data, 'missingSlots', `verify fixture ${scenarioId}`);
  const invalidPresentedSlots = readRequiredNumber(data, 'invalidPresentedSlots', `verify fixture ${scenarioId}`);
  const rejectedRecords = readRequiredNumber(data, 'rejectedRecords', `verify fixture ${scenarioId}`);
  const excludedSlots = readRequiredNumber(data, 'excludedSlots', `verify fixture ${scenarioId}`);
  const seenIndicesCount = readRequiredNumber(data, 'seenIndicesCount', `verify fixture ${scenarioId}`);
  if (excludedSlots !== missingSlots + invalidPresentedSlots) {
    throw new Error(`[mock-api] Current-contract excludedSlots drift in verify fixture ${scenarioId}`);
  }

  return {
    missingSlots,
    invalidPresentedSlots,
    rejectedRecords,
    excludedSlots,
    seenIndicesCount,
    totalExpected,
  };
};

function buildScenarioJournal(
  state: MockState,
  snapshot: ReturnType<typeof buildBulletinSnapshot>,
  scenarioId: ScenarioId,
  imageId: string,
): CurrentZkVMJournal {
  const verifiedTally = resolveScenarioVerifiedTally(scenarioId);
  const metrics = resolveScenarioMetrics(scenarioId);
  const validVotes = verifiedTally.reduce((sum, count) => sum + count, 0);
  const totalVotes = validVotes + metrics.rejectedRecords;

  return {
    electionId: state.electionId,
    electionConfigHash: state.electionConfigHash,
    bulletinRoot: snapshot.bulletinRoot,
    treeSize: snapshot.treeSize,
    totalExpected: metrics.totalExpected,
    sthDigest: createHex('1'),
    verifiedTally,
    totalVotes,
    validVotes,
    invalidVotes: metrics.rejectedRecords,
    seenIndicesCount: metrics.seenIndicesCount,
    missingSlots: metrics.missingSlots,
    invalidPresentedSlots: metrics.invalidPresentedSlots,
    rejectedRecords: metrics.rejectedRecords,
    seenBitmapRoot: createHex('5'),
    includedBitmapRoot: createHex('2'),
    excludedSlots: metrics.excludedSlots,
    inputCommitment: createHex('3'),
    methodVersion: CURRENT_METHOD_VERSION,
    imageId,
  };
}

const mapStarkStepStatus = (status: VerificationStatus): 'success' | 'failed' | 'running' | 'not_run' => {
  if (status === 'success' || status === 'dev_mode') {
    return 'success';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'running') {
    return 'running';
  }
  return 'not_run';
};

const normalizeVerificationStatus = (value: unknown): VerificationStatus => {
  if (value === 'success' || value === 'failed' || value === 'dev_mode' || value === 'not_run' || value === 'running') {
    return value;
  }
  return 'not_run';
};

export const buildSessionResponse = (state: MockState): Record<string, unknown> => {
  const payload = cloneFixture(sessionFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data.sessionId = state.sessionId;
  data.capabilityToken = state.capabilityToken;
  data.contractGeneration = state.contractGeneration;
  data.electionId = state.electionId;
  data.electionConfigHash = state.electionConfigHash;
  data.logId = state.logId;
  return payload;
};

export const buildVoteResponse = (state: MockState): Record<string, unknown> => {
  const now = state.voteTimestamp ?? Date.now();
  const snapshot = buildBulletinSnapshot(state, now);
  const vote = ensureVoteData(state, { bulletinRootAtCast: snapshot.bulletinRootAtCast, now });
  const payload = cloneFixture(voteFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data.voteId = vote.voteId;
  data.commitment = vote.commitment;
  data.bulletinIndex = vote.bulletinIndex;
  data.bulletinRootAtCast = vote.bulletinRootAtCast;
  data.timestamp = vote.timestamp;
  return payload;
};

export const buildProgressResponse = (state: MockState, now: number): Record<string, unknown> => {
  const startedAt = state.botVotingStartedAt ?? now;
  const elapsed = now - startedAt;
  const progress = Math.min(1, elapsed / 10000);
  const count = Math.min(BASE_TOTAL - 1, Math.floor(progress * (BASE_TOTAL - 1)));
  const completed = elapsed >= 10000;

  const payload = cloneFixture(progressFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data.count = completed ? BASE_TOTAL - 1 : count;
  data.total = BASE_TOTAL - 1;
  data.completed = completed;
  data.userVoted = true;
  data.finalized = false;
  data.updatedAt = now;
  data.animationSeed = state.animationSeed;
  return payload;
};

export const buildFinalizeAcceptedResponse = (
  state: MockState,
  queuedAt: number,
  estimatedDurationMs: number,
): Record<string, unknown> => {
  const payload = cloneFixture(finalizeAcceptedFixture) as Record<string, unknown>;
  payload.executionId = 'mock-execution-001';
  payload.statusUrl = `/api/sessions/${state.sessionId}/status`;
  const stateRecord = ensureRecord(payload.state);
  stateRecord.status = 'pending';
  stateRecord.executionId = 'mock-execution-001';
  stateRecord.queuedAt = queuedAt;
  payload.state = stateRecord;
  const queueRecord = ensureRecord(payload.queue);
  queueRecord.position = 1;
  queueRecord.depth = 1;
  queueRecord.concurrencyLimit = 2;
  queueRecord.estimatedStartAt = queuedAt + 2000;
  queueRecord.estimatedDurationMs = estimatedDurationMs;
  queueRecord.estimatedCompletionAt = queuedAt + 2000 + estimatedDurationMs;
  payload.queue = queueRecord;
  return payload;
};

function buildFinalizationSyncData(state: MockState, now: number): Record<string, unknown> {
  const snapshot = buildBulletinSnapshot(state, now);
  const vote = ensureVoteData(state, { bulletinRootAtCast: snapshot.bulletinRootAtCast, now });
  const scenarioTally = resolveScenarioTally(state.scenarioId);
  const payload = cloneFixture(finalizeSyncFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data.sessionId = state.sessionId;
  const tally = ensureRecord(data.tally);
  tally.counts = scenarioTally.counts;
  tally.totalVotes = scenarioTally.totalVotes;
  tally.tamperedCount = getTamperedCount(state.scenarioId);
  data.tally = tally;
  const imageId = typeof data.imageId === 'string' ? data.imageId : createHex('4');
  const journal = buildScenarioJournal(state, snapshot, state.scenarioId, imageId);
  data.bulletinRoot = journal.bulletinRoot;
  data.treeSize = journal.treeSize;
  data.sthDigest = journal.sthDigest;
  data.seenBitmapRoot = journal.seenBitmapRoot;
  data.includedBitmapRoot = journal.includedBitmapRoot;
  data.inputCommitment = journal.inputCommitment;
  data.imageId = imageId;
  data.verificationStatus = data.verificationStatus ?? 'success';
  data.verifiedTally = [...journal.verifiedTally];
  const voteReceipt = ensureRecord(data.voteReceipt);
  voteReceipt.voteId = vote.voteId;
  voteReceipt.commitment = vote.commitment;
  voteReceipt.bulletinIndex = vote.bulletinIndex;
  voteReceipt.bulletinRootAtCast = vote.bulletinRootAtCast;
  voteReceipt.timestamp = vote.timestamp;
  voteReceipt.inputCommitment = createHex('3');
  data.voteReceipt = voteReceipt;
  const userVote = ensureRecord(data.userVote);
  userVote.commitment = vote.commitment;
  userVote.voteId = vote.voteId;
  const proof = ensureRecord(userVote.proof);
  proof.leafIndex = vote.bulletinIndex;
  const treeSizeAtCast = Math.min(snapshot.treeSize, vote.bulletinIndex + 1);
  const inclusion = snapshot.tree.getInclusionProof(vote.bulletinIndex, treeSizeAtCast);
  proof.merklePath = inclusion.proofNodes.map((node) => addHexPrefix(node));
  proof.treeSize = treeSizeAtCast;
  proof.bulletinRootAtCast = vote.bulletinRootAtCast;
  userVote.proof = proof;
  data.userVote = userVote;
  data.tamperSummary = getTamperSummary(state.scenarioId);
  delete data.s3BundleKey;
  delete data.s3BundleUrl;
  delete data.s3UploadedAt;
  delete data.s3BundleExpiresAt;
  data.missingSlots = journal.missingSlots;
  data.invalidPresentedSlots = journal.invalidPresentedSlots;
  data.rejectedRecords = journal.rejectedRecords;
  data.excludedSlots = journal.excludedSlots;
  data.seenIndicesCount = journal.seenIndicesCount;
  data.totalExpected = journal.totalExpected;
  data.journal = journal;
  return data;
}

export const buildFinalizationResult = (state: MockState): Record<string, unknown> => {
  return buildFinalizationSyncData(state, Date.now());
};

export const buildFinalizationStatusResponse = (state: MockState, now: number): Record<string, unknown> => {
  const queuedAt = state.finalizationQueuedAt ?? now;
  const startedAt = state.finalizationStartedAt ?? queuedAt + 2000;
  const completedAt = state.finalizationCompletedAt ?? startedAt + 20000;
  const estimatedDurationMs = completedAt - startedAt;
  const hasFailure = typeof state.finalizationFailedAt === 'number';
  const status = hasFailure ? 'failed' : now < startedAt ? 'pending' : now < completedAt ? 'running' : 'succeeded';

  const payload =
    status === 'pending'
      ? (cloneFixture(statusPendingFixture) as Record<string, unknown>)
      : status === 'running'
        ? (cloneFixture(statusRunningFixture) as Record<string, unknown>)
        : status === 'failed'
          ? (cloneFixture(statusRunningFixture) as Record<string, unknown>)
          : (cloneFixture(statusSucceededFixture) as Record<string, unknown>);

  payload.sessionId = state.sessionId;
  const finalizationState = ensureRecord(payload.finalizationState);
  finalizationState.status = status;
  finalizationState.executionId = 'mock-execution-001';
  finalizationState.queuedAt = queuedAt;
  if (status !== 'pending') {
    finalizationState.startedAt = startedAt;
  }
  if (status === 'succeeded') {
    finalizationState.completedAt = completedAt;
  }
  if (status === 'failed') {
    finalizationState.failedAt = state.finalizationFailedAt ?? now;
    finalizationState.error = state.finalizationError ?? {
      code: 'USER_CANCELLED',
      message: 'Cancelled by user request',
    };
  }
  payload.finalizationState = finalizationState;

  const queue = ensureRecord(payload.queue);
  queue.position = status === 'pending' ? 1 : 0;
  queue.depth = status === 'succeeded' || status === 'failed' ? 0 : 1;
  queue.concurrencyLimit = 2;
  queue.estimatedStartAt = startedAt;
  queue.estimatedDurationMs = estimatedDurationMs;
  queue.estimatedCompletionAt = startedAt + estimatedDurationMs;
  payload.queue = queue;

  if (status === 'running') {
    const ratio = Math.min(1, Math.max(0, (now - startedAt) / estimatedDurationMs));
    const percent = Math.min(99, Math.max(1, Math.round(ratio * 99)));
    payload.progress = {
      phase: 'running',
      source: 'derived',
      percent,
      updatedAt: now,
    };
  } else {
    delete payload.progress;
  }

  payload.finalizationResult = status === 'succeeded' ? buildFinalizationStatusResult(state, now) : null;
  payload.stepFunctions = null;
  payload.asyncFinalizationMode = 'enabled';
  return payload;
};

function buildFinalizationStatusResult(state: MockState, now: number): Record<string, unknown> {
  const result = buildFinalizationSyncData(state, now);
  const journal = result.journal as CurrentZkVMJournal;
  const imageId = typeof result.imageId === 'string' ? result.imageId : createHex('4');
  const verificationResultAuthority = isRecord(result.verificationResult)
    ? (result.verificationResult as unknown as VerificationResult)
    : undefined;
  const verificationResult = verificationResultAuthority
    ? projectVerificationResultForPublicResponse(verificationResultAuthority)
    : undefined;

  return {
    tally: result.tally,
    bulletinRoot: journal.bulletinRoot,
    receiptPublication: result.receiptPublication,
    imageId,
    verifiedTally: [...journal.verifiedTally],
    tamperDetected: result.tamperDetected,
    scenarios: result.scenarios,
    journal,
    electionManifest: result.electionManifest,
    closeStatement: result.closeStatement,
    bitmapProofSource: result.bitmapProofSource,
    missingSlots: journal.missingSlots,
    invalidPresentedSlots: journal.invalidPresentedSlots,
    rejectedRecords: journal.rejectedRecords,
    totalExpected: journal.totalExpected,
    treeSize: journal.treeSize,
    excludedSlots: journal.excludedSlots,
    sthDigest: journal.sthDigest,
    seenBitmapRoot: journal.seenBitmapRoot,
    includedBitmapRoot: journal.includedBitmapRoot,
    inputCommitment: journal.inputCommitment,
    seenIndicesCount: journal.seenIndicesCount,
    verificationResult,
    verificationExecutionId: result.verificationExecutionId,
    tamperSummary: result.tamperSummary,
  };
}

export const buildVerifyResponse = (
  state: MockState,
  now: number,
  options?: { includeJournal?: boolean },
): Record<string, unknown> => {
  const snapshot = buildBulletinSnapshot(state, now);
  const vote = ensureVoteData(state, { bulletinRootAtCast: snapshot.bulletinRootAtCast, now });
  const payload = cloneFixture(verifyFixtures[state.scenarioId]);
  const data = ensureData(payload);
  data.electionId = state.electionId;
  data.electionConfigHash = state.electionConfigHash;
  data.logId = state.logId;
  data.scenarioId = state.scenarioId;

  const tally = ensureRecord(data.tally);
  const scenarioTally = resolveScenarioTally(state.scenarioId);
  tally.counts = scenarioTally.counts;
  tally.totalVotes = scenarioTally.totalVotes;
  tally.tamperedCount = getTamperedCount(state.scenarioId);
  data.tally = tally;

  const resolvedStatus = normalizeVerificationStatus(state.verificationStatus ?? data.verificationStatus);
  data.verificationStatus = resolvedStatus;
  const report = ensureRecord(data.verificationReport);
  if (state.verificationReport) {
    data.verificationReport = { ...report, ...state.verificationReport, status: state.verificationReport.status };
  } else {
    report.status = resolvedStatus;
    data.verificationReport = report;
  }

  if (Array.isArray(data.verificationSteps)) {
    const steps = data.verificationSteps as Array<Record<string, unknown>>;
    const updatedSteps = steps.map((step) => {
      const stepId = typeof step.id === 'string' ? step.id : null;
      if (stepId !== 'stark_verification') {
        return step;
      }
      return { ...step, status: mapStarkStepStatus(resolvedStatus) };
    });
    data.verificationSteps = updatedSteps;
  }

  const stepStatusMap: Record<VerificationStepId, VerificationStepStatus> = {
    cast_as_intended: 'pending',
    recorded_as_cast: 'pending',
    counted_as_recorded: 'pending',
    stark_verification: 'pending',
  };

  if (Array.isArray(data.verificationSteps)) {
    const steps = data.verificationSteps as Array<Record<string, unknown>>;
    steps.forEach((step) => {
      const stepId = step.id;
      const status = step.status;
      if (
        (stepId === 'cast_as_intended' ||
          stepId === 'recorded_as_cast' ||
          stepId === 'counted_as_recorded' ||
          stepId === 'stark_verification') &&
        typeof status === 'string'
      ) {
        stepStatusMap[stepId] = status as VerificationStepStatus;
      }
    });
  }

  const resolveCheckStatus = (category: VerificationStepId, evidence: string): VerificationStepStatus => {
    const baseStatus = stepStatusMap[category];
    if (evidence === 'zk') {
      return baseStatus === 'success' || baseStatus === 'failed' ? baseStatus : 'pending';
    }
    return baseStatus;
  };

  data.verificationChecks = VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    status: resolveCheckStatus(definition.category, definition.evidence),
    evidence: definition.evidence,
    inputs: definition.inputs,
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));

  delete data.s3BundleUrl;
  delete data.s3BundleKey;
  delete data.s3UploadedAt;
  delete data.s3BundleExpiresAt;
  const imageId = typeof data.imageId === 'string' ? data.imageId : createHex('4');
  const journal = buildScenarioJournal(state, snapshot, state.scenarioId, imageId);
  const scenarioMetrics = resolveScenarioMetrics(state.scenarioId);
  data.imageId = imageId;
  data.verifiedTally = [...journal.verifiedTally];
  data.totalExpected = journal.totalExpected;
  data.treeSize = journal.treeSize;
  data.bulletinRoot = journal.bulletinRoot;
  data.sthDigest = journal.sthDigest;
  data.seenBitmapRoot = journal.seenBitmapRoot;
  data.includedBitmapRoot = journal.includedBitmapRoot;
  data.inputCommitment = journal.inputCommitment;

  const voteReceipt = ensureRecord(data.voteReceipt);
  voteReceipt.voteId = vote.voteId;
  voteReceipt.commitment = vote.commitment;
  voteReceipt.bulletinIndex = vote.bulletinIndex;
  voteReceipt.bulletinRootAtCast = vote.bulletinRootAtCast;
  voteReceipt.timestamp = vote.timestamp;
  voteReceipt.inputCommitment = createHex('3');
  data.voteReceipt = voteReceipt;

  const userVote = ensureRecord(data.userVote);
  userVote.vote = vote.choice;
  userVote.commitment = vote.commitment;
  userVote.random = vote.random;
  userVote.voteId = vote.voteId;
  const proof = ensureRecord(userVote.proof);
  proof.leafIndex = vote.bulletinIndex;
  const treeSizeAtCast = Math.min(snapshot.treeSize, vote.bulletinIndex + 1);
  const inclusion = snapshot.tree.getInclusionProof(vote.bulletinIndex, treeSizeAtCast);
  proof.merklePath = inclusion.proofNodes.map((node) => addHexPrefix(node));
  proof.treeSize = treeSizeAtCast;
  proof.bulletinRootAtCast = vote.bulletinRootAtCast;
  userVote.proof = proof;
  data.userVote = userVote;

  data.verificationExecutionId = data.verificationExecutionId ?? 'mock-verification-001';
  data.tamperSummary = getTamperSummary(state.scenarioId);
  data.missingSlots = scenarioMetrics.missingSlots;
  data.invalidPresentedSlots = scenarioMetrics.invalidPresentedSlots;
  data.rejectedRecords = scenarioMetrics.rejectedRecords;
  data.totalExpected = scenarioMetrics.totalExpected;
  data.excludedSlots = scenarioMetrics.excludedSlots;
  data.seenIndicesCount = scenarioMetrics.seenIndicesCount;

  const includeJournal = options?.includeJournal ?? false;
  if (includeJournal) {
    if (data.journalStatus === 'unavailable') {
      delete data.journal;
    } else {
      data.journalStatus = 'available';
      data.journal = journal;
    }
  } else {
    data.journalStatus = data.journalStatus ?? 'omitted';
    if (data.journalStatus !== 'available') {
      delete data.journal;
    }
  }

  return payload;
};

export const buildVerificationRunResponse = (): Record<string, unknown> => {
  const payload = cloneFixture(verificationRunFixture) as Record<string, unknown>;
  return payload;
};

export const buildBotDataResponse = (state: MockState, botId: number): Record<string, unknown> | null => {
  const affectedBotIds = getAffectedBotIds(state.scenarioId);
  if (affectedBotIds.length === 0 || !affectedBotIds.includes(botId)) {
    return null;
  }

  const now = Date.now();
  const snapshot = buildBulletinSnapshot(state, now);
  if (botId < 0 || botId >= snapshot.treeSize) {
    return null;
  }

  const payload = cloneFixture(botDataFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  const botVote = resolveBotVote(state, botId);
  data.id = botId;
  data.vote = botVote.choice;
  data.random = botVote.random;
  data.commitment = botVote.commitment;
  data.voteId = `bot-${botId}`;
  data.timestamp = now;
  const treeSizeAtCast = Math.min(snapshot.treeSize, botId + 1);
  const proof = ensureRecord(data.proof);
  proof.leafIndex = botId;
  const inclusion = snapshot.tree.getInclusionProof(botId, treeSizeAtCast);
  proof.merklePath = inclusion.proofNodes.map((node) => addHexPrefix(node));
  proof.treeSize = treeSizeAtCast;
  proof.bulletinRootAtCast = addHexPrefix(snapshot.tree.getRootAtSize(treeSizeAtCast));
  data.proof = proof;
  return payload;
};

export const buildBulletinResponse = (
  state: MockState,
  options?: { offset?: number; limit?: number; now?: number },
): Record<string, unknown> => {
  const now = options?.now ?? Date.now();
  const snapshot = buildBulletinSnapshot(state, now);
  const offset = typeof options?.offset === 'number' ? Math.max(0, options.offset) : 0;
  const limit =
    typeof options?.limit === 'number' && Number.isFinite(options.limit) ? Math.max(1, options.limit) : undefined;

  const hasPaging = typeof options?.offset === 'number' || typeof options?.limit === 'number';
  const sliceLimit = limit ?? snapshot.treeSize - offset;
  const commitments = snapshot.commitments.slice(offset, offset + sliceLimit);
  const payload: Record<string, unknown> = {
    commitments,
    bulletinRoot: snapshot.bulletinRoot,
    treeSize: snapshot.treeSize,
    timestamp: now,
    rootHistory: snapshot.rootHistory,
  };

  if (hasPaging) {
    const nextOffset = offset + sliceLimit;
    const hasMore = nextOffset < snapshot.treeSize;
    payload.nextOffset = hasMore ? nextOffset : null;
    payload.hasMore = hasMore;
  }

  return payload;
};

export const buildBulletinProofResponse = (
  state: MockState,
  voteId: string,
  options?: { now?: number },
): Record<string, unknown> | null => {
  if (!voteId) {
    return null;
  }

  const now = options?.now ?? Date.now();
  const snapshot = buildBulletinSnapshot(state, now);
  const vote = ensureVoteData(state, { bulletinRootAtCast: snapshot.bulletinRootAtCast, now });

  let leafIndex: number | null = null;
  if (voteId === vote.voteId) {
    leafIndex = vote.bulletinIndex;
  } else if (voteId.startsWith('bot-')) {
    const botId = Number(voteId.replace('bot-', ''));
    if (Number.isFinite(botId)) {
      const affectedBotIds = getAffectedBotIds(state.scenarioId);
      if (affectedBotIds.includes(botId)) {
        leafIndex = botId;
      }
    }
  }

  if (leafIndex === null || leafIndex < 0 || leafIndex >= snapshot.treeSize) {
    return null;
  }

  const treeSizeAtCast = Math.min(snapshot.treeSize, leafIndex + 1);
  const inclusion = snapshot.tree.getInclusionProof(leafIndex, treeSizeAtCast);

  return {
    voteId,
    proof: {
      leafIndex,
      merklePath: inclusion.proofNodes.map((node) => addHexPrefix(node)),
      treeSize: treeSizeAtCast,
      bulletinRootAtCast: addHexPrefix(snapshot.tree.getRootAtSize(treeSizeAtCast)),
    },
  };
};

export const buildConsistencyProofResponse = (
  state: MockState,
  options: { oldSize: number; newSize: number; now?: number },
): Record<string, unknown> => {
  const now = options.now ?? Date.now();
  const snapshot = buildBulletinSnapshot(state, now);
  const proof = snapshot.tree.getConsistencyProof(options.oldSize, options.newSize);

  return {
    oldSize: options.oldSize,
    newSize: options.newSize,
    rootAtOldSize: addHexPrefix(snapshot.tree.getRootAtSize(options.oldSize)),
    rootAtNewSize: addHexPrefix(snapshot.tree.getRootAtSize(options.newSize)),
    proofNodes: proof.proofNodes,
    oldSubtreeHashes: proof.oldSubtreeHashes,
    appendSubtreeHashes: proof.appendSubtreeHashes,
    timestamp: now,
  };
};

export const buildFinalizeCancelResponse = (
  state: MockState,
  options: { executionId: string; reason?: string; now?: number },
): Record<string, unknown> => {
  const now = options.now ?? Date.now();
  const reason = options.reason?.trim().length ? options.reason.trim() : 'Cancelled by user request';
  const statePayload: Record<string, unknown> = {
    status: 'failed',
    executionId: options.executionId,
    queuedAt: state.finalizationQueuedAt ?? now,
    failedAt: state.finalizationFailedAt ?? now,
    error: {
      code: 'USER_CANCELLED',
      message: reason,
    },
  };

  if (typeof state.finalizationStartedAt === 'number') {
    statePayload.startedAt = state.finalizationStartedAt;
  }

  return { state: statePayload };
};

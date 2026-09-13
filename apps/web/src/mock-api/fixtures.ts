import type { VoteChoice } from '@stark-ballot/web/session/types';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import type { VerificationStepId, VerificationStepStatus } from '@stark-ballot/web/knowledge';
import { isRecord } from '@stark-ballot/validation/unknown-value-guards';
import { addHexPrefix } from '@stark-ballot/crypto-primitives';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';
import { VOTE_CHOICES } from '@stark-ballot/verification/shared/constants';
import {
  CURRENT_METHOD_VERSION,
  type CurrentZkVMJournal,
  type VerifiedTally,
  computeCommitment,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import { computeIncludedBitmapRootHex } from '@stark-ballot/zkvm-contract/zkvm/bitmap-core';
import {
  VerificationResourceResponseSchema,
  type AvailableVerificationResource,
} from '@stark-ballot/api-contract/schemas/verification';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import { resolveFailClosedVerificationStatus } from '@stark-ballot/verification/fail-closed-status';
import { isCheckStatusZkGateControlled, resolveZkGateStatus } from '@stark-ballot/verification/check-evaluator';
import {
  sanitizeVerificationReportForPublicResponse,
  type PublicVerificationReport,
} from '@stark-ballot/verification/public-result';
import type { VerificationReport } from '@stark-ballot/verification/shared/types';
import { deriveFinalizationProgress } from '@stark-ballot/application/finalize/finalization-progress';
import type { MockState } from './state';
import type { ScenarioId } from './types';
import sessionFixture from './fixtures/json/sessions.post.json';
import voteFixture from './fixtures/json/sessions.votes.post.json';
import progressFixture from './fixtures/json/sessions.progress.get.json';
import finalizationSucceededResultFixture from './fixtures/json/finalizations.succeeded.result.json';
import verifyS0Fixture from './fixtures/json/verification.get.S0.json';
import verifyS1Fixture from './fixtures/json/verification.get.S1.json';
import verifyS2Fixture from './fixtures/json/verification.get.S2.json';
import verifyS3Fixture from './fixtures/json/verification.get.S3.json';
import verifyS4Fixture from './fixtures/json/verification.get.S4.json';
import verifyS5Fixture from './fixtures/json/verification.get.S5.json';
import verificationRunFixture from './fixtures/json/verification.post.json';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

const BASE_TOTAL = 64;
export const MOCK_FINALIZATION_ID = 'mock-finalization-001';
const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MOCK_FIXTURE_REQUEST_ID = 'mock-fixture-request-id';

function withFixtureMeta(payload: Record<string, unknown>): Record<string, unknown> {
  payload['meta'] = { requestId: MOCK_FIXTURE_REQUEST_ID };
  return payload;
}

function fixtureEnvelope(data: Record<string, unknown>, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data,
    meta: { requestId: MOCK_FIXTURE_REQUEST_ID, ...meta },
  };
}

const createHex = (char: string) => `0x${char.repeat(64)}`;

const createIndexedHex = (index: number) => {
  const normalized = Math.max(0, Math.floor(index));
  return `0x${normalized.toString(16).padStart(64, '0')}`;
};

const resolveBotChoice = (botId: number): VoteChoice => {
  const choice = VOTE_CHOICES[botId % VOTE_CHOICES.length];
  return choice ?? 'A';
};

const resolveBotRandom = (botId: number): string => createIndexedHex(botId + 100);

const resolveBotCommitment = (electionId: string, botId: number): string => {
  const choice = resolveBotChoice(botId);
  const choiceIndex = Math.max(0, VOTE_CHOICES.indexOf(choice));
  return computeCommitment(electionId, choiceIndex, resolveBotRandom(botId));
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
    recordedAtMs: now - (treeSize - (index + 1)) * 1000,
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

const verifyFixtures: Record<ScenarioId, unknown> = {
  S0: verifyS0Fixture,
  S1: verifyS1Fixture,
  S2: verifyS2Fixture,
  S3: verifyS3Fixture,
  S4: verifyS4Fixture,
  S5: verifyS5Fixture,
};

const cloneFixture = <T>(value: T): T => structuredClone(value);

const ensureRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const ensureData = (payload: Record<string, unknown>): Record<string, unknown> => {
  if (isRecord(payload['data'])) {
    return payload['data'];
  }
  const data: Record<string, unknown> = {};
  payload['data'] = data;
  return data;
};

const getVerifyFixtureData = (scenarioId: ScenarioId): AvailableVerificationResource => {
  const parsed = VerificationResourceResponseSchema.parse(verifyFixtures[scenarioId]);
  if (parsed.data.availability !== 'available') {
    throw new Error(`[mock-api] Expected available canonical verification fixture ${scenarioId}`);
  }
  if (parsed.data.presentation.scenarioId !== scenarioId) {
    throw new Error(`[mock-api] Verification fixture scenario mismatch for ${scenarioId}`);
  }
  return parsed.data;
};

const getAffectedBotIds = (scenarioId: ScenarioId): number[] => {
  const fixture = getVerifyFixtureData(scenarioId);
  return [...(fixture.presentation.botVotesSummary?.affectedBotIds ?? [])];
};

const getTamperedCount = (scenarioId: ScenarioId): number => {
  return getVerifyFixtureData(scenarioId).presentation.tally.tamperedCount;
};

const getTamperSummary = (scenarioId: ScenarioId): Record<string, unknown> => {
  return cloneFixture(getVerifyFixtureData(scenarioId).presentation.tamperSummary ?? {});
};

const resolveScenarioTally = (scenarioId: ScenarioId): { counts: Record<VoteChoice, number>; totalVotes: number } => {
  const tally = getVerifyFixtureData(scenarioId).presentation.tally;
  return {
    counts: { ...tally.counts },
    totalVotes: tally.totalVotes,
  };
};

function cloneVerifiedTally(tally: VerifiedTally): VerifiedTally {
  return [tally[0], tally[1], tally[2], tally[3], tally[4]];
}

const resolveScenarioVerifiedTally = (scenarioId: ScenarioId): VerifiedTally => {
  return cloneVerifiedTally(getVerifyFixtureData(scenarioId).proofAuthority.verifiedTally);
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
  const authority = getVerifyFixtureData(scenarioId).proofAuthority;
  const { totalExpected, missingSlots, invalidPresentedSlots, rejectedRecords, excludedSlots, seenIndicesCount } =
    authority;
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

export interface MockBitmapEvidence {
  includedBitmap: boolean[];
  includedBitmapRoot: string;
  seenBitmap: boolean[];
  seenBitmapRoot: string;
  treeSize: number;
}

export function buildMockBitmapEvidence(state: MockState, treeSize: number): MockBitmapEvidence {
  const metrics = resolveScenarioMetrics(state.scenarioId);
  if (!Number.isSafeInteger(treeSize) || treeSize <= 0 || treeSize !== metrics.totalExpected) {
    throw new Error(`[mock-api] Bitmap tree size drift for scenario ${state.scenarioId}`);
  }
  if (metrics.seenIndicesCount !== treeSize - metrics.missingSlots) {
    throw new Error(`[mock-api] Bitmap seen-index count drift for scenario ${state.scenarioId}`);
  }

  const userVoteIndex = ensureVoteData(state).bulletinIndex;
  const missingIndices = new Set<number>();
  const addMissingIndex = (index: number): void => {
    if (Number.isSafeInteger(index) && index >= 0 && index < treeSize && missingIndices.size < metrics.missingSlots) {
      missingIndices.add(index);
    }
  };

  if (state.scenarioId === 'S1') {
    addMissingIndex(userVoteIndex);
  } else {
    getAffectedBotIds(state.scenarioId).forEach(addMissingIndex);
  }
  for (let index = 0; index < treeSize && missingIndices.size < metrics.missingSlots; index += 1) {
    if (index !== userVoteIndex) {
      addMissingIndex(index);
    }
  }
  for (let index = 0; index < treeSize && missingIndices.size < metrics.missingSlots; index += 1) {
    addMissingIndex(index);
  }
  if (missingIndices.size !== metrics.missingSlots) {
    throw new Error(`[mock-api] Bitmap missing-slot projection failed for scenario ${state.scenarioId}`);
  }

  const seenBitmap = Array.from({ length: treeSize }, (_, index) => !missingIndices.has(index));
  const includedBitmap = [...seenBitmap];
  let invalidSlotsRemaining = metrics.invalidPresentedSlots;
  for (let index = treeSize - 1; index >= 0 && invalidSlotsRemaining > 0; index -= 1) {
    if (index !== userVoteIndex && includedBitmap[index]) {
      includedBitmap[index] = false;
      invalidSlotsRemaining -= 1;
    }
  }
  if (invalidSlotsRemaining > 0 && includedBitmap[userVoteIndex]) {
    includedBitmap[userVoteIndex] = false;
    invalidSlotsRemaining -= 1;
  }
  if (invalidSlotsRemaining !== 0) {
    throw new Error(`[mock-api] Bitmap invalid-slot projection failed for scenario ${state.scenarioId}`);
  }

  const validVotes = resolveScenarioVerifiedTally(state.scenarioId).reduce((sum, count) => sum + count, 0);
  if (includedBitmap.filter(Boolean).length !== validVotes) {
    throw new Error(`[mock-api] Bitmap included-vote count drift for scenario ${state.scenarioId}`);
  }

  return {
    includedBitmap,
    includedBitmapRoot: computeIncludedBitmapRootHex(includedBitmap),
    seenBitmap,
    seenBitmapRoot: computeIncludedBitmapRootHex(seenBitmap),
    treeSize,
  };
}

function buildScenarioJournal(
  state: MockState,
  snapshot: ReturnType<typeof buildBulletinSnapshot>,
  scenarioId: ScenarioId,
  imageId: string,
): CurrentZkVMJournal {
  const verifiedTally = resolveScenarioVerifiedTally(scenarioId);
  const metrics = resolveScenarioMetrics(scenarioId);
  const bitmapEvidence = buildMockBitmapEvidence(state, snapshot.treeSize);
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
    seenBitmapRoot: bitmapEvidence.seenBitmapRoot,
    includedBitmapRoot: bitmapEvidence.includedBitmapRoot,
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

function buildMockPublicVerificationReport(
  status: Exclude<VerificationStatus, 'not_run' | 'running'>,
  imageId: string,
  now: number,
  overrides?: MockState['verificationReport'],
): PublicVerificationReport {
  const common = {
    verifier_version: 'mock-verifier-service',
    verified_at: new Date(now).toISOString(),
    duration_ms: overrides?.duration_ms ?? 0,
    expected_image_id: imageId,
  };
  let report: VerificationReport;
  switch (status) {
    case 'success':
      report = {
        status,
        ...common,
        receipt_image_id: imageId,
        dev_mode_receipt: false,
      };
      break;
    case 'dev_mode':
      report = {
        status,
        ...common,
        receipt_image_id: imageId,
        dev_mode_receipt: true,
        ...(overrides?.errors && overrides.errors.length > 0 ? { errors: overrides.errors } : {}),
      };
      break;
    case 'failed':
      report = {
        status,
        ...common,
        receipt_image_id: null,
        dev_mode_receipt: false,
        errors: overrides?.errors && overrides.errors.length > 0 ? overrides.errors : ['Verification failed'],
      };
      break;
  }
  return sanitizeVerificationReportForPublicResponse(report);
}

export const buildSessionResponse = (state: MockState): Record<string, unknown> => {
  const payload = cloneFixture(sessionFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data['sessionId'] = state.sessionId;
  data['capabilityToken'] = state.capabilityToken;
  data['electionId'] = state.electionId;
  data['electionConfigHash'] = state.electionConfigHash;
  data['logId'] = state.logId;
  return withFixtureMeta(payload);
};

export const buildVoteResponse = (state: MockState): Record<string, unknown> => {
  const now = state.voteTimestamp ?? Date.now();
  const snapshot = buildBulletinSnapshot(state, now);
  const vote = ensureVoteData(state, { bulletinRootAtCast: snapshot.bulletinRootAtCast, now });
  const payload = cloneFixture(voteFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data['voteId'] = vote.voteId;
  data['commitment'] = vote.commitment;
  data['bulletinIndex'] = vote.bulletinIndex;
  data['bulletinRootAtCast'] = vote.bulletinRootAtCast;
  data['castAtMs'] = vote.timestamp;
  return withFixtureMeta(payload);
};

export const buildProgressResponse = (state: MockState, now: number): Record<string, unknown> => {
  const startedAt = state.botVotingStartedAt ?? now;
  const elapsed = now - startedAt;
  const progress = Math.min(1, elapsed / 10000);
  const count = Math.min(BASE_TOTAL - 1, Math.floor(progress * (BASE_TOTAL - 1)));
  const completed = elapsed >= 10000;

  const payload = cloneFixture(progressFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data['count'] = completed ? BASE_TOTAL - 1 : count;
  data['total'] = BASE_TOTAL - 1;
  data['completed'] = completed;
  data['userVoted'] = true;
  data['finalized'] = false;
  data['updatedAtMs'] = now;
  data['animationSeed'] = state.animationSeed;
  return withFixtureMeta(payload);
};

function buildFinalizationSyncData(state: MockState, now: number): Record<string, unknown> {
  const snapshot = buildBulletinSnapshot(state, now);
  const vote = ensureVoteData(state, { bulletinRootAtCast: snapshot.bulletinRootAtCast, now });
  const scenarioTally = resolveScenarioTally(state.scenarioId);
  const payload = cloneFixture(finalizationSucceededResultFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data['sessionId'] = state.sessionId;
  data['finalizationId'] = state.finalizationId ?? MOCK_FINALIZATION_ID;
  const tally = ensureRecord(data['tally']);
  tally['counts'] = scenarioTally.counts;
  tally['totalVotes'] = scenarioTally.totalVotes;
  tally['tamperedCount'] = getTamperedCount(state.scenarioId);
  data['tally'] = tally;
  const imageId = typeof data['imageId'] === 'string' ? data['imageId'] : createHex('4');
  const journal = buildScenarioJournal(state, snapshot, state.scenarioId, imageId);
  data['bulletinRoot'] = journal.bulletinRoot;
  data['treeSize'] = journal.treeSize;
  data['sthDigest'] = journal.sthDigest;
  data['seenBitmapRoot'] = journal.seenBitmapRoot;
  data['includedBitmapRoot'] = journal.includedBitmapRoot;
  data['inputCommitment'] = journal.inputCommitment;
  data['imageId'] = imageId;
  data['verificationStatus'] = data['verificationStatus'] ?? 'success';
  data['verifiedTally'] = cloneVerifiedTally(journal.verifiedTally);
  const voteReceipt = ensureRecord(data['voteReceipt']);
  voteReceipt['voteId'] = vote.voteId;
  voteReceipt['commitment'] = vote.commitment;
  voteReceipt['bulletinIndex'] = vote.bulletinIndex;
  voteReceipt['bulletinRootAtCast'] = vote.bulletinRootAtCast;
  voteReceipt['castAtMs'] = vote.timestamp;
  voteReceipt['inputCommitment'] = createHex('3');
  data['voteReceipt'] = voteReceipt;
  const userVote = ensureRecord(data['userVote']);
  userVote['commitment'] = vote.commitment;
  userVote['voteId'] = vote.voteId;
  const proof = ensureRecord(userVote['proof']);
  proof['leafIndex'] = vote.bulletinIndex;
  const treeSizeAtCast = Math.min(snapshot.treeSize, vote.bulletinIndex + 1);
  const inclusion = snapshot.tree.getInclusionProof(vote.bulletinIndex, treeSizeAtCast);
  proof['merklePath'] = inclusion.proofNodes.map((node) => addHexPrefix(node));
  proof['treeSize'] = treeSizeAtCast;
  proof['bulletinRootAtCast'] = vote.bulletinRootAtCast;
  userVote['proof'] = proof;
  data['userVote'] = userVote;
  data['tamperDetected'] = getVerifyFixtureData(state.scenarioId).presentation.tamperDetected;
  data['scenarios'] = state.scenarioId === 'S0' ? [] : [state.scenarioId];
  data['tamperSummary'] = getTamperSummary(state.scenarioId);
  delete data['s3BundleKey'];
  delete data['s3BundleUrl'];
  delete data['s3UploadedAt'];
  delete data['s3BundleExpiresAt'];
  data['missingSlots'] = journal.missingSlots;
  data['invalidPresentedSlots'] = journal.invalidPresentedSlots;
  data['rejectedRecords'] = journal.rejectedRecords;
  data['excludedSlots'] = journal.excludedSlots;
  data['seenIndicesCount'] = journal.seenIndicesCount;
  data['totalExpected'] = journal.totalExpected;
  data['journal'] = journal;
  return data;
}

export const buildFinalizationResult = (state: MockState): Record<string, unknown> => {
  return buildFinalizationSyncData(state, Date.now());
};

function buildSucceededFinalizationResult(state: MockState, now: number): Record<string, unknown> {
  const result = buildFinalizationSyncData(state, now);
  const journal = result['journal'] as CurrentZkVMJournal;
  const imageId = typeof result['imageId'] === 'string' ? result['imageId'] : createHex('4');
  const candidateStatus = normalizeVerificationStatus(state.verificationStatus ?? result['verificationStatus']);
  const candidateReport =
    state.verificationReport && candidateStatus !== 'not_run' && candidateStatus !== 'running'
      ? buildMockPublicVerificationReport(candidateStatus, imageId, now, state.verificationReport)
      : undefined;
  const resolvedStatus =
    resolveFailClosedVerificationStatus({
      currentStatus: candidateStatus,
      journal,
      claimedImageId: imageId,
      ...(journal.imageId === undefined ? {} : { comparisonImageId: journal.imageId }),
      ...(candidateReport === undefined ? {} : { verificationReport: candidateReport }),
    }) ?? 'not_run';
  const verificationReport = resolvedStatus === candidateStatus ? candidateReport : undefined;

  return {
    authority: {
      imageId,
      journal,
      ...omitUndefinedProperties({
        receipt: result['receipt'],
        electionManifest: result['electionManifest'],
        closeStatement: result['closeStatement'],
      }),
    },
    presentation: {
      tally: result['tally'],
      verifiedTally: cloneVerifiedTally(journal.verifiedTally),
      ...omitUndefinedProperties({
        tamperDetected: result['tamperDetected'],
        scenarios: result['scenarios'],
        tamperSummary: result['tamperSummary'],
      }),
      bulletinRoot: journal.bulletinRoot,
      missingSlots: journal.missingSlots,
      invalidPresentedSlots: journal.invalidPresentedSlots,
      rejectedRecords: journal.rejectedRecords,
      totalExpected: journal.totalExpected,
      treeSize: journal.treeSize,
      excludedSlots: journal.excludedSlots,
      sthDigest: journal.sthDigest,
      ...omitUndefinedProperties({ seenBitmapRoot: journal.seenBitmapRoot }),
      includedBitmapRoot: journal.includedBitmapRoot,
      inputCommitment: journal.inputCommitment,
      seenIndicesCount: journal.seenIndicesCount,
      ...omitUndefinedProperties({ bitmapProofSource: result['bitmapProofSource'] }),
      verificationStatus: resolvedStatus,
      ...omitUndefinedProperties({ verificationReport }),
    },
    voterEvidence: {
      state: 'available',
      voteReceipt: result['voteReceipt'],
      userVote: result['userVote'],
      ...omitUndefinedProperties({ receiptPublication: result['receiptPublication'] }),
    },
    artifactAvailability: {
      bundle: 'available',
      report: verificationReport ? 'available' : 'unavailable',
      includedBitmap: 'available',
      seenBitmap: journal.seenBitmapRoot ? 'available' : 'unavailable',
    },
  };
}

export const buildFinalizationResource = (state: MockState, now: number): Record<string, unknown> | null => {
  if (!state.finalizationId) {
    return null;
  }
  const queuedAtMs = state.finalizationQueuedAtMs ?? now;
  const startedAtMs = state.finalizationStartedAtMs ?? queuedAtMs + 2000;
  const completedAtMs = state.finalizationCompletedAtMs ?? startedAtMs + 20000;
  const estimatedDurationMs = completedAtMs - startedAtMs;
  const hasFailure = typeof state.finalizationFailedAtMs === 'number';
  const status = hasFailure ? 'failed' : now < startedAtMs ? 'pending' : now < completedAtMs ? 'running' : 'succeeded';
  const queue = status === 'pending' || status === 'running' ? { concurrencyLimit: 2, estimatedDurationMs } : null;
  const runtimeDiagnostics: Record<string, unknown> = {
    asyncMode: 'enabled',
    queue,
    orchestrator: null,
  };
  const progress = deriveFinalizationProgress({
    state: { status, startedAtMs },
    estimatedDurationMs,
    now,
  });
  if (progress) {
    runtimeDiagnostics['progress'] = progress;
  }

  const base = {
    finalizationId: state.finalizationId,
    queuedAtMs,
    runtimeDiagnostics,
  };
  switch (status) {
    case 'pending':
      return { ...base, status };
    case 'running':
      return { ...base, status, startedAtMs };
    case 'succeeded':
      return {
        ...base,
        status,
        startedAtMs,
        completedAtMs,
        result: buildSucceededFinalizationResult(state, now),
      };
    case 'failed':
      return {
        ...base,
        status,
        startedAtMs,
        failedAtMs: state.finalizationFailedAtMs ?? now,
        error: state.finalizationError ?? {
          code: 'USER_CANCELLED',
          message: 'Cancelled by user request',
        },
      };
  }
};

export const buildFinalizationResponse = (state: MockState, now: number): Record<string, unknown> =>
  fixtureEnvelope(buildFinalizationResource(state, now) ?? {});

export const buildCurrentFinalizationResponse = (state: MockState, now: number): Record<string, unknown> => ({
  data: buildFinalizationResource(state, now),
  meta: { requestId: MOCK_FIXTURE_REQUEST_ID },
});

const FAILED_CHECK_IDS_BY_SCENARIO: Readonly<Record<ScenarioId, ReadonlySet<VerificationCheckId>>> = {
  S0: new Set(),
  S1: new Set(['counted_missing_indices_zero', 'counted_my_vote_included']),
  S2: new Set(['counted_tally_consistent']),
  S3: new Set(['counted_missing_indices_zero']),
  S4: new Set(['counted_tally_consistent']),
  S5: new Set(['counted_missing_indices_zero']),
};

export const buildVerificationResourceResponse = (
  state: MockState,
  now: number,
  options?: { includeJournal?: boolean },
): Record<string, unknown> => {
  const snapshot = buildBulletinSnapshot(state, now);
  const vote = ensureVoteData(state, { bulletinRootAtCast: snapshot.bulletinRootAtCast, now });
  const fixtureData = cloneFixture(getVerifyFixtureData(state.scenarioId));
  const tally = cloneFixture(fixtureData.presentation.tally);
  const scenarioTally = resolveScenarioTally(state.scenarioId);
  tally.counts = scenarioTally.counts;
  tally.totalVotes = scenarioTally.totalVotes;
  tally.tamperedCount = getTamperedCount(state.scenarioId);

  const resolvedStatus = normalizeVerificationStatus(
    state.verificationStatus ?? state.verificationReport?.status ?? fixtureData.verifierResult.status,
  );
  const resolvedReport =
    resolvedStatus === 'not_run' || resolvedStatus === 'running'
      ? undefined
      : buildMockPublicVerificationReport(
          resolvedStatus,
          fixtureData.proofAuthority.imageId,
          now,
          state.verificationReport,
        );

  const stepStatusMap: Record<VerificationStepId, VerificationStepStatus> = {
    cast_as_intended: 'not_run',
    recorded_as_cast: 'pending',
    counted_as_recorded: 'pending',
    stark_verification: 'pending',
  };

  const fixtureSteps = fixtureData.verification.steps;
  fixtureSteps.forEach((step) => {
    stepStatusMap[step.id] = step.status;
  });
  stepStatusMap.cast_as_intended = 'not_run';
  stepStatusMap.stark_verification = mapStarkStepStatus(resolvedStatus);

  const failedCheckIds = FAILED_CHECK_IDS_BY_SCENARIO[state.scenarioId];
  const scenarioMetrics = resolveScenarioMetrics(state.scenarioId);
  const zkGateStatus = resolveZkGateStatus(stepStatusMap.stark_verification);
  const verificationChecks: VerificationCheck[] = VERIFICATION_CHECK_DEFINITIONS.map((definition) => {
    let status: VerificationStepStatus;
    if (definition.category === 'cast_as_intended') {
      status = 'not_run';
    } else if (definition.category === 'stark_verification') {
      status = stepStatusMap.stark_verification;
    } else if (definition.id === 'counted_missing_indices_zero') {
      status = scenarioMetrics.excludedSlots > 0 ? 'failed' : (zkGateStatus ?? 'success');
    } else if (zkGateStatus !== undefined && isCheckStatusZkGateControlled(definition.id)) {
      status = zkGateStatus;
    } else {
      status = failedCheckIds.has(definition.id) ? 'failed' : 'success';
    }
    return {
      id: definition.id,
      status,
      evidence: resolvedStatus === 'dev_mode' && definition.evidence === 'zk' ? 'demo' : definition.evidence,
      inputs: [...definition.inputs],
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    };
  });

  const imageId = fixtureData.proofAuthority.imageId;
  const journal = buildScenarioJournal(state, snapshot, state.scenarioId, imageId);
  const treeSizeAtCast = Math.min(snapshot.treeSize, vote.bulletinIndex + 1);
  const inclusion = snapshot.tree.getInclusionProof(vote.bulletinIndex, treeSizeAtCast);
  const policy = deriveVerificationPresentationPolicy({
    availability: 'available',
    checks: verificationChecks,
    context: {
      missingSlots: scenarioMetrics.missingSlots,
      invalidPresentedSlots: scenarioMetrics.invalidPresentedSlots,
      rejectedRecords: scenarioMetrics.rejectedRecords,
      excludedSlots: scenarioMetrics.excludedSlots,
      devModeEvidence: resolvedStatus === 'dev_mode',
    },
    verificationStatus: resolvedStatus,
    ...(resolvedReport ? { verificationReportStatus: resolvedReport.status } : {}),
  });
  const stepsById = new Map(fixtureSteps.map((step) => [step.id, step] as const));
  const verificationSteps = (
    ['cast_as_intended', 'recorded_as_cast', 'counted_as_recorded', 'stark_verification'] as const
  ).map((id) => {
    const step = stepsById.get(id);
    return {
      id,
      status: policy.stageStatuses[id],
      ...(step?.inputs ? { inputs: [...step.inputs] } : {}),
      ...(step?.error && policy.stageStatuses[id] === 'failed' ? { error: step.error } : {}),
    };
  });
  const botVotesSummary = fixtureData.presentation.botVotesSummary
    ? cloneFixture(fixtureData.presentation.botVotesSummary)
    : undefined;
  const tamperSummary = cloneFixture(fixtureData.presentation.tamperSummary ?? {});
  const finalizationId = state.finalizationId ?? MOCK_FINALIZATION_ID;

  const includeJournal = options?.includeJournal ?? false;
  return fixtureEnvelope({
    availability: 'available',
    finalizationId,
    proofAuthority: {
      electionId: state.electionId,
      electionConfigHash: state.electionConfigHash,
      logId: state.logId,
      imageId,
      bulletinRoot: journal.bulletinRoot,
      verifiedTally: cloneVerifiedTally(journal.verifiedTally),
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
    },
    presentation: {
      tally,
      scenarioId: state.scenarioId,
      tamperDetected: fixtureData.presentation.tamperDetected === true,
      ...omitUndefinedProperties({ botVotesSummary }),
      tamperSummary,
      policy,
    },
    verifierResult: resolvedReport ? { status: resolvedStatus, report: resolvedReport } : { status: resolvedStatus },
    verification: {
      checks: verificationChecks,
      steps: verificationSteps,
    },
    voterEvidence: {
      availability: 'available',
      voteReceipt: {
        voteId: vote.voteId,
        commitment: vote.commitment,
        bulletinIndex: vote.bulletinIndex,
        bulletinRootAtCast: vote.bulletinRootAtCast,
        castAtMs: vote.timestamp,
        inputCommitment: journal.inputCommitment,
      },
      userVote: {
        commitment: vote.commitment,
        voteId: vote.voteId,
        proof: {
          leafIndex: vote.bulletinIndex,
          treeSize: treeSizeAtCast,
          merklePath: inclusion.proofNodes.map((node) => addHexPrefix(node)),
          bulletinRootAtCast: vote.bulletinRootAtCast,
        },
      },
    },
    journal: includeJournal
      ? {
          representation: 'included',
          value: journal,
        }
      : {
          representation: 'omitted',
        },
  });
};

export const buildVerificationRunResponse = (
  finalizationId: string,
  verificationStatus: VerificationStatus,
): Record<string, unknown> => {
  const payload = cloneFixture(verificationRunFixture) as Record<string, unknown>;
  const data = ensureData(payload);
  data['finalizationId'] = finalizationId;
  data['verificationStatus'] = verificationStatus;
  return withFixtureMeta(payload);
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
    generatedAtMs: now,
    rootHistory: snapshot.rootHistory,
  };

  if (hasPaging) {
    const nextOffset = offset + sliceLimit;
    const hasMore = nextOffset < snapshot.treeSize;
    return fixtureEnvelope(payload, {
      page: {
        nextOffset: hasMore ? nextOffset : null,
        hasMore,
      },
    });
  }

  return fixtureEnvelope(payload);
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

  return fixtureEnvelope({
    voteId,
    proof: {
      leafIndex,
      merklePath: inclusion.proofNodes.map((node) => addHexPrefix(node)),
      treeSize: treeSizeAtCast,
      bulletinRootAtCast: addHexPrefix(snapshot.tree.getRootAtSize(treeSizeAtCast)),
    },
  });
};

export const buildConsistencyProofResponse = (
  state: MockState,
  options: { fromTreeSize: number; toTreeSize: number; now?: number },
): Record<string, unknown> => {
  const now = options.now ?? Date.now();
  const snapshot = buildBulletinSnapshot(state, now);
  const proof =
    options.fromTreeSize === 0
      ? { proofNodes: [], oldSubtreeHashes: undefined, appendSubtreeHashes: undefined }
      : snapshot.tree.getConsistencyProof(options.fromTreeSize, options.toTreeSize);
  const rootAtFromTreeSize =
    options.fromTreeSize === 0
      ? addHexPrefix(EMPTY_SHA256_HEX)
      : addHexPrefix(snapshot.tree.getRootAtSize(options.fromTreeSize));
  const rootAtToTreeSize =
    options.toTreeSize === 0
      ? addHexPrefix(EMPTY_SHA256_HEX)
      : addHexPrefix(snapshot.tree.getRootAtSize(options.toTreeSize));

  return fixtureEnvelope({
    fromTreeSize: options.fromTreeSize,
    toTreeSize: options.toTreeSize,
    rootAtFromTreeSize,
    rootAtToTreeSize,
    proofNodes: proof.proofNodes,
    oldSubtreeHashes: proof.oldSubtreeHashes,
    appendSubtreeHashes: proof.appendSubtreeHashes,
    generatedAtMs: now,
  });
};

export const buildFinalizationCancelResponse = (
  state: MockState,
  options: { finalizationId: string; reason?: string; now?: number },
): Record<string, unknown> => {
  const now = options.now ?? Date.now();
  if (state.finalizationId !== options.finalizationId) {
    return fixtureEnvelope({});
  }
  return buildFinalizationResponse(state, now);
};

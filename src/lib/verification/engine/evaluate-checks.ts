import type { VerificationStepStatus } from '@/lib/knowledge';
import type { VerificationCheckId } from '@/lib/verification/verification-checks';
import { VERIFICATION_CHECK_IDS } from '@/lib/verification/verification-checks';
import { computeCommitment } from '@/lib/zkvm/types';
import { VOTE_CHOICES } from '@/shared/constants';
import type { VoteChoice } from '@/shared/constants';
import { verifyCTMerkleInclusion } from '@/lib/verification/merkle';
import { resolveExcludedCount } from '@/lib/verification/excluded-count';
import { recomputeElectionManifestHash, buildCloseStatement } from '@/lib/verification/public-audit-artifacts';
import { normalizeHexString, isValidHexString } from '@/lib/utils/hex';
import { explainVoteInclusionStatus, verifyMyVoteWasCounted } from '@/lib/verification/bitmap-verifier';
import { toCanonicalRfc6962Proof } from '@/lib/merkle/rfc6962-proof';
import {
  resolveConfiguredSthMinMatches,
  resolveConfiguredSthSources,
  verifySthThirdParty,
} from '@/lib/verification/sth-verifier';
import type { CheckResult, VerificationContext, VerificationStatus } from './types';

export interface EvaluateChecksOptions {
  applyZkGate?: boolean;
}

interface EvaluationRuntime {
  starkStatus: VerificationStepStatus;
  zkGateStatus?: VerificationStepStatus;
}

interface EvaluationHelpers {
  evaluate: (id: VerificationCheckId) => Promise<CheckResult>;
}

type CheckEvaluator = (
  ctx: VerificationContext,
  runtime: EvaluationRuntime,
  helpers: EvaluationHelpers,
) => CheckResult | Promise<CheckResult>;

const STH_CACHE_TTL_MS = 5 * 60 * 1000;
const sthCache = new Map<string, { status: VerificationStepStatus; expiresAt: number }>();

export const CHECK_EVALUATORS: Record<VerificationCheckId, CheckEvaluator> = {
  cast_receipt_present: (ctx) => resolveCastReceiptPresent(ctx.voteReceipt),
  cast_choice_range: (ctx) => resolveCastChoiceRange(ctx.userVote?.vote),
  cast_random_format: (ctx) => resolveCastRandomFormat(ctx.userVote?.random),
  cast_commitment_match: (ctx) => resolveCastCommitmentMatch(ctx),
  recorded_commitment_in_bulletin: (_ctx, _runtime, helpers) => helpers.evaluate('recorded_inclusion_proof'),
  recorded_index_in_range: (ctx) => resolveRecordedIndexInRange(ctx.voteReceipt, ctx.treeSize),
  recorded_root_at_cast_consistent: (_ctx, _runtime, helpers) => helpers.evaluate('recorded_consistency_proof'),
  recorded_inclusion_proof: (ctx) => resolveRecordedInclusionProof(ctx),
  recorded_consistency_proof: (ctx) => resolveRecordedConsistencyProof(ctx),
  recorded_sth_third_party: (ctx) => resolveRecordedSthThirdParty(ctx),
  counted_input_sanity: (ctx) => resolveCountedInputSanity(ctx),
  counted_unique_indices: (ctx) => resolveCountedUniqueIndices(ctx),
  counted_unique_commitments: (ctx) => resolveCountedUniqueCommitments(ctx),
  counted_tally_consistent: (ctx, runtime) => resolveCountedTallyConsistent(ctx, runtime.zkGateStatus),
  counted_missing_indices_zero: (ctx, runtime) => resolveCountedMissingIndicesZero(ctx, runtime.zkGateStatus),
  counted_expected_vs_tree_size: (ctx, runtime) => resolveCountedExpectedVsTreeSize(ctx, runtime.zkGateStatus),
  counted_election_manifest_consistent: (ctx, runtime) =>
    resolveCountedElectionManifestConsistent(ctx, runtime.zkGateStatus),
  counted_close_statement_consistent: (ctx, runtime) =>
    resolveCountedCloseStatementConsistent(ctx, runtime.zkGateStatus),
  counted_my_vote_included: (ctx, runtime) => resolveCountedMyVoteIncluded(ctx, runtime.zkGateStatus),
  counted_input_commitment_match: (ctx, runtime) => resolveCountedInputCommitmentMatch(ctx, runtime.zkGateStatus),
  stark_image_id_match: (ctx, runtime) => resolveStarkImageIdMatch(ctx, runtime.starkStatus),
  stark_receipt_verify: (_ctx, runtime) => ({ status: runtime.starkStatus }),
};

/**
 * Evaluate a targeted subset of verification checks.
 */
export async function evaluateChecks(
  ctx: VerificationContext,
  checkIds: readonly VerificationCheckId[],
  options: EvaluateChecksOptions = {},
): Promise<Map<VerificationCheckId, CheckResult>> {
  const applyZkGate = options.applyZkGate ?? true;
  const starkStatus = resolveStarkStatus(
    ctx.verificationStatus,
    ctx.verificationReportStatus,
    ctx.allowDevModeVerification,
  );
  const runtime: EvaluationRuntime = {
    starkStatus,
    zkGateStatus: applyZkGate ? resolveZkGateStatus(starkStatus) : undefined,
  };

  const cache = new Map<VerificationCheckId, Promise<CheckResult>>();
  const helpers: EvaluationHelpers = {
    evaluate: async (id) => {
      const cached = cache.get(id);
      if (cached) {
        return cached;
      }
      const evaluator = CHECK_EVALUATORS[id];
      const resultPromise = Promise.resolve(evaluator(ctx, runtime, helpers));
      cache.set(id, resultPromise);
      return resultPromise;
    },
  };

  const entries = await Promise.all(checkIds.map(async (id) => [id, await helpers.evaluate(id)] as const));

  return new Map(entries);
}

export async function evaluateAllChecks(
  ctx: VerificationContext,
  options: EvaluateChecksOptions = {},
): Promise<Map<VerificationCheckId, CheckResult>> {
  return evaluateChecks(ctx, VERIFICATION_CHECK_IDS, options);
}

function resolveCastReceiptPresent(voteReceipt: VerificationContext['voteReceipt']): CheckResult {
  if (!voteReceipt) {
    return { status: 'not_run' };
  }
  if (!voteReceipt.voteId || !voteReceipt.commitment) {
    return { status: 'failed', error: 'Invalid receipt: missing commitment or voteId' };
  }
  return { status: 'success' };
}

function resolveCastChoiceRange(choice?: VoteChoice): CheckResult {
  if (!choice) {
    return { status: 'not_run' };
  }
  if (!VOTE_CHOICES.includes(choice)) {
    return { status: 'failed', error: `Unknown vote choice "${choice}".` };
  }
  return { status: 'success' };
}

function resolveCastRandomFormat(random?: string): CheckResult {
  if (!random) {
    return { status: 'not_run' };
  }
  return isValidHexString(random, 32)
    ? { status: 'success' }
    : { status: 'failed', error: 'Random value must be a 32-byte hex string.' };
}

function resolveCastCommitmentMatch(input: VerificationContext): CheckResult {
  const { electionId, voteReceipt, userVote } = input;
  if (!electionId || !voteReceipt?.commitment || !userVote?.vote || !userVote.random) {
    return { status: 'not_run' };
  }

  const normalizedCommitment = normalizeHexString(voteReceipt.commitment);
  if (!normalizedCommitment) {
    return { status: 'failed', error: 'Receipt commitment is malformed.' };
  }

  const choiceIndex = VOTE_CHOICES.indexOf(userVote.vote);
  if (choiceIndex === -1) {
    return { status: 'failed', error: `Unknown vote choice "${userVote.vote}".` };
  }

  try {
    const recomputed = computeCommitment(electionId, choiceIndex, userVote.random);
    const normalizedRecomputed = normalizeHexString(recomputed);
    if (normalizedCommitment !== normalizedRecomputed) {
      return { status: 'failed', error: 'Commitment mismatch between receipt and recomputed value.' };
    }
    return { status: 'success' };
  } catch (error) {
    return {
      status: 'failed',
      error:
        error instanceof Error
          ? `Failed to recompute commitment: ${error.message}`
          : 'Failed to recompute commitment due to invalid input.',
    };
  }
}

async function resolveRecordedInclusionProof(ctx: VerificationContext): Promise<CheckResult> {
  const userVote = ctx.userVote;
  const voteReceipt = ctx.voteReceipt;
  const proof = toCanonicalRfc6962Proof(userVote?.proof);
  const commitment = userVote?.commitment;
  if (!proof || !voteReceipt || !commitment) {
    return { status: 'not_run' };
  }

  if (!Number.isInteger(voteReceipt.bulletinIndex) || voteReceipt.bulletinIndex < 0) {
    return { status: 'not_run' };
  }
  if (proof.leafIndex !== voteReceipt.bulletinIndex) {
    return { status: 'failed', error: 'Inclusion proof leaf index does not match receipt bulletin index.' };
  }

  if (typeof proof.treeSize !== 'number') {
    return { status: 'not_run' };
  }
  if (!Number.isInteger(proof.treeSize) || proof.treeSize <= 0) {
    return { status: 'failed', error: 'Inclusion proof tree size is invalid.' };
  }
  if (proof.treeSize !== voteReceipt.bulletinIndex + 1) {
    return { status: 'failed', error: 'Inclusion proof tree size does not match the cast snapshot.' };
  }
  if (normalizeHexString(proof.bulletinRootAtCast) !== normalizeHexString(voteReceipt.bulletinRootAtCast)) {
    return { status: 'failed', error: 'Inclusion proof root does not match receipt root at cast.' };
  }
  try {
    const included = await Promise.resolve(
      verifyCTMerkleInclusion(commitment, proof.merklePath, proof.leafIndex, proof.bulletinRootAtCast, proof.treeSize),
    );
    return included ? { status: 'success' } : { status: 'failed', error: 'Inclusion proof verification failed.' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Inclusion proof verification failed.',
    };
  }
}

function resolveRecordedIndexInRange(voteReceipt: VerificationContext['voteReceipt'], treeSize?: number): CheckResult {
  if (!voteReceipt || typeof treeSize !== 'number') {
    return { status: 'not_run' };
  }
  if (!Number.isInteger(voteReceipt.bulletinIndex) || !Number.isInteger(treeSize)) {
    return { status: 'not_run' };
  }
  return voteReceipt.bulletinIndex >= 0 && voteReceipt.bulletinIndex < treeSize
    ? { status: 'success' }
    : { status: 'failed', error: 'Invalid bulletin index' };
}

function resolveRecordedConsistencyProof(input: VerificationContext): CheckResult {
  const { bulletin, voteReceipt, bulletinRoot, treeSize, userVote } = input;
  if (!bulletin || !voteReceipt || !voteReceipt.bulletinRootAtCast || !bulletinRoot || typeof treeSize !== 'number') {
    return { status: 'not_run' };
  }

  const newSize = treeSize;
  if (!Number.isInteger(newSize) || newSize <= 0) {
    return { status: 'not_run' };
  }

  const proof = toCanonicalRfc6962Proof(userVote?.proof);
  if (!proof) {
    return { status: 'not_run' };
  }

  if (!Number.isInteger(voteReceipt.bulletinIndex) || voteReceipt.bulletinIndex < 0) {
    return { status: 'not_run' };
  }
  if (!Number.isInteger(proof.leafIndex) || proof.leafIndex < 0) {
    return { status: 'failed', error: 'Consistency proof leaf index is invalid.' };
  }
  if (proof.leafIndex !== voteReceipt.bulletinIndex) {
    return { status: 'failed', error: 'Consistency proof leaf index does not match receipt bulletin index.' };
  }
  if (!Number.isInteger(proof.treeSize) || proof.treeSize <= 0) {
    return { status: 'failed', error: 'Consistency proof tree size is invalid.' };
  }
  if (proof.treeSize !== voteReceipt.bulletinIndex + 1) {
    return { status: 'failed', error: 'Consistency proof tree size does not match the cast snapshot.' };
  }
  if (normalizeHexString(proof.bulletinRootAtCast) !== normalizeHexString(voteReceipt.bulletinRootAtCast)) {
    return { status: 'failed', error: 'Root mismatch: receipt and inclusion proof disagree' };
  }
  if (proof.treeSize > newSize) {
    return { status: 'failed', error: 'Consistency proof tree size exceeds final bulletin size.' };
  }

  if (typeof bulletin.getSize === 'function' && newSize > bulletin.getSize()) {
    return { status: 'failed', error: 'Root mismatch: bulletin may have been modified' };
  }

  try {
    const rootAtOldSize = bulletin.getRootAtSize(proof.treeSize);
    if (normalizeHexString(rootAtOldSize) !== normalizeHexString(voteReceipt.bulletinRootAtCast)) {
      return { status: 'failed', error: 'Root mismatch: bulletin may have been modified' };
    }
    const rootAtNewSize = bulletin.getRootAtSize(newSize);
    if (normalizeHexString(rootAtNewSize) !== normalizeHexString(bulletinRoot)) {
      return { status: 'failed', error: 'Root mismatch: bulletin may have been modified' };
    }
    const proofNodes = bulletin.getConsistencyProof(proof.treeSize, newSize);
    const isConsistent = bulletin.verifyConsistency(rootAtOldSize, rootAtNewSize, proofNodes);
    return isConsistent ? { status: 'success' } : { status: 'failed', error: 'Consistency proof verification failed.' };
  } catch {
    return { status: 'failed', error: 'Consistency proof verification failed.' };
  }
}

async function resolveRecordedSthThirdParty(input: VerificationContext): Promise<CheckResult> {
  const sthDigest = input.journal?.sthDigest ?? input.sthDigest;
  const bulletinRoot = input.journal?.bulletinRoot ?? input.bulletinRoot;
  const treeSize = input.journal?.treeSize ?? input.treeSize;
  if (!sthDigest || !bulletinRoot || typeof treeSize !== 'number') {
    return { status: 'not_run' };
  }

  const sources = resolveConfiguredSthSources();
  if (sources.length === 0) {
    return { status: 'not_run' };
  }

  const resolvedSources = resolveSthSourcesWithBaseUrl(sources, input.sthBaseUrl);

  const cacheKey = normalizeHexString(sthDigest);
  const cached = sthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { status: cached.status };
  }

  const result = await verifySthThirdParty(
    {
      sthDigest,
      bulletinRoot,
      treeSize,
    },
    {
      sources: resolvedSources,
      minMatchingSources: resolveConfiguredSthMinMatches(),
      sessionId: input.sessionId,
      sameOriginHeaders: input.sessionAuthHeaders,
      sameOriginOrigin: input.sthBaseUrl,
    },
  );
  const status: VerificationStepStatus = result.verified ? 'success' : 'failed';
  sthCache.set(cacheKey, { status, expiresAt: Date.now() + STH_CACHE_TTL_MS });
  return { status };
}

function resolveCountedInputSanity(input: VerificationContext): CheckResult {
  const publicInput = input.publicInputAuthority;
  if (!publicInput) {
    return { status: 'not_run' };
  }

  const { bulletinRoot, treeSize, votesCount } = publicInput;
  if (!Number.isInteger(treeSize) || treeSize <= 0) {
    return { status: 'failed' };
  }
  if (votesCount > treeSize) {
    return { status: 'failed' };
  }
  if (!isValidHexString(bulletinRoot, 32)) {
    return { status: 'failed' };
  }
  return normalizeHexString(bulletinRoot) === '0'.repeat(64) ? { status: 'failed' } : { status: 'success' };
}

function resolveCountedUniqueIndices(input: VerificationContext): CheckResult {
  const publicInput = input.publicInputAuthority;
  if (!publicInput) {
    return { status: 'not_run' };
  }
  return publicInput.uniqueIndices ? { status: 'success' } : { status: 'failed' };
}

function resolveCountedUniqueCommitments(input: VerificationContext): CheckResult {
  const publicInput = input.publicInputAuthority;
  if (!publicInput) {
    return { status: 'not_run' };
  }
  return publicInput.uniqueCommitments ? { status: 'success' } : { status: 'failed' };
}

function resolveCountedTallyConsistent(input: VerificationContext, zkGateStatus?: VerificationStepStatus): CheckResult {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const journal = input.journal;
  if (journal && typeof journal.totalVotes === 'number' && journal.totalVotes === 0) {
    return { status: 'failed', error: 'No votes processed by zkVM' };
  }

  const counts = input.tally?.counts;
  const totalVotes = input.tally?.totalVotes;
  const verifiedTally = input.verifiedTally;
  if (counts && typeof totalVotes === 'number' && Array.isArray(verifiedTally)) {
    const countsArray = VOTE_CHOICES.map((choice) => counts[choice]);
    if (countsArray.some((value) => typeof value !== 'number')) {
      return { status: 'not_run' };
    }

    if (verifiedTally.length < countsArray.length || verifiedTally.some((value) => typeof value !== 'number')) {
      return { status: 'not_run' };
    }

    const normalizedVerified = verifiedTally.slice(0, countsArray.length);
    const tallyMatches = countsArray.every((value, index) => value === normalizedVerified[index]);
    const sum = normalizedVerified.reduce((total, value) => total + value, 0);
    return tallyMatches && sum === totalVotes ? { status: 'success' } : { status: 'failed' };
  }

  if (!journal) {
    return { status: 'not_run' };
  }

  if (!Array.isArray(journal.verifiedTally) || typeof journal.validVotes !== 'number') {
    return { status: 'not_run' };
  }

  const tallySum = journal.verifiedTally.reduce((a, b) => a + b, 0);
  if (tallySum !== journal.validVotes) {
    return {
      status: 'failed',
      error: `Tally sum (${tallySum}) does not match valid votes (${journal.validVotes})`,
    };
  }

  return { status: 'success' };
}

function resolveCountedMissingIndicesZero(
  input: VerificationContext,
  zkGateStatus?: VerificationStepStatus,
): CheckResult {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const journalCountError = resolveInvalidJournalCounts(input.journal);
  if (journalCountError) {
    return journalCountError;
  }

  const resolvedExcludedSlots = resolveExcludedCount({
    journal: input.journal,
    missingSlots: input.missingSlots,
    invalidPresentedSlots: input.invalidPresentedSlots,
    excludedSlots: input.excludedSlots,
  });

  if (typeof resolvedExcludedSlots !== 'number') {
    return { status: 'not_run' };
  }

  return resolvedExcludedSlots === 0
    ? { status: 'success' }
    : { status: 'failed', error: `excludedSlots=${resolvedExcludedSlots}` };
}

function resolveCountedExpectedVsTreeSize(
  input: VerificationContext,
  zkGateStatus?: VerificationStepStatus,
): CheckResult {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const totalExpected = input.totalExpected ?? input.journal?.totalExpected;
  const treeSize = input.treeSize ?? input.journal?.treeSize;
  if (typeof totalExpected !== 'number' || typeof treeSize !== 'number') {
    return { status: 'not_run' };
  }
  if (!Number.isInteger(totalExpected) || !Number.isInteger(treeSize)) {
    return { status: 'not_run' };
  }
  return totalExpected === treeSize ? { status: 'success' } : { status: 'failed' };
}

function resolveCountedInputCommitmentMatch(
  input: VerificationContext,
  zkGateStatus?: VerificationStepStatus,
): CheckResult {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const publicInput = input.publicInputAuthority;
  if (!publicInput) {
    return { status: 'not_run' };
  }

  const resolvedCommitment = input.journal?.inputCommitment ?? input.inputCommitment;
  if (!resolvedCommitment) {
    return { status: 'not_run' };
  }

  const recomputed = publicInput.recomputedInputCommitment;
  if (!recomputed) {
    return { status: 'not_run' };
  }

  return normalizeHexString(recomputed) === normalizeHexString(resolvedCommitment)
    ? { status: 'success' }
    : { status: 'failed' };
}

function resolveCountedElectionManifestConsistent(
  input: VerificationContext,
  zkGateStatus?: VerificationStepStatus,
): CheckResult {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const manifest = input.electionManifest;
  if (!manifest) {
    return { status: 'not_run' };
  }

  // First validate that the artifact is internally self-consistent, then
  // cross-check it against journal/public-input/session values below.
  const recomputedHash = recomputeElectionManifestHash(manifest);
  if (normalizeHexString(recomputedHash) !== normalizeHexString(manifest.electionConfigHash)) {
    return { status: 'failed', error: 'Election manifest hash does not match its declared configuration.' };
  }

  const candidateElectionIds = [
    manifest.electionId,
    input.electionId,
    input.publicInputAuthority?.electionId,
    input.journal?.electionId,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (new Set(candidateElectionIds).size > 1) {
    return { status: 'failed', error: 'Election manifest electionId does not match verification inputs.' };
  }

  const candidateHashes = [
    manifest.electionConfigHash,
    input.electionConfigHash,
    input.publicInputAuthority?.electionConfigHash,
    input.journal?.electionConfigHash,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (candidateHashes.some((value) => normalizeHexString(value) !== normalizeHexString(recomputedHash))) {
    return { status: 'failed', error: 'Election config hash mismatch between manifest and verification inputs.' };
  }

  return { status: 'success' };
}

function resolveCountedCloseStatementConsistent(
  input: VerificationContext,
  zkGateStatus?: VerificationStepStatus,
): CheckResult {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const closeStatement = input.closeStatement;
  if (!closeStatement) {
    return { status: 'not_run' };
  }
  const publicInputTimestamp = input.publicInputAuthority?.timestamp;
  if (typeof publicInputTimestamp !== 'number' || !Number.isInteger(publicInputTimestamp)) {
    return { status: 'not_run' };
  }

  let recomputed;
  try {
    recomputed = buildCloseStatement({
      logId: closeStatement.logId,
      treeSize: closeStatement.treeSize,
      timestamp: closeStatement.timestamp,
      bulletinRoot: closeStatement.bulletinRoot,
    });
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Close statement is malformed.',
    };
  }
  if (normalizeHexString(recomputed.sthDigest) !== normalizeHexString(closeStatement.sthDigest)) {
    return { status: 'failed', error: 'Close statement digest does not match its declared snapshot.' };
  }
  if (closeStatement.timestamp !== publicInputTimestamp) {
    return { status: 'failed', error: 'Close statement timestamp does not match public input.' };
  }

  const candidateLogIds = [closeStatement.logId, input.logId].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (new Set(candidateLogIds.map((value) => normalizeHexString(value))).size > 1) {
    return { status: 'failed', error: 'Close statement logId does not match verification inputs.' };
  }

  const candidateTreeSizes = [closeStatement.treeSize, input.treeSize, input.journal?.treeSize].filter(
    (value): value is number => typeof value === 'number' && Number.isInteger(value),
  );
  if (new Set(candidateTreeSizes).size > 1) {
    return { status: 'failed', error: 'Close statement treeSize does not match verification inputs.' };
  }

  const candidateRoots = [closeStatement.bulletinRoot, input.bulletinRoot, input.journal?.bulletinRoot].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (new Set(candidateRoots.map((value) => normalizeHexString(value))).size > 1) {
    return { status: 'failed', error: 'Close statement bulletinRoot does not match verification inputs.' };
  }

  const candidateDigests = [closeStatement.sthDigest, input.sthDigest, input.journal?.sthDigest].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (candidateDigests.some((value) => normalizeHexString(value) !== normalizeHexString(recomputed.sthDigest))) {
    return { status: 'failed', error: 'Close statement STH digest does not match verification inputs.' };
  }

  return { status: 'success' };
}

function resolveInvalidJournalCounts(journal: VerificationContext['journal']): CheckResult | undefined {
  if (!journal) {
    return undefined;
  }

  const invalidFields: string[] = [];
  if (!isValidCount(journal.excludedSlots)) {
    invalidFields.push('excludedSlots');
  }
  if (!isValidCount(journal.missingSlots)) {
    invalidFields.push('missingSlots');
  }
  if (!isValidCount(journal.invalidPresentedSlots)) {
    invalidFields.push('invalidPresentedSlots');
  }
  if (!isValidCount(journal.validVotes)) {
    invalidFields.push('validVotes');
  }

  if (invalidFields.length === 0) {
    return undefined;
  }

  return {
    status: 'failed',
    error: `Invalid zkVM journal: ${invalidFields.join(', ')} is missing or invalid.`,
  };
}

function isValidCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

async function resolveCountedMyVoteIncluded(
  input: VerificationContext,
  zkGateStatus?: VerificationStepStatus,
): Promise<CheckResult> {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const includedBitmapRoot = input.journal?.includedBitmapRoot ?? input.includedBitmapRoot;
  const seenBitmapRoot = input.journal?.seenBitmapRoot ?? input.seenBitmapRoot;
  const bulletinIndex = input.voteReceipt?.bulletinIndex;
  if (!includedBitmapRoot || typeof bulletinIndex !== 'number' || !Number.isInteger(bulletinIndex)) {
    const noteKey = resolveCountedMyVoteIncludedNoteKey(input, 'not_run', zkGateStatus);
    return noteKey ? { status: 'not_run', noteKey } : { status: 'not_run' };
  }

  if (input.bitmapProofSource !== 'mock' && input.bitmapProofSource !== 'real') {
    const noteKey = resolveCountedMyVoteIncludedNoteKey(input, 'not_run', zkGateStatus);
    return noteKey ? { status: 'not_run', noteKey } : { status: 'not_run' };
  }

  try {
    const bitmapOptions = {
      apiEndpoint: input.bitmapProofEndpoint,
      sessionId: input.sessionId,
      headers: input.sessionAuthHeaders,
    };
    const result = seenBitmapRoot
      ? await explainVoteInclusionStatus(
          bulletinIndex,
          {
            includedBitmapRoot,
            seenBitmapRoot,
          },
          bitmapOptions,
        )
      : await verifyMyVoteWasCounted(bulletinIndex, includedBitmapRoot, bitmapOptions);
    if (!result.valid) {
      return { status: 'failed' };
    }
    const status: VerificationStepStatus = result.included ? 'success' : 'failed';
    if (status === 'failed' && 'statusDetail' in result) {
      const noteKey =
        result.statusDetail === 'not_presented'
          ? 'pages.verify.stepsCard.notes.myVoteIncluded.notPresented'
          : result.statusDetail === 'presented_but_invalid'
            ? 'pages.verify.stepsCard.notes.myVoteIncluded.presentedButInvalid'
            : result.statusDetail === 'unknown_excluded'
              ? 'pages.verify.stepsCard.notes.myVoteIncluded.excluded'
              : undefined;
      return noteKey ? { status, noteKey } : { status };
    }
    return { status };
  } catch {
    const noteKey = resolveCountedMyVoteIncludedNoteKey(input, 'not_run', zkGateStatus);
    return noteKey ? { status: 'not_run', noteKey } : { status: 'not_run' };
  }
}

function resolveCountedMyVoteIncludedNoteKey(
  input: VerificationContext,
  status: VerificationStepStatus | undefined,
  zkGateStatus?: VerificationStepStatus,
): string | undefined {
  if (status !== 'not_run') {
    return undefined;
  }
  if (zkGateStatus) {
    return undefined;
  }

  const resolvedExcludedSlots = resolveExcludedCount({
    journal: input.journal,
    missingSlots: input.missingSlots,
    invalidPresentedSlots: input.invalidPresentedSlots,
    excludedSlots: input.excludedSlots,
  });
  if (typeof resolvedExcludedSlots === 'number' && resolvedExcludedSlots > 0) {
    return 'pages.verify.stepsCard.notes.myVoteIncluded.excluded';
  }

  const includedBitmapRoot = input.journal?.includedBitmapRoot ?? input.includedBitmapRoot;
  const bulletinIndex = input.voteReceipt?.bulletinIndex;
  if (!includedBitmapRoot || typeof bulletinIndex !== 'number' || !Number.isInteger(bulletinIndex)) {
    return 'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt';
  }

  if (input.bitmapProofSource !== 'mock' && input.bitmapProofSource !== 'real') {
    return 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable';
  }

  return undefined;
}

function resolveStarkImageIdMatch(ctx: VerificationContext, status: VerificationStepStatus): CheckResult {
  if (status === 'running' || status === 'not_run' || status === 'failed') {
    return { status };
  }

  const report = ctx.verificationReport;
  const claimedImageId = ctx.claimedImageId;
  const comparisonImageId = ctx.comparisonImageId;

  if (claimedImageId && comparisonImageId) {
    if (normalizeHexString(claimedImageId) !== normalizeHexString(comparisonImageId)) {
      return { status: 'failed', error: 'Claimed ImageID does not match comparison evidence.' };
    }
  }

  if (report?.expected_image_id && report.receipt_image_id !== undefined) {
    if (!report.receipt_image_id) {
      return { status: 'failed' };
    }

    const expected = normalizeHexString(report.expected_image_id);
    const receipt = normalizeHexString(report.receipt_image_id);
    if (expected !== receipt) {
      return { status: 'failed' };
    }
    if (claimedImageId && normalizeHexString(claimedImageId) !== receipt) {
      return { status: 'failed', error: 'Claimed ImageID does not match verifier-confirmed receipt ImageID.' };
    }
    if (comparisonImageId && normalizeHexString(comparisonImageId) !== receipt) {
      return {
        status: 'failed',
        error: 'Comparison-only journal ImageID does not match verifier-confirmed receipt ImageID.',
      };
    }
    return { status: 'success' };
  }

  return { status };
}

export function resolveStarkStatus(
  verificationStatus?: VerificationStatus,
  verificationReportStatus?: VerificationStatus,
  allowDevModeVerification?: boolean,
): VerificationStepStatus {
  if (verificationStatus === 'running' || verificationStatus === 'not_run') {
    return verificationStatus;
  }

  const resolvedReportStatus = normalizeVerificationStatus(verificationReportStatus, allowDevModeVerification);
  if (resolvedReportStatus) {
    return resolvedReportStatus;
  }

  return normalizeVerificationStatus(verificationStatus, allowDevModeVerification) ?? 'not_run';
}

function normalizeVerificationStatus(
  status: VerificationStatus | undefined,
  allowDevModeVerification?: boolean,
): VerificationStepStatus | undefined {
  if (!status) {
    return undefined;
  }

  if (status === 'dev_mode') {
    return allowDevModeVerification ? 'success' : 'not_run';
  }

  return status;
}

function resolveZkGateStatus(starkStatus: VerificationStepStatus): VerificationStepStatus | undefined {
  if (starkStatus === 'running') {
    return 'pending';
  }
  if (starkStatus === 'not_run') {
    return 'not_run';
  }
  if (starkStatus === 'failed') {
    return 'failed';
  }
  return undefined;
}

function resolveSthSourcesWithBaseUrl(sources: string[], baseUrl?: string): string[] {
  if (!baseUrl) {
    return sources;
  }

  return sources.map((source) => {
    if (isAbsoluteUrl(source)) {
      return source;
    }
    try {
      return new URL(source, baseUrl).toString();
    } catch {
      return source;
    }
  });
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

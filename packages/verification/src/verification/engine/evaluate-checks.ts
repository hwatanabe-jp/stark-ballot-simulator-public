import type { VerificationStepStatus } from '../step-types';
import type { VerificationCheckId, VerificationCheckNoteKey } from '@stark-ballot/verification/checks';
import { VERIFICATION_CHECK_IDS } from '@stark-ballot/verification/checks';
import { VOTE_CHOICES } from '@stark-ballot/verification/shared/constants';
import { verifyCTMerkleInclusion } from '@stark-ballot/verification/merkle';
import { resolveExcludedCount } from '@stark-ballot/verification/excluded-count';
import { recomputeElectionManifestHash, buildCloseStatement } from '@stark-ballot/verification/public-audit-artifacts';
import { isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { explainVoteInclusionStatus, verifyMyVoteWasCounted } from '@stark-ballot/verification/bitmap-verifier';
import { asAuthenticatedBitmapTreeSize } from '@stark-ballot/verification/bitmap-proof-types';
import { toCanonicalRfc6962Proof } from '@stark-ballot/merkle/rfc6962-proof';
import type { CheckResult, VerificationContext, VerificationStatus } from './types';
import { asBulletinIndex, asLeafIndex } from '../index-identifiers';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { verifyConsistencyProof } from '../consistency-verifier';
import { evaluateLocalCastChecks, type LocalCastCheckResults } from '@stark-ballot/verification/local-cast-checks';

export interface EvaluateChecksOptions {
  applyZkGate?: boolean;
}

interface EvaluationRuntime {
  starkStatus: VerificationStepStatus;
  zkGateStatus?: VerificationStepStatus;
  localCastResults: LocalCastCheckResults;
}

interface EvaluationHelpers {
  evaluate: (id: VerificationCheckId) => Promise<CheckResult>;
}

type CheckEvaluator = (
  ctx: VerificationContext,
  runtime: EvaluationRuntime,
  helpers: EvaluationHelpers,
) => CheckResult | Promise<CheckResult>;

export const CHECK_EVALUATORS: Record<VerificationCheckId, CheckEvaluator> = {
  cast_receipt_present: (_ctx, runtime) => runtime.localCastResults.cast_receipt_present,
  cast_choice_range: (_ctx, runtime) => runtime.localCastResults.cast_choice_range,
  cast_random_format: (_ctx, runtime) => runtime.localCastResults.cast_random_format,
  cast_commitment_match: (_ctx, runtime) => runtime.localCastResults.cast_commitment_match,
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
    localCastResults: evaluateLocalCastChecks(
      omitUndefinedProperties({
        electionId: ctx.electionId,
        voteReceipt: ctx.voteReceipt,
        choice: ctx.userVote?.vote,
        random: ctx.userVote?.random,
      }),
    ),
    ...omitUndefinedProperties({ zkGateStatus: applyZkGate ? resolveZkGateStatus(starkStatus) : undefined }),
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
  let receiptBulletinIndex: ReturnType<typeof asBulletinIndex>;
  let proofLeafIndex: ReturnType<typeof asLeafIndex>;
  try {
    receiptBulletinIndex = asBulletinIndex(voteReceipt.bulletinIndex);
    proofLeafIndex = asLeafIndex(proof.leafIndex);
  } catch {
    return { status: 'failed', error: 'Inclusion proof leaf index is invalid.' };
  }
  if (Number(proofLeafIndex) !== Number(receiptBulletinIndex)) {
    return { status: 'failed', error: 'Inclusion proof leaf index does not match receipt bulletin index.' };
  }

  if (typeof proof.treeSize !== 'number') {
    return { status: 'not_run' };
  }
  if (!Number.isInteger(proof.treeSize) || proof.treeSize <= 0) {
    return { status: 'failed', error: 'Inclusion proof tree size is invalid.' };
  }
  if (proof.treeSize !== Number(receiptBulletinIndex) + 1) {
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
  let receiptBulletinIndex: ReturnType<typeof asBulletinIndex>;
  try {
    receiptBulletinIndex = asBulletinIndex(voteReceipt.bulletinIndex);
  } catch {
    return { status: 'failed', error: 'Invalid bulletin index' };
  }
  return Number(receiptBulletinIndex) < treeSize
    ? { status: 'success' }
    : { status: 'failed', error: 'Invalid bulletin index' };
}

function resolveRecordedConsistencyProof(input: VerificationContext): CheckResult {
  const { consistencyProof, voteReceipt, bulletinRoot, treeSize, userVote } = input;
  if (!voteReceipt || !voteReceipt.bulletinRootAtCast || !bulletinRoot || typeof treeSize !== 'number') {
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
  const receiptBulletinIndex = asBulletinIndex(voteReceipt.bulletinIndex);
  const proofLeafIndex = asLeafIndex(proof.leafIndex);
  if (Number(proofLeafIndex) !== Number(receiptBulletinIndex)) {
    return { status: 'failed', error: 'Consistency proof leaf index does not match receipt bulletin index.' };
  }
  if (!Number.isInteger(proof.treeSize) || proof.treeSize <= 0) {
    return { status: 'failed', error: 'Consistency proof tree size is invalid.' };
  }
  if (proof.treeSize !== Number(receiptBulletinIndex) + 1) {
    return { status: 'failed', error: 'Consistency proof tree size does not match the cast snapshot.' };
  }
  if (normalizeHexString(proof.bulletinRootAtCast) !== normalizeHexString(voteReceipt.bulletinRootAtCast)) {
    return { status: 'failed', error: 'Root mismatch: receipt and inclusion proof disagree' };
  }
  if (proof.treeSize > newSize) {
    return { status: 'failed', error: 'Consistency proof tree size exceeds final bulletin size.' };
  }

  if (!consistencyProof || consistencyProof.kind === 'unavailable') {
    return { status: 'not_run' };
  }
  if (consistencyProof.kind !== 'admitted') {
    return {
      status: 'failed',
      error: consistencyProof.message ?? 'Consistency proof evidence could not be admitted.',
    };
  }

  const result = verifyConsistencyProof(consistencyProof.value, {
    fromTreeSize: proof.treeSize,
    toTreeSize: newSize,
    rootAtFromTreeSize: voteReceipt.bulletinRootAtCast,
    rootAtToTreeSize: bulletinRoot,
  });
  return result.isValid
    ? { status: 'success' }
    : { status: 'failed', error: result.error ?? 'Consistency proof verification failed.' };
}

function resolveRecordedSthThirdParty(input: VerificationContext): CheckResult {
  const sthDigest = input.journal?.sthDigest ?? input.sthDigest;
  const bulletinRoot = input.journal?.bulletinRoot ?? input.bulletinRoot;
  const treeSize = input.journal?.treeSize ?? input.treeSize;
  if (!sthDigest || !bulletinRoot || typeof treeSize !== 'number') {
    return { status: 'not_run' };
  }

  if (input.sthSourcesConfigured !== true) {
    return { status: 'not_run' };
  }

  const result = input.sthVerification;
  if (!result) {
    return { status: 'not_run' };
  }
  const status: VerificationStepStatus = result.verified ? 'success' : 'failed';
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
  const journalCountError = resolveInvalidJournalCounts(input.journal);
  if (journalCountError) {
    return journalCountError;
  }

  const resolvedExcludedSlots = resolveExcludedCount({
    ...omitUndefinedProperties({
      journal: input.journal,
      missingSlots: input.missingSlots,
      invalidPresentedSlots: input.invalidPresentedSlots,
      excludedSlots: input.excludedSlots,
    }),
  });

  if (typeof resolvedExcludedSlots !== 'number') {
    return { status: 'not_run' };
  }

  if (resolvedExcludedSlots > 0) {
    return { status: 'failed', error: `excludedSlots=${resolvedExcludedSlots}` };
  }
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }
  return { status: 'success' };
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

function resolveCountedMyVoteIncluded(input: VerificationContext, zkGateStatus?: VerificationStepStatus): CheckResult {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const includedBitmapRoot = input.journal?.includedBitmapRoot ?? input.includedBitmapRoot;
  const seenBitmapRoot = input.journal?.seenBitmapRoot ?? input.seenBitmapRoot;
  const treeSizeCandidate = input.journal?.treeSize ?? input.treeSize;
  let authenticatedTreeSize: ReturnType<typeof asAuthenticatedBitmapTreeSize> | undefined;
  if (typeof treeSizeCandidate === 'number') {
    try {
      authenticatedTreeSize = asAuthenticatedBitmapTreeSize(treeSizeCandidate);
    } catch {
      authenticatedTreeSize = undefined;
    }
  }
  const bulletinIndex = input.voteReceipt?.bulletinIndex;
  if (!includedBitmapRoot || typeof bulletinIndex !== 'number' || !Number.isInteger(bulletinIndex)) {
    const noteKey = resolveCountedMyVoteIncludedNoteKey(input, 'not_run', zkGateStatus);
    return noteKey ? { status: 'not_run', noteKey } : { status: 'not_run' };
  }

  if (authenticatedTreeSize === undefined) {
    const noteKey = resolveCountedMyVoteIncludedNoteKey(input, 'not_run', zkGateStatus);
    return noteKey ? { status: 'not_run', noteKey } : { status: 'not_run' };
  }

  if (input.bitmapProofSource !== 'mock' && input.bitmapProofSource !== 'real') {
    const noteKey = resolveCountedMyVoteIncludedNoteKey(input, 'not_run', zkGateStatus);
    return noteKey ? { status: 'not_run', noteKey } : { status: 'not_run' };
  }

  if (!input.includedBitmapProof || input.includedBitmapProof.kind !== 'admitted') {
    const noteKey = resolveCountedMyVoteIncludedNoteKey(input, 'not_run', zkGateStatus);
    return noteKey ? { status: 'not_run', noteKey } : { status: 'not_run' };
  }

  try {
    const result = seenBitmapRoot
      ? explainVoteInclusionStatus(
          bulletinIndex,
          {
            includedBitmapRoot,
            seenBitmapRoot,
          },
          {
            includedProof: input.includedBitmapProof.value,
            ...(input.seenBitmapProof?.kind === 'admitted' ? { seenProof: input.seenBitmapProof.value } : {}),
            treeSize: authenticatedTreeSize,
          },
        )
      : verifyMyVoteWasCounted(bulletinIndex, includedBitmapRoot, {
          proof: input.includedBitmapProof.value,
          treeSize: authenticatedTreeSize,
        });
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
): VerificationCheckNoteKey | undefined {
  if (status !== 'not_run') {
    return undefined;
  }
  if (zkGateStatus) {
    return undefined;
  }

  const resolvedExcludedSlots = resolveExcludedCount({
    ...omitUndefinedProperties({
      journal: input.journal,
      missingSlots: input.missingSlots,
      invalidPresentedSlots: input.invalidPresentedSlots,
      excludedSlots: input.excludedSlots,
    }),
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

function isValidImageId(value: unknown): value is string {
  return typeof value === 'string' && isValidHexString(value, 32);
}

function resolveStarkImageIdMatch(ctx: VerificationContext, status: VerificationStepStatus): CheckResult {
  if (status === 'running' || status === 'not_run' || status === 'failed') {
    return { status };
  }

  const report = ctx.verificationReport;
  const claimedImageId = ctx.claimedImageId;
  const comparisonImageId = ctx.comparisonImageId;

  if (
    (claimedImageId !== undefined && !isValidImageId(claimedImageId)) ||
    (comparisonImageId !== undefined && !isValidImageId(comparisonImageId)) ||
    (report?.expected_image_id !== undefined && !isValidImageId(report.expected_image_id)) ||
    (report?.receipt_image_id !== undefined &&
      report.receipt_image_id !== null &&
      !isValidImageId(report.receipt_image_id))
  ) {
    return { status: 'failed', error: 'ImageID evidence must be a 32-byte hexadecimal value.' };
  }

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

  return { status: 'not_run' };
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

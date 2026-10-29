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
import type {
  AdmittedVerificationEvidence,
  AdmittedVerifierOutcome,
  CheckResult,
  VerificationCheckContext,
  VerificationEvaluationInput,
} from './types';
import { asBulletinIndex, asLeafIndex } from '../index-identifiers';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { verifyConsistencyProof } from '../consistency-verifier';
import { evaluateLocalCastChecks, type LocalCastCheckResults } from '@stark-ballot/verification/local-cast-checks';
import { admitVerificationEvidence, evidenceValue } from './admit-evidence';

export { admitVerifierOutcome } from './admit-evidence';

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

const ZK_GATE_CONTROLLED_CHECK_IDS = new Set<VerificationCheckId>([
  'counted_tally_consistent',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'counted_my_vote_included',
  'counted_input_commitment_match',
]);

/** Identifies checks whose status is replaced outright by a non-success zkVM gate. */
export function isCheckStatusZkGateControlled(id: VerificationCheckId): boolean {
  return ZK_GATE_CONTROLLED_CHECK_IDS.has(id);
}

type CheckEvaluator<Id extends VerificationCheckId> = (
  ctx: VerificationCheckContext<Id>,
  runtime: EvaluationRuntime,
  helpers: EvaluationHelpers,
) => CheckResult | Promise<CheckResult>;

type CheckEvaluatorMap = { readonly [Id in VerificationCheckId]: CheckEvaluator<Id> };
type CheckContextSelectorMap = {
  readonly [Id in VerificationCheckId]: (evidence: AdmittedVerificationEvidence) => VerificationCheckContext<Id>;
};

const NO_CHECK_EVIDENCE = {};

export const CHECK_EVALUATORS: CheckEvaluatorMap = {
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

const CHECK_CONTEXT_SELECTORS: CheckContextSelectorMap = {
  cast_receipt_present: () => NO_CHECK_EVIDENCE,
  cast_choice_range: () => NO_CHECK_EVIDENCE,
  cast_random_format: () => NO_CHECK_EVIDENCE,
  cast_commitment_match: () => NO_CHECK_EVIDENCE,
  recorded_commitment_in_bulletin: () => NO_CHECK_EVIDENCE,
  recorded_index_in_range: (evidence) => ({
    voteReceipt: evidenceValue(evidence.userReceipt.voteReceipt),
    treeSize: evidenceValue(evidence.artifacts.treeSize),
  }),
  recorded_root_at_cast_consistent: () => NO_CHECK_EVIDENCE,
  recorded_inclusion_proof: (evidence) => ({
    voteReceipt: evidenceValue(evidence.userReceipt.voteReceipt),
    userVote: evidenceValue(evidence.userReceipt.userVote),
  }),
  recorded_consistency_proof: (evidence) => ({
    voteReceipt: evidenceValue(evidence.userReceipt.voteReceipt),
    userVote: evidenceValue(evidence.userReceipt.userVote),
    bulletinRoot: evidenceValue(evidence.artifacts.bulletinRoot),
    treeSize: evidenceValue(evidence.artifacts.treeSize),
    consistencyProof: evidence.artifacts.consistencyProof,
  }),
  recorded_sth_third_party: (evidence) => ({
    journal: evidenceValue(evidence.artifacts.journal),
    sthDigest: evidenceValue(evidence.artifacts.sthDigest),
    bulletinRoot: evidenceValue(evidence.artifacts.bulletinRoot),
    treeSize: evidenceValue(evidence.artifacts.treeSize),
    sthSourcesConfigured: evidenceValue(evidence.identity.sthSourcesConfigured),
    sthVerification: evidenceValue(evidence.artifacts.sthVerification),
  }),
  counted_input_sanity: (evidence) => ({
    publicInputAuthority: evidenceValue(evidence.artifacts.publicInputAuthority),
  }),
  counted_unique_indices: (evidence) => ({
    publicInputAuthority: evidenceValue(evidence.artifacts.publicInputAuthority),
  }),
  counted_unique_commitments: (evidence) => ({
    publicInputAuthority: evidenceValue(evidence.artifacts.publicInputAuthority),
  }),
  counted_tally_consistent: (evidence) => ({
    journal: evidenceValue(evidence.artifacts.journal),
    tally: evidenceValue(evidence.tally.tally),
    verifiedTally: evidenceValue(evidence.tally.verifiedTally),
  }),
  counted_missing_indices_zero: (evidence) => ({
    journal: evidenceValue(evidence.artifacts.journal),
    missingSlots: evidenceValue(evidence.tally.missingSlots),
    invalidPresentedSlots: evidenceValue(evidence.tally.invalidPresentedSlots),
    excludedSlots: evidenceValue(evidence.tally.excludedSlots),
  }),
  counted_expected_vs_tree_size: (evidence) => ({
    journal: evidenceValue(evidence.artifacts.journal),
    totalExpected: evidenceValue(evidence.tally.totalExpected),
    treeSize: evidenceValue(evidence.artifacts.treeSize),
  }),
  counted_election_manifest_consistent: (evidence) => ({
    electionManifest: evidenceValue(evidence.artifacts.electionManifest),
    electionId: evidenceValue(evidence.identity.electionId),
    electionConfigHash: evidenceValue(evidence.identity.electionConfigHash),
    publicInputAuthority: evidenceValue(evidence.artifacts.publicInputAuthority),
    journal: evidenceValue(evidence.artifacts.journal),
  }),
  counted_close_statement_consistent: (evidence) => ({
    closeStatement: evidenceValue(evidence.artifacts.closeStatement),
    publicInputAuthority: evidenceValue(evidence.artifacts.publicInputAuthority),
    logId: evidenceValue(evidence.identity.logId),
    treeSize: evidenceValue(evidence.artifacts.treeSize),
    journal: evidenceValue(evidence.artifacts.journal),
    bulletinRoot: evidenceValue(evidence.artifacts.bulletinRoot),
    sthDigest: evidenceValue(evidence.artifacts.sthDigest),
  }),
  counted_my_vote_included: (evidence) => ({
    journal: evidenceValue(evidence.artifacts.journal),
    includedBitmapRoot: evidenceValue(evidence.artifacts.includedBitmapRoot),
    seenBitmapRoot: evidenceValue(evidence.artifacts.seenBitmapRoot),
    treeSize: evidenceValue(evidence.artifacts.treeSize),
    voteReceipt: evidenceValue(evidence.userReceipt.voteReceipt),
    bitmapProofSource: evidenceValue(evidence.artifacts.bitmapProofSource),
    includedBitmapProof: evidence.artifacts.includedBitmapProof,
    seenBitmapProof: evidence.artifacts.seenBitmapProof,
    missingSlots: evidenceValue(evidence.tally.missingSlots),
    invalidPresentedSlots: evidenceValue(evidence.tally.invalidPresentedSlots),
    excludedSlots: evidenceValue(evidence.tally.excludedSlots),
  }),
  counted_input_commitment_match: (evidence) => ({
    journal: evidenceValue(evidence.artifacts.journal),
    inputCommitment: evidenceValue(evidence.tally.inputCommitment),
    publicInputAuthority: evidenceValue(evidence.artifacts.publicInputAuthority),
  }),
  stark_image_id_match: (evidence) => ({
    claimedImageId: evidenceValue(evidence.identity.claimedImageId),
    comparisonImageId: evidenceValue(evidence.identity.comparisonImageId),
    verificationReport:
      evidence.verifierOutcome.report.availability === 'available' ? evidence.verifierOutcome.report.value : undefined,
  }),
  stark_receipt_verify: () => NO_CHECK_EVIDENCE,
};

/**
 * Evaluate a targeted subset of verification checks.
 */
export async function evaluateChecks(
  input: VerificationEvaluationInput,
  checkIds: readonly VerificationCheckId[],
  options: EvaluateChecksOptions = {},
): Promise<Map<VerificationCheckId, CheckResult>> {
  const evidence = admitVerificationEvidence(input);
  const applyZkGate = options.applyZkGate ?? true;
  const starkStatus = resolveStarkStatus(
    evidence.verifierOutcome,
    evidenceValue(evidence.identity.allowDevModeVerification),
  );
  const runtime: EvaluationRuntime = {
    starkStatus,
    localCastResults: evaluateLocalCastChecks(
      omitUndefinedProperties({
        electionId: evidenceValue(evidence.identity.electionId),
        voteReceipt: evidenceValue(evidence.userReceipt.voteReceipt),
        choice: evidenceValue(evidence.userReceipt.userVote)?.vote,
        random: evidenceValue(evidence.userReceipt.userVote)?.random,
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
      const resultPromise = Promise.resolve(evaluateSelectedCheck(id, evidence, runtime, helpers));
      cache.set(id, resultPromise);
      return resultPromise;
    },
  };

  const entries = await Promise.all(checkIds.map(async (id) => [id, await helpers.evaluate(id)] as const));

  return new Map(entries);
}

export async function evaluateAllChecks(
  ctx: VerificationEvaluationInput,
  options: EvaluateChecksOptions = {},
): Promise<Map<VerificationCheckId, CheckResult>> {
  return evaluateChecks(ctx, VERIFICATION_CHECK_IDS, options);
}

function evaluateSelectedCheck<Id extends VerificationCheckId>(
  id: Id,
  evidence: AdmittedVerificationEvidence,
  runtime: EvaluationRuntime,
  helpers: EvaluationHelpers,
): CheckResult | Promise<CheckResult> {
  // Both mapped registries are checked over the same closed ID set above;
  // TypeScript does not retain that key correlation for the evaluator lookup.
  const evaluator = CHECK_EVALUATORS[id] as CheckEvaluator<Id>;
  const selectContext = CHECK_CONTEXT_SELECTORS[id];
  return evaluator(selectContext(evidence), runtime, helpers);
}

export function resolveRecordedInclusionProof(ctx: VerificationCheckContext<'recorded_inclusion_proof'>): CheckResult {
  const userVote = ctx.userVote;
  const voteReceipt = ctx.voteReceipt;
  const proof = toCanonicalRfc6962Proof(userVote?.proof);
  const commitment = userVote?.commitment;
  if (!proof || !voteReceipt || !commitment) {
    return { status: 'not_run' };
  }

  if (!isValidCount(voteReceipt.bulletinIndex)) {
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
    const included = verifyCTMerkleInclusion(
      commitment,
      proof.merklePath,
      proof.leafIndex,
      proof.bulletinRootAtCast,
      proof.treeSize,
    );
    return included ? { status: 'success' } : { status: 'failed', error: 'Inclusion proof verification failed.' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Inclusion proof verification failed.',
    };
  }
}

export function resolveRecordedIndexInRange(
  voteReceipt: VerificationCheckContext<'recorded_index_in_range'>['voteReceipt'],
  treeSize?: number,
): CheckResult {
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

function isPositiveTreeSize(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validateConsistencySnapshot(
  proof: NonNullable<ReturnType<typeof toCanonicalRfc6962Proof>>,
  voteReceipt: NonNullable<VerificationCheckContext<'recorded_consistency_proof'>['voteReceipt']>,
  newSize: number,
): CheckResult | undefined {
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

  return undefined;
}

function hasReceiptCastRoot(
  receipt: VerificationCheckContext<'recorded_consistency_proof'>['voteReceipt'],
): receipt is NonNullable<typeof receipt> {
  return !!receipt && !!receipt.bulletinRootAtCast;
}

function resolveRecordedConsistencyProof(input: VerificationCheckContext<'recorded_consistency_proof'>): CheckResult {
  const { consistencyProof, voteReceipt, bulletinRoot, treeSize, userVote } = input;
  if (!hasReceiptCastRoot(voteReceipt) || !bulletinRoot || typeof treeSize !== 'number') {
    return { status: 'not_run' };
  }

  const newSize = treeSize;
  if (!isPositiveTreeSize(newSize)) {
    return { status: 'not_run' };
  }

  const proof = toCanonicalRfc6962Proof(userVote?.proof);
  if (!proof) {
    return { status: 'not_run' };
  }

  if (!isValidCount(voteReceipt.bulletinIndex)) {
    return { status: 'not_run' };
  }
  const snapshotError = validateConsistencySnapshot(proof, voteReceipt, newSize);
  if (snapshotError) return snapshotError;

  return verifyAdmittedConsistencyProof(consistencyProof, {
    fromTreeSize: proof.treeSize,
    toTreeSize: newSize,
    rootAtFromTreeSize: voteReceipt.bulletinRootAtCast,
    rootAtToTreeSize: bulletinRoot,
  });
}

function verifyAdmittedConsistencyProof(
  consistencyProof: VerificationCheckContext<'recorded_consistency_proof'>['consistencyProof'],
  snapshot: Parameters<typeof verifyConsistencyProof>[1],
): CheckResult {
  if (consistencyProof.kind === 'unavailable') {
    return { status: 'not_run' };
  }
  if (consistencyProof.kind !== 'admitted') {
    return {
      status: 'failed',
      error: consistencyProof.message ?? 'Consistency proof evidence could not be admitted.',
    };
  }

  const result = verifyConsistencyProof(consistencyProof.value, snapshot);
  return result.isValid
    ? { status: 'success' }
    : { status: 'failed', error: result.error ?? 'Consistency proof verification failed.' };
}

function hasPublicSthEvidence(input: VerificationCheckContext<'recorded_sth_third_party'>): boolean {
  const sthDigest = input.journal?.sthDigest ?? input.sthDigest;
  const bulletinRoot = input.journal?.bulletinRoot ?? input.bulletinRoot;
  const treeSize = input.journal?.treeSize ?? input.treeSize;
  return !!sthDigest && !!bulletinRoot && typeof treeSize === 'number';
}

function resolveRecordedSthThirdParty(input: VerificationCheckContext<'recorded_sth_third_party'>): CheckResult {
  if (!hasPublicSthEvidence(input)) return { status: 'not_run' };

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

function resolveCountedInputSanity(input: VerificationCheckContext<'counted_input_sanity'>): CheckResult {
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

function resolveCountedUniqueIndices(input: VerificationCheckContext<'counted_unique_indices'>): CheckResult {
  const publicInput = input.publicInputAuthority;
  if (!publicInput) {
    return { status: 'not_run' };
  }
  return publicInput.uniqueIndices ? { status: 'success' } : { status: 'failed' };
}

function resolveCountedUniqueCommitments(input: VerificationCheckContext<'counted_unique_commitments'>): CheckResult {
  const publicInput = input.publicInputAuthority;
  if (!publicInput) {
    return { status: 'not_run' };
  }
  return publicInput.uniqueCommitments ? { status: 'success' } : { status: 'failed' };
}

export function resolveCountedTallyConsistent(
  input: VerificationCheckContext<'counted_tally_consistent'>,
  zkGateStatus?: VerificationStepStatus,
): CheckResult {
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
    return comparePublishedTally(counts, totalVotes, verifiedTally);
  }

  return validateJournalTally(journal);
}

function comparePublishedTally(
  counts: NonNullable<NonNullable<VerificationCheckContext<'counted_tally_consistent'>['tally']>['counts']>,
  totalVotes: number,
  verifiedTally: number[],
): CheckResult {
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

function validateJournalTally(journal: VerificationCheckContext<'counted_tally_consistent'>['journal']): CheckResult {
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

export function resolveCountedMissingIndicesZero(
  input: VerificationCheckContext<'counted_missing_indices_zero'>,
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

export function resolveCountedExpectedVsTreeSize(
  input: VerificationCheckContext<'counted_expected_vs_tree_size'>,
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
  input: VerificationCheckContext<'counted_input_commitment_match'>,
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
  input: VerificationCheckContext<'counted_election_manifest_consistent'>,
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

  return compareElectionManifestInputs(input, manifest, recomputedHash);
}

function compareElectionManifestInputs(
  input: VerificationCheckContext<'counted_election_manifest_consistent'>,
  manifest: NonNullable<VerificationCheckContext<'counted_election_manifest_consistent'>['electionManifest']>,
  recomputedHash: string,
): CheckResult {
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

function validateCloseStatementArtifact(
  closeStatement: NonNullable<VerificationCheckContext<'counted_close_statement_consistent'>['closeStatement']>,
): CheckResult | undefined {
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
  return undefined;
}

function resolveCountedCloseStatementConsistent(
  input: VerificationCheckContext<'counted_close_statement_consistent'>,
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

  const artifactError = validateCloseStatementArtifact(closeStatement);
  if (artifactError) return artifactError;
  if (closeStatement.timestamp !== publicInputTimestamp) {
    return { status: 'failed', error: 'Close statement timestamp does not match public input.' };
  }

  return compareCloseStatementInputs(input, closeStatement, closeStatement.sthDigest);
}

function compareCloseStatementInputs(
  input: VerificationCheckContext<'counted_close_statement_consistent'>,
  closeStatement: NonNullable<VerificationCheckContext<'counted_close_statement_consistent'>['closeStatement']>,
  admittedDigest: string,
): CheckResult {
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
  if (candidateDigests.some((value) => normalizeHexString(value) !== normalizeHexString(admittedDigest))) {
    return { status: 'failed', error: 'Close statement STH digest does not match verification inputs.' };
  }

  return { status: 'success' };
}

function resolveInvalidJournalCounts(
  journal: VerificationCheckContext<'counted_missing_indices_zero'>['journal'],
): CheckResult | undefined {
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

function hasBitmapReceiptPosition(index: number | undefined): index is number {
  return typeof index === 'number' && Number.isInteger(index);
}

function admitBitmapTreeSize(
  treeSizeCandidate: number | undefined,
): ReturnType<typeof asAuthenticatedBitmapTreeSize> | undefined {
  let authenticatedTreeSize: ReturnType<typeof asAuthenticatedBitmapTreeSize> | undefined;
  if (typeof treeSizeCandidate === 'number') {
    try {
      authenticatedTreeSize = asAuthenticatedBitmapTreeSize(treeSizeCandidate);
    } catch {
      authenticatedTreeSize = undefined;
    }
  }
  return authenticatedTreeSize;
}

function unresolvedMyVoteCheck(input: VerificationCheckContext<'counted_my_vote_included'>): CheckResult {
  const noteKey = resolveCountedMyVoteIncludedNoteKey(input);
  return noteKey ? { status: 'not_run', noteKey } : { status: 'not_run' };
}

function resolveBitmapProofAuthority(input: VerificationCheckContext<'counted_my_vote_included'>) {
  return {
    includedBitmapRoot: input.journal?.includedBitmapRoot ?? input.includedBitmapRoot,
    seenBitmapRoot: input.journal?.seenBitmapRoot ?? input.seenBitmapRoot,
    treeSizeCandidate: input.journal?.treeSize ?? input.treeSize,
  };
}

function hasAdmittedBitmapProofSource(input: VerificationCheckContext<'counted_my_vote_included'>): boolean {
  return input.bitmapProofSource === 'mock' || input.bitmapProofSource === 'real';
}

function resolveCountedMyVoteIncluded(
  input: VerificationCheckContext<'counted_my_vote_included'>,
  zkGateStatus?: VerificationStepStatus,
): CheckResult {
  if (zkGateStatus) {
    return { status: zkGateStatus };
  }

  const { includedBitmapRoot, seenBitmapRoot, treeSizeCandidate } = resolveBitmapProofAuthority(input);
  const authenticatedTreeSize = admitBitmapTreeSize(treeSizeCandidate);
  const bulletinIndex = input.voteReceipt?.bulletinIndex;
  if (!includedBitmapRoot || !hasBitmapReceiptPosition(bulletinIndex)) {
    return unresolvedMyVoteCheck(input);
  }

  if (authenticatedTreeSize === undefined) {
    return unresolvedMyVoteCheck(input);
  }

  if (!hasAdmittedBitmapProofSource(input)) {
    return unresolvedMyVoteCheck(input);
  }

  if (input.includedBitmapProof.kind !== 'admitted') {
    return unresolvedMyVoteCheck(input);
  }

  return evaluateMyVoteBitmapProof(input, {
    bulletinIndex,
    includedBitmapRoot,
    seenBitmapRoot,
    authenticatedTreeSize,
    includedProof: input.includedBitmapProof.value,
  });
}

function evaluateMyVoteBitmapProof(
  input: VerificationCheckContext<'counted_my_vote_included'>,
  evidence: {
    bulletinIndex: number;
    includedBitmapRoot: string;
    seenBitmapRoot: string | undefined;
    authenticatedTreeSize: ReturnType<typeof asAuthenticatedBitmapTreeSize>;
    includedProof: Extract<
      VerificationCheckContext<'counted_my_vote_included'>['includedBitmapProof'],
      { kind: 'admitted' }
    >['value'];
  },
): CheckResult {
  const { bulletinIndex, includedBitmapRoot, seenBitmapRoot, authenticatedTreeSize, includedProof } = evidence;
  try {
    const result = seenBitmapRoot
      ? explainVoteInclusionStatus(
          bulletinIndex,
          {
            includedBitmapRoot,
            seenBitmapRoot,
          },
          {
            includedProof,
            ...(input.seenBitmapProof.kind === 'admitted' ? { seenProof: input.seenBitmapProof.value } : {}),
            treeSize: authenticatedTreeSize,
          },
        )
      : verifyMyVoteWasCounted(bulletinIndex, includedBitmapRoot, {
          proof: includedProof,
          treeSize: authenticatedTreeSize,
        });
    return projectMyVoteProofResult(result);
  } catch {
    return unresolvedMyVoteCheck(input);
  }
}

function projectMyVoteProofResult(
  result: ReturnType<typeof explainVoteInclusionStatus> | ReturnType<typeof verifyMyVoteWasCounted>,
): CheckResult {
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
}

function resolveCountedMyVoteIncludedNoteKey(
  input: VerificationCheckContext<'counted_my_vote_included'>,
): VerificationCheckNoteKey | undefined {
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
  if (!includedBitmapRoot || !hasBitmapReceiptPosition(bulletinIndex)) {
    return 'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt';
  }

  if (!hasAdmittedBitmapProofSource(input)) {
    return 'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable';
  }

  return undefined;
}

function isValidImageId(value: unknown): value is string {
  return typeof value === 'string' && isValidHexString(value, 32);
}

function resolveStarkImageIdMatch(
  ctx: VerificationCheckContext<'stark_image_id_match'>,
  status: VerificationStepStatus,
): CheckResult {
  if (status === 'running' || status === 'not_run' || status === 'failed') {
    return { status };
  }

  const claimedImageId = ctx.claimedImageId;
  const comparisonImageId = ctx.comparisonImageId;

  if (!hasValidImageIdEvidence(ctx))
    return { status: 'failed', error: 'ImageID evidence must be a 32-byte hexadecimal value.' };

  if (claimedImageId && comparisonImageId) {
    if (normalizeHexString(claimedImageId) !== normalizeHexString(comparisonImageId)) {
      return { status: 'failed', error: 'Claimed ImageID does not match comparison evidence.' };
    }
  }

  return compareVerifierImageIds(ctx);
}

function hasValidImageIdEvidence(ctx: VerificationCheckContext<'stark_image_id_match'>): boolean {
  const report = ctx.verificationReport;
  const values = [ctx.claimedImageId, ctx.comparisonImageId, report?.expected_image_id];
  if (values.some((value) => value !== undefined && !isValidImageId(value))) return false;
  return (
    report?.receipt_image_id === undefined ||
    report.receipt_image_id === null ||
    isValidImageId(report.receipt_image_id)
  );
}

function compareVerifierImageIds(ctx: VerificationCheckContext<'stark_image_id_match'>): CheckResult {
  const { verificationReport: report, claimedImageId, comparisonImageId } = ctx;
  if (!report?.expected_image_id || report.receipt_image_id === undefined) return { status: 'not_run' };
  if (!report.receipt_image_id) return { status: 'failed' };
  return compareConfirmedReceiptImageId(
    { ...report, expected_image_id: report.expected_image_id, receipt_image_id: report.receipt_image_id },
    claimedImageId,
    comparisonImageId,
  );
}

function compareConfirmedReceiptImageId(
  report: NonNullable<VerificationCheckContext<'stark_image_id_match'>['verificationReport']> & {
    expected_image_id: string;
    receipt_image_id: string;
  },
  claimedImageId: string | undefined,
  comparisonImageId: string | undefined,
): CheckResult {
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

function resolveStarkStatus(
  outcome: AdmittedVerifierOutcome,
  allowDevModeVerification?: boolean,
): VerificationStepStatus {
  if (outcome.status === 'dev_mode') {
    return allowDevModeVerification ? 'success' : 'not_run';
  }
  return outcome.status;
}

export function resolveZkGateStatus(starkStatus: VerificationStepStatus): VerificationStepStatus | undefined {
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

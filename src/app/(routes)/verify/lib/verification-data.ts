import type { SessionData } from '@/lib/session/types';
import type { VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  VERIFICATION_CHECK_IDS,
  VERIFICATION_EVIDENCE_VALUES,
  getVerificationStepInputs,
  type VerificationCheck,
  type VerificationCheckId,
  type VerificationEvidence,
} from '@/lib/verification/verification-checks';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import type { VoteData as DetectionVoteData, Receipt as DetectionReceipt } from '@/lib/verification/types';
import type { VoteChoice } from '@/shared/constants';
import type { VoteReceipt } from '@/types/receipt';
import type { VerificationStatus } from '@/types/server';
import { isSupportedZkVMJournal } from '@/lib/zkvm/journal-guards';
import { isRecord } from '@/lib/utils/guards';
import { resolveApiUrl } from '@/lib/api/apiBaseUrl';
import { buildVerifierPath, isSafeVerifierSegment } from '@/lib/finalize/finalize-urls';
import { toCanonicalRfc6962Proof } from '@/lib/merkle/rfc6962-proof';
import { computeCommitment } from '@/lib/zkvm/types';
import { isValidHexString, normalizeHexString } from '@/lib/utils/hex';

export type BundleSource = 'authenticated-endpoint';
export interface VerificationPayload {
  electionId?: string;
  electionConfigHash?: string;
  tally?: {
    counts?: Record<VoteChoice, number>;
    totalVotes?: number;
    tamperedCount?: number;
  };
  totalVotes?: number;
  scenarioId?: string;
  verificationStatus?: VerificationStatus;
  verificationReport?: {
    status?: VerificationStatus;
    duration_ms?: number;
    errors?: string[];
  };
  verificationSteps?: Array<{
    id: VerificationStepId;
    status: VerificationStepStatus;
    inputs?: string[];
    error?: string;
  }>;
  verificationChecks?: VerificationCheck[];
  imageId?: string;
  tamperDetected?: boolean;
  verifiedTally?: number[];
  bulletinRoot?: string;
  missingSlots?: number;
  invalidPresentedSlots?: number;
  rejectedRecords?: number;
  validVotes?: number;
  totalExpected?: number;
  treeSize?: number;
  excludedSlots?: number;
  sthDigest?: string;
  seenBitmapRoot?: string;
  includedBitmapRoot?: string;
  inputCommitment?: string;
  seenIndicesCount?: number;
  journalStatus?: 'available' | 'omitted' | 'unavailable';
  journal?: ZkVMJournal;
  voteReceipt?: VoteReceipt;
  userVote?: {
    vote?: VoteChoice;
    commitment: string;
    random?: string;
    voteId?: string;
    proof?: {
      leafIndex: number;
      treeSize: number;
      merklePath: string[];
      bulletinRootAtCast: string;
    };
  };
  botVotesSummary?: {
    total?: number;
    affectedBotIds?: number[];
    source?: string;
  };
  verificationExecutionId?: string;
}

export interface DownloadCandidate {
  url: string;
  source: BundleSource;
  sessionId: string;
  executionId: string;
}

export const VOTE_OPTIONS: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];
const VERIFICATION_STATUS_VALUES: ReadonlyArray<VerificationStatus> = [
  'success',
  'failed',
  'dev_mode',
  'not_run',
  'running',
];
const VERIFICATION_STEP_STATUS_VALUES: ReadonlyArray<VerificationStepStatus> = [
  'pending',
  'running',
  'success',
  'failed',
  'not_run',
];
const CAST_CHECK_IDS: readonly VerificationCheckId[] = [
  'cast_receipt_present',
  'cast_choice_range',
  'cast_random_format',
  'cast_commitment_match',
];
const CAST_STEP_INPUTS: string[] = getVerificationStepInputs('cast_as_intended');

const CHECK_DEFINITION_BY_ID = new Map(VERIFICATION_CHECK_DEFINITIONS.map((definition) => [definition.id, definition]));

function toVoteChoice(value: unknown): VoteChoice | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const upper = value.toUpperCase();
  if (['A', 'B', 'C', 'D', 'E'].includes(upper)) {
    return upper as VoteChoice;
  }
  return undefined;
}

function toVerificationStatus(value: unknown): VerificationStatus | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return VERIFICATION_STATUS_VALUES.find((status) => status === value);
}

export function resolveStarkStatus(
  verificationStatus?: VerificationStatus,
  verificationReport?: { status?: VerificationStatus },
): VerificationStatus {
  if (verificationStatus === 'running' || verificationStatus === 'not_run') {
    return verificationStatus;
  }

  const reportStatus = toVerificationStatus(verificationReport?.status);
  if (reportStatus) {
    return reportStatus;
  }

  return toVerificationStatus(verificationStatus) ?? 'not_run';
}

function toVerificationStepStatus(value: unknown): VerificationStepStatus | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return VERIFICATION_STEP_STATUS_VALUES.find((status) => status === value);
}

function toVerificationCheckId(value: unknown): VerificationCheckId | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return VERIFICATION_CHECK_IDS.find((id) => id === value);
}

function toVerificationEvidence(value: unknown): VerificationEvidence | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return VERIFICATION_EVIDENCE_VALUES.find((evidence) => evidence === value);
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseTallyCounts(value: unknown): Record<VoteChoice, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const counts: Record<VoteChoice, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
  };

  let hasAny = false;
  for (const choice of VOTE_OPTIONS) {
    const count = coerceNumber(value[choice]);
    if (typeof count === 'number') {
      counts[choice] = count;
      hasAny = true;
    }
  }

  return hasAny ? counts : undefined;
}

export interface InclusionProofPayload {
  leafIndex: number;
  treeSize: number;
  merklePath: string[];
  bulletinRootAtCast: string;
}

export function parseInclusionProof(value: unknown): InclusionProofPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'proofMode')) {
    return undefined;
  }
  const canonicalProof = toCanonicalRfc6962Proof({
    leafIndex: coerceNumber(value.leafIndex),
    treeSize: coerceNumber(value.treeSize),
    merklePath: Array.isArray(value.merklePath)
      ? value.merklePath.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    bulletinRootAtCast: typeof value.bulletinRootAtCast === 'string' ? value.bulletinRootAtCast : undefined,
  });

  return canonicalProof;
}

export function isZkVMJournal(value: unknown): value is ZkVMJournal {
  return isSupportedZkVMJournal(value);
}

function resolveCanonicalJournalPayloadFields(journal: ZkVMJournal | undefined): Partial<VerificationPayload> {
  if (!journal) {
    return {};
  }

  return {
    verifiedTally: [...journal.verifiedTally],
    bulletinRoot: journal.bulletinRoot,
    missingSlots: journal.missingSlots,
    invalidPresentedSlots: journal.invalidPresentedSlots,
    rejectedRecords: journal.rejectedRecords,
    validVotes: journal.validVotes,
    totalExpected: journal.totalExpected,
    treeSize: journal.treeSize,
    excludedSlots: journal.excludedSlots,
    sthDigest: journal.sthDigest,
    seenBitmapRoot: journal.seenBitmapRoot,
    includedBitmapRoot: journal.includedBitmapRoot,
    inputCommitment: journal.inputCommitment,
    seenIndicesCount: journal.seenIndicesCount,
  };
}

export function buildCastIntent(
  session: SessionData | null,
): { electionId: string; choice: VoteChoice; random: string } | null {
  if (!session) {
    return null;
  }

  const electionId = session.electionId;
  const choice = session.myVote;
  const random = session.myRand;

  if (!electionId || !choice || !random) {
    return null;
  }

  return {
    electionId,
    choice,
    random,
  };
}

interface LocalCastCheckResult {
  status: VerificationStepStatus;
  error?: string;
}

function resolveCastReceiptPresent(voteReceipt?: VoteReceipt): LocalCastCheckResult {
  if (!voteReceipt) {
    return { status: 'not_run' };
  }
  if (!voteReceipt.voteId || !voteReceipt.commitment) {
    return { status: 'failed', error: 'Invalid receipt: missing commitment or voteId' };
  }
  return { status: 'success' };
}

function resolveCastChoiceRange(choice?: VoteChoice): LocalCastCheckResult {
  if (!choice) {
    return { status: 'not_run' };
  }
  if (!VOTE_OPTIONS.includes(choice)) {
    return { status: 'failed', error: `Unknown vote choice "${choice}".` };
  }
  return { status: 'success' };
}

function resolveCastRandomFormat(random?: string): LocalCastCheckResult {
  if (!random) {
    return { status: 'not_run' };
  }
  return isValidHexString(random, 32)
    ? { status: 'success' }
    : { status: 'failed', error: 'Random value must be a 32-byte hex string.' };
}

function resolveCastCommitmentMatch(
  castIntent: ReturnType<typeof buildCastIntent>,
  voteReceipt?: VoteReceipt,
): LocalCastCheckResult {
  if (!castIntent || !voteReceipt?.commitment) {
    return { status: 'not_run' };
  }

  const normalizedCommitment = normalizeHexString(voteReceipt.commitment);
  if (!normalizedCommitment) {
    return { status: 'failed', error: 'Receipt commitment is malformed.' };
  }

  const choiceIndex = VOTE_OPTIONS.indexOf(castIntent.choice);
  if (choiceIndex === -1) {
    return { status: 'failed', error: `Unknown vote choice "${castIntent.choice}".` };
  }

  try {
    const recomputed = computeCommitment(castIntent.electionId, choiceIndex, castIntent.random);
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

function evaluateLocalCastChecks(
  payload: VerificationPayload,
  session: SessionData | null,
): Map<VerificationCheckId, LocalCastCheckResult> {
  const castIntent = buildCastIntent(session);
  const voteReceipt = payload.voteReceipt;
  const results = new Map<VerificationCheckId, LocalCastCheckResult>();

  results.set('cast_receipt_present', resolveCastReceiptPresent(voteReceipt));
  results.set('cast_choice_range', resolveCastChoiceRange(castIntent?.choice));
  results.set('cast_random_format', resolveCastRandomFormat(castIntent?.random));
  results.set('cast_commitment_match', resolveCastCommitmentMatch(castIntent, voteReceipt));

  return results;
}

function buildCastCheckFromResult(id: VerificationCheckId, result: LocalCastCheckResult): VerificationCheck {
  const definition = CHECK_DEFINITION_BY_ID.get(id);
  return {
    id,
    status: result.status,
    evidence: definition?.evidence ?? 'local',
    inputs: definition?.inputs ?? [],
  };
}

function applyLocalCastCheckOverrides(
  existingChecks: VerificationCheck[] | undefined,
  castChecks: Map<VerificationCheckId, LocalCastCheckResult>,
): VerificationCheck[] | undefined {
  if (!existingChecks || existingChecks.length === 0) {
    return CAST_CHECK_IDS.map((castCheckId) => {
      const result = castChecks.get(castCheckId) ?? { status: 'not_run' };
      return buildCastCheckFromResult(castCheckId, result);
    });
  }

  const replaced = existingChecks.map((check) => {
    const override = castChecks.get(check.id);
    if (!override || !CAST_CHECK_IDS.includes(check.id)) {
      return check;
    }
    return buildCastCheckFromResult(check.id, override);
  });

  const present = new Set(replaced.map((check) => check.id));
  for (const castCheckId of CAST_CHECK_IDS) {
    if (present.has(castCheckId)) {
      continue;
    }
    const result = castChecks.get(castCheckId) ?? { status: 'not_run' };
    replaced.push(buildCastCheckFromResult(castCheckId, result));
  }

  return replaced;
}

function deriveCastStep(castChecks: Map<VerificationCheckId, LocalCastCheckResult>): {
  status: VerificationStepStatus;
  error?: string;
} {
  const results = CAST_CHECK_IDS.map((id) => castChecks.get(id) ?? { status: 'not_run' as const });
  if (results.some((result) => result.status === 'failed')) {
    const firstError = results.find((result) => result.status === 'failed')?.error;
    return firstError ? { status: 'failed', error: firstError } : { status: 'failed' };
  }
  if (results.every((result) => result.status === 'success')) {
    return { status: 'success' };
  }
  return { status: 'not_run' };
}

function applyLocalCastStepOverride(
  existingSteps: VerificationPayload['verificationSteps'],
  castStep: { status: VerificationStepStatus; error?: string },
): VerificationPayload['verificationSteps'] {
  if (!existingSteps || existingSteps.length === 0) {
    return [
      {
        id: 'cast_as_intended',
        status: castStep.status,
        inputs: CAST_STEP_INPUTS,
        ...(castStep.error ? { error: castStep.error } : {}),
      },
    ];
  }

  const hasCastStep = existingSteps.some((step) => step.id === 'cast_as_intended');
  if (hasCastStep) {
    return existingSteps.map((step) => {
      if (step.id !== 'cast_as_intended') {
        return step;
      }
      const stepWithoutError = { ...step };
      delete stepWithoutError.error;
      return {
        ...stepWithoutError,
        status: castStep.status,
        inputs: step.inputs ?? CAST_STEP_INPUTS,
        ...(castStep.error ? { error: castStep.error } : {}),
      };
    });
  }

  return [
    ...existingSteps,
    {
      id: 'cast_as_intended',
      status: castStep.status,
      inputs: CAST_STEP_INPUTS,
      ...(castStep.error ? { error: castStep.error } : {}),
    },
  ];
}

export function applyLocalCastAsIntended(
  payload: VerificationPayload,
  session: SessionData | null,
): VerificationPayload {
  const castChecks = evaluateLocalCastChecks(payload, session);
  const castStep = deriveCastStep(castChecks);
  return {
    ...payload,
    verificationChecks: applyLocalCastCheckOverrides(payload.verificationChecks, castChecks),
    verificationSteps: applyLocalCastStepOverride(payload.verificationSteps, castStep),
  };
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const filtered = value.filter((item): item is string => typeof item === 'string');
  return filtered.length > 0 ? filtered : undefined;
}

function parseVerificationCheck(value: unknown): VerificationCheck | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = toVerificationCheckId(value.id);
  const status = toVerificationStepStatus(value.status);
  const evidence = toVerificationEvidence(value.evidence);
  if (!id || !status || !evidence) {
    return null;
  }
  const inputs = coerceStringArray(value.inputs) ?? [];
  const derivedFrom = toVerificationCheckId(value.derivedFrom);
  const noteKey = typeof value.noteKey === 'string' ? value.noteKey : undefined;
  return {
    id,
    status,
    evidence,
    inputs,
    ...(noteKey ? { noteKey } : {}),
    ...(derivedFrom ? { derivedFrom } : {}),
  };
}

export function buildAuthenticatedBundleDownloadUrl(sessionId: string, executionId: string): string {
  return resolveApiUrl(buildVerifierPath(sessionId, executionId));
}

function resolveAuthenticatedBundleCandidate(
  sessionId: string | undefined,
  executionId: string | undefined,
): DownloadCandidate | null {
  if (!sessionId || !executionId) {
    return null;
  }
  if (!isSafeVerifierSegment(sessionId) || !isSafeVerifierSegment(executionId)) {
    return null;
  }

  return {
    url: buildAuthenticatedBundleDownloadUrl(sessionId, executionId),
    source: 'authenticated-endpoint',
    sessionId,
    executionId,
  };
}

export function buildBundleCandidates(data: VerificationPayload | null, sessionId?: string): DownloadCandidate[] {
  if (!data) {
    return [];
  }

  const authenticatedCandidate = resolveAuthenticatedBundleCandidate(sessionId, data.verificationExecutionId);
  return authenticatedCandidate ? [authenticatedCandidate] : [];
}

export function parseVerificationPayload(payload: unknown): VerificationPayload {
  if (!isRecord(payload)) {
    throw new Error('Verification payload missing');
  }

  const tallySource = isRecord(payload.tally) ? payload.tally : undefined;
  const tallyCountsSource = tallySource && isRecord(tallySource.counts) ? tallySource.counts : undefined;
  const tallyCounts = parseTallyCounts(tallyCountsSource);
  const tallyTotalVotes = tallySource ? coerceNumber(tallySource.totalVotes) : undefined;
  const tallyTamperedCount = tallySource ? coerceNumber(tallySource.tamperedCount) : undefined;

  const tally =
    tallyCounts || typeof tallyTotalVotes === 'number' || typeof tallyTamperedCount === 'number'
      ? {
          counts: tallyCounts,
          totalVotes: tallyTotalVotes,
          tamperedCount: tallyTamperedCount,
        }
      : undefined;

  const verifiedTally = Array.isArray(payload.verifiedTally)
    ? payload.verifiedTally.filter((value): value is number => typeof value === 'number')
    : undefined;

  const userVoteSource = isRecord(payload.userVote) ? payload.userVote : undefined;
  const userVoteChoice = userVoteSource ? toVoteChoice(userVoteSource.vote) : undefined;
  const userVoteProof = userVoteSource ? parseInclusionProof(userVoteSource.proof) : undefined;
  const userVoteRandom =
    userVoteSource && typeof userVoteSource.random === 'string' ? userVoteSource.random : undefined;
  const userVote =
    userVoteSource && typeof userVoteSource.commitment === 'string'
      ? {
          vote: userVoteChoice,
          commitment: userVoteSource.commitment,
          random: userVoteRandom,
          voteId: typeof userVoteSource.voteId === 'string' ? userVoteSource.voteId : undefined,
          proof: userVoteProof,
        }
      : undefined;

  const botVotesSummarySource = isRecord(payload.botVotesSummary) ? payload.botVotesSummary : undefined;
  const affectedBotIds =
    botVotesSummarySource && Array.isArray(botVotesSummarySource.affectedBotIds)
      ? botVotesSummarySource.affectedBotIds.filter((value): value is number => typeof value === 'number')
      : undefined;
  const botVotesSummary = botVotesSummarySource
    ? {
        total: coerceNumber(botVotesSummarySource.total),
        affectedBotIds: affectedBotIds ?? [],
        source: typeof botVotesSummarySource.source === 'string' ? botVotesSummarySource.source : undefined,
      }
    : undefined;

  const journal = isZkVMJournal(payload.journal) ? payload.journal : undefined;
  const canonicalJournalFields = resolveCanonicalJournalPayloadFields(journal);

  const voteReceiptSource = isRecord(payload.voteReceipt) ? payload.voteReceipt : undefined;
  const voteReceiptRootAtCast =
    voteReceiptSource && typeof voteReceiptSource.bulletinRootAtCast === 'string'
      ? voteReceiptSource.bulletinRootAtCast
      : undefined;
  const voteReceiptIndex = voteReceiptSource ? coerceNumber(voteReceiptSource.bulletinIndex) : undefined;
  const voteReceiptTimestamp = voteReceiptSource ? coerceNumber(voteReceiptSource.timestamp) : undefined;
  const voteReceipt: VoteReceipt | undefined =
    voteReceiptSource &&
    typeof voteReceiptSource.voteId === 'string' &&
    typeof voteReceiptSource.commitment === 'string' &&
    typeof voteReceiptRootAtCast === 'string' &&
    typeof voteReceiptIndex === 'number' &&
    typeof voteReceiptTimestamp === 'number'
      ? {
          voteId: voteReceiptSource.voteId,
          commitment: voteReceiptSource.commitment,
          bulletinIndex: voteReceiptIndex,
          bulletinRootAtCast: voteReceiptRootAtCast,
          inputCommitment:
            typeof voteReceiptSource.inputCommitment === 'string' ? voteReceiptSource.inputCommitment : undefined,
          timestamp: voteReceiptTimestamp,
        }
      : undefined;

  const verificationReport = isRecord(payload.verificationReport)
    ? {
        status: toVerificationStatus(payload.verificationReport.status),
        duration_ms: coerceNumber(payload.verificationReport.duration_ms),
        errors: coerceStringArray(payload.verificationReport.errors),
      }
    : undefined;
  const verificationSteps = Array.isArray(payload.verificationSteps)
    ? (payload.verificationSteps as VerificationPayload['verificationSteps'])
    : undefined;
  const verificationChecks = Array.isArray(payload.verificationChecks)
    ? payload.verificationChecks
        .map(parseVerificationCheck)
        .filter((entry): entry is VerificationCheck => entry !== null)
    : undefined;

  return {
    electionId: typeof payload.electionId === 'string' ? payload.electionId : undefined,
    electionConfigHash: typeof payload.electionConfigHash === 'string' ? payload.electionConfigHash : undefined,
    tally,
    totalVotes: tallyTotalVotes,
    scenarioId: typeof payload.scenarioId === 'string' ? payload.scenarioId : undefined,
    verificationStatus: toVerificationStatus(payload.verificationStatus),
    verificationReport,
    verificationSteps,
    verificationChecks,
    imageId: typeof payload.imageId === 'string' ? payload.imageId : undefined,
    tamperDetected: typeof payload.tamperDetected === 'boolean' ? payload.tamperDetected : undefined,
    verifiedTally,
    missingSlots: coerceNumber(payload.missingSlots),
    invalidPresentedSlots: coerceNumber(payload.invalidPresentedSlots),
    rejectedRecords: coerceNumber(payload.rejectedRecords),
    validVotes: coerceNumber(payload.validVotes),
    totalExpected: coerceNumber(payload.totalExpected),
    treeSize: coerceNumber(payload.treeSize),
    excludedSlots: coerceNumber(payload.excludedSlots),
    bulletinRoot: typeof payload.bulletinRoot === 'string' ? payload.bulletinRoot : undefined,
    sthDigest: typeof payload.sthDigest === 'string' ? payload.sthDigest : undefined,
    seenBitmapRoot: typeof payload.seenBitmapRoot === 'string' ? payload.seenBitmapRoot : undefined,
    includedBitmapRoot: typeof payload.includedBitmapRoot === 'string' ? payload.includedBitmapRoot : undefined,
    inputCommitment: typeof payload.inputCommitment === 'string' ? payload.inputCommitment : undefined,
    seenIndicesCount: coerceNumber(payload.seenIndicesCount),
    journalStatus:
      payload.journalStatus === 'available' ||
      payload.journalStatus === 'omitted' ||
      payload.journalStatus === 'unavailable'
        ? payload.journalStatus
        : undefined,
    journal,
    voteReceipt,
    userVote,
    botVotesSummary,
    verificationExecutionId:
      typeof payload.verificationExecutionId === 'string' && isSafeVerifierSegment(payload.verificationExecutionId)
        ? payload.verificationExecutionId
        : undefined,
    ...canonicalJournalFields,
  };
}

export function buildDetectionReceipt(data: VerificationPayload): DetectionReceipt | null {
  const counts = data.tally?.counts;
  const bulletinRoot = data.bulletinRoot ?? data.voteReceipt?.bulletinRootAtCast;
  if (!counts || !bulletinRoot) {
    return null;
  }
  return {
    tally: counts,
    bulletinRoot,
    totalVotes: data.tally?.totalVotes ?? 0,
    tamperedCount: data.tally?.tamperedCount ?? 0,
    missingSlots: data.missingSlots,
    invalidPresentedSlots: data.invalidPresentedSlots,
    rejectedRecords: data.rejectedRecords,
    excludedSlots: data.excludedSlots,
    validVotes: data.validVotes,
    verifiedTally: data.verifiedTally,
  };
}

export function buildDetectionVote(data: VerificationPayload, session: SessionData | null): DetectionVoteData | null {
  const proof = data.userVote?.proof;
  if (!data.userVote || !proof || !session?.myVote || !session.myRand) {
    return null;
  }

  return {
    commitment: data.userVote.commitment,
    path: proof.merklePath,
    leafIndex: proof.leafIndex,
    choice: session.myVote,
    random: session.myRand,
    treeSize: proof.treeSize,
  };
}

import type { FinalizeScenarioData } from '@/lib/testing/cli-test-helpers';
import { getStringArrayProperty, isRecord } from '@/lib/utils/guards';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import {
  VERIFICATION_CHECK_IDS,
  type VerificationCheckId,
  type VerificationCheck,
} from '@/lib/verification/verification-checks';
import type { VerificationStep, VerificationStepId, VerificationStepStatus } from '@/lib/knowledge';

export interface ResolvedTallyResult {
  counts: Record<string, number>;
  merkleRoot: string;
  totalVotes: number;
  tamperedCount: number;
}

export interface ReceiptPayload {
  receipt: unknown;
  imageId?: string;
  tamperDetected?: boolean;
}

export interface UserVoteProofSummary {
  commitment?: string;
  merklePath?: string[];
  leafIndex?: number;
  treeSize?: number;
  bulletinRootAtCast?: string;
}

export interface FetchedVoteProof {
  merklePath: string[];
  leafIndex: number;
  treeSize?: number;
  bulletinRootAtCast?: string;
}

const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const satisfies readonly VerificationStepId[];

export const CLI_REQUIRED_VERIFY_CHECK_IDS = [
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'stark_receipt_verify',
] as const satisfies readonly VerificationCheckId[];

const CLI_REQUIRED_VERIFY_STEP_IDS = [
  'counted_as_recorded',
  'stark_verification',
] as const satisfies readonly VerificationStepId[];
const CLI_REQUIRED_COUNTED_STAGE_CHECK_IDS = CLI_REQUIRED_VERIFY_CHECK_IDS.filter(
  (checkId) => checkId !== 'stark_receipt_verify',
);
const CLI_JOURNAL_COUNT_FIELDS = ['missingSlots', 'invalidPresentedSlots', 'validVotes', 'excludedSlots'] as const;

function isVerificationCheckId(value: unknown): value is VerificationCheckId {
  return typeof value === 'string' && VERIFICATION_CHECK_IDS.includes(value as VerificationCheckId);
}

function isVerificationStepId(value: unknown): value is VerificationStepId {
  return typeof value === 'string' && VERIFICATION_STEP_IDS.includes(value as VerificationStepId);
}

function isVerificationStepStatus(value: unknown): value is VerificationStepStatus {
  return value === 'pending' || value === 'running' || value === 'success' || value === 'failed' || value === 'not_run';
}

function isVerificationCheckLike(value: unknown): value is Pick<VerificationCheck, 'id' | 'status'> {
  return isRecord(value) && isVerificationCheckId(value.id) && isVerificationStepStatus(value.status);
}

function isVerificationStepLike(value: unknown): value is Pick<VerificationStep, 'id' | 'status'> {
  return isRecord(value) && isVerificationStepId(value.id) && isVerificationStepStatus(value.status);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'number');
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === 'number' ? candidate : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function isTallyDetail(value: unknown): value is {
  counts: Record<string, number>;
  merkleRoot?: string;
  bulletinRoot?: string;
  totalVotes?: number;
  tamperedCount?: number;
} {
  return isRecord(value) && isNumberRecord(value.counts);
}

export function resolveTallyResult(data: FinalizeScenarioData): ResolvedTallyResult | null {
  const tally = data.tally;
  const tallyDetail = isTallyDetail(tally) ? tally : undefined;
  const counts = tallyDetail?.counts ?? (isNumberRecord(tally) ? tally : undefined);

  if (!counts) {
    return null;
  }

  const merkleRoot =
    (tallyDetail && typeof tallyDetail.merkleRoot === 'string' ? tallyDetail.merkleRoot : undefined) ??
    (tallyDetail && typeof tallyDetail.bulletinRoot === 'string' ? tallyDetail.bulletinRoot : undefined) ??
    (typeof data.merkleRoot === 'string' ? data.merkleRoot : undefined) ??
    (typeof data.bulletinRoot === 'string' ? data.bulletinRoot : undefined);

  if (!merkleRoot) {
    return null;
  }

  const computedTotal = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const totalVotes =
    getNumberProperty(tallyDetail, 'totalVotes') ??
    (typeof data.totalVotes === 'number' ? data.totalVotes : undefined) ??
    computedTotal;
  const tamperedCount =
    getNumberProperty(tallyDetail, 'tamperedCount') ??
    (typeof data.tamperedCount === 'number' ? data.tamperedCount : undefined) ??
    0;

  return {
    counts,
    merkleRoot,
    totalVotes,
    tamperedCount,
  };
}

export function resolveReceiptPayload(data: FinalizeScenarioData): ReceiptPayload | null {
  const proof = data.proof;
  const receipt = proof?.receipt ?? data.receiptEncoded ?? data.receipt ?? data.receiptRaw;

  if (!receipt) {
    return null;
  }

  const imageId = typeof proof?.imageId === 'string' ? proof.imageId : data.imageId;
  const tamperDetected = typeof proof?.tamperDetected === 'boolean' ? proof.tamperDetected : undefined;

  return { receipt, imageId, tamperDetected };
}

export function resolveUserVoteProof(data: FinalizeScenarioData): UserVoteProofSummary | null {
  const userVote = data.userVote;
  if (!isRecord(userVote)) {
    return null;
  }

  const proof = isRecord(userVote.proof) ? userVote.proof : undefined;

  const commitment = getStringProperty(userVote, 'commitment');
  const merklePath = getStringArrayProperty(userVote, 'merklePath') ?? getStringArrayProperty(proof, 'merklePath');
  const leafIndex = getNumberProperty(userVote, 'leafIndex') ?? getNumberProperty(proof, 'leafIndex');
  const treeSize = getNumberProperty(userVote, 'treeSize') ?? getNumberProperty(proof, 'treeSize');
  const bulletinRootAtCast = getStringProperty(proof, 'bulletinRootAtCast');

  return {
    commitment,
    merklePath,
    leafIndex,
    treeSize,
    bulletinRootAtCast,
  };
}

export function shouldFetchVoteProof(userVoteProof: UserVoteProofSummary | null, voteId?: string): voteId is string {
  if (!voteId) {
    return false;
  }
  if (!userVoteProof?.merklePath) {
    return true;
  }
  return userVoteProof.merklePath.length === 0;
}

export function mergeFetchedVoteProof(
  existing: UserVoteProofSummary | null,
  fetched: FetchedVoteProof,
  fallbackCommitment: string,
): UserVoteProofSummary {
  return {
    commitment: existing?.commitment ?? fallbackCommitment,
    merklePath: fetched.merklePath,
    leafIndex: fetched.leafIndex,
    treeSize: fetched.treeSize ?? existing?.treeSize,
    bulletinRootAtCast: fetched.bulletinRootAtCast ?? existing?.bulletinRootAtCast,
  };
}

export function isCtProofMissing(userVoteProof: UserVoteProofSummary | null): boolean {
  const merklePath = Array.isArray(userVoteProof?.merklePath) ? userVoteProof.merklePath : null;
  const merklePathLength = merklePath ? merklePath.length : 0;
  const proofTreeSize = typeof userVoteProof?.treeSize === 'number' ? userVoteProof.treeSize : undefined;
  const isTriviallySized = typeof proofTreeSize === 'number' && proofTreeSize <= 1;

  return !merklePath || (merklePathLength === 0 && !isTriviallySized);
}

export function resolveVerificationCheckStatuses(
  data: FinalizeScenarioData,
): Partial<Record<VerificationCheckId, VerificationStepStatus>> {
  const checks = Array.isArray(data.verificationChecks) ? data.verificationChecks : [];
  const entries = checks
    .filter((check) => isVerificationCheckLike(check))
    .map((check) => [check.id, check.status] as const);
  return Object.fromEntries(entries);
}

export function resolveVerificationStepStatuses(
  data: FinalizeScenarioData,
): Partial<Record<VerificationStepId, VerificationStepStatus>> {
  const steps = Array.isArray(data.verificationSteps) ? data.verificationSteps : [];
  const entries = steps.filter((step) => isVerificationStepLike(step)).map((step) => [step.id, step.status] as const);
  return Object.fromEntries(entries);
}

export function collectCliVerificationContractErrors(data: FinalizeScenarioData): string[] {
  const errors: string[] = [];
  const checkStatuses = resolveVerificationCheckStatuses(data);
  const stepStatuses = resolveVerificationStepStatuses(data);

  for (const stepId of CLI_REQUIRED_VERIFY_STEP_IDS) {
    if (!stepStatuses[stepId]) {
      errors.push(`CLI verification payload missing required step ${stepId}`);
    }
  }

  for (const checkId of CLI_REQUIRED_VERIFY_CHECK_IDS) {
    const status = checkStatuses[checkId];
    if (!status) {
      errors.push(`CLI verification payload missing required check ${checkId}`);
      continue;
    }
    if (status !== 'success') {
      errors.push(`CLI verification required check ${checkId} was ${status}`);
    }
  }

  if (stepStatuses.counted_as_recorded === 'success') {
    for (const checkId of CLI_REQUIRED_COUNTED_STAGE_CHECK_IDS) {
      const status = checkStatuses[checkId];
      if (status && status !== 'success') {
        errors.push(`Verification contract mismatch: counted_as_recorded was success while ${checkId}=${status}`);
      }
    }
  }

  if (stepStatuses.stark_verification === 'success') {
    const starkReceiptStatus = checkStatuses.stark_receipt_verify;
    if (starkReceiptStatus && starkReceiptStatus !== 'success') {
      errors.push(
        `Verification contract mismatch: stark_verification was success while stark_receipt_verify=${starkReceiptStatus}`,
      );
    }
  }

  if (typeof data.journal?.methodVersion === 'number' && data.journal.methodVersion !== CURRENT_METHOD_VERSION) {
    errors.push(
      `CLI verification journal methodVersion ${data.journal.methodVersion} does not match current contract ${CURRENT_METHOD_VERSION}`,
    );
  }

  const journal = data.journal;
  if (journal) {
    for (const field of CLI_JOURNAL_COUNT_FIELDS) {
      const journalValue = journal[field];
      const publicMirrorValue = data[field];
      if (typeof publicMirrorValue === 'number' && publicMirrorValue !== journalValue) {
        errors.push(
          `CLI verification count mismatch: ${field}=${publicMirrorValue} does not match journal.${field}=${journalValue}`,
        );
      }

      const debugMirrorValue = data.debug?.[field];
      if (typeof debugMirrorValue === 'number' && debugMirrorValue !== journalValue) {
        errors.push(
          `CLI verification count mismatch: debug.${field}=${debugMirrorValue} does not match journal.${field}=${journalValue}`,
        );
      }
    }
  }

  return errors;
}

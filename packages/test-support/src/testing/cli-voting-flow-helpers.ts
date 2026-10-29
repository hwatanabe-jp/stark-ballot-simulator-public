import type { FinalizeScenarioData } from '@stark-ballot/test-support/testing/cli-test-helpers';
import { getStringArrayProperty, isNonNullObject } from '@stark-ballot/validation/unknown-value-guards';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  getVerificationRequiredCheckIdsForStep,
  VERIFICATION_CHECK_IDS,
  type VerificationCheckId,
  type VerificationCheck,
} from '@stark-ballot/verification/checks';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

type VerificationStepId = 'cast_as_intended' | 'recorded_as_cast' | 'counted_as_recorded' | 'stark_verification';
type VerificationStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'not_run';

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

const CLI_REQUIRED_VERIFY_STEP_IDS = [
  'counted_as_recorded',
  'stark_verification',
] as const satisfies readonly VerificationStepId[];
const CLI_REQUIRED_VERIFY_CHECK_IDS = CLI_REQUIRED_VERIFY_STEP_IDS.flatMap((stepId) =>
  getVerificationRequiredCheckIdsForStep(stepId, { sthSourcesConfigured: false }),
);
const CLI_REQUIRED_COUNTED_STAGE_CHECK_IDS = getVerificationRequiredCheckIdsForStep('counted_as_recorded', {
  sthSourcesConfigured: false,
});
const CLI_JOURNAL_COUNT_FIELDS = ['missingSlots', 'invalidPresentedSlots', 'validVotes', 'excludedSlots'] as const;

function isVerificationCheckId(value: unknown): value is VerificationCheckId {
  return typeof value === 'string' && VERIFICATION_CHECK_IDS.includes(value as VerificationCheckId);
}

function isVerificationStepStatus(value: unknown): value is VerificationStepStatus {
  return value === 'pending' || value === 'running' || value === 'success' || value === 'failed' || value === 'not_run';
}

function isVerificationCheckLike(value: unknown): value is Pick<VerificationCheck, 'id' | 'status'> {
  return isNonNullObject(value) && isVerificationCheckId(value['id']) && isVerificationStepStatus(value['status']);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isNonNullObject(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'number');
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  if (!isNonNullObject(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === 'number' ? candidate : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isNonNullObject(value)) {
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
  return isNonNullObject(value) && isNumberRecord(value['counts']);
}

function resolveTallyRoot(data: FinalizeScenarioData, tallyDetail: unknown): string | undefined {
  return (
    getStringProperty(tallyDetail, 'merkleRoot') ??
    getStringProperty(tallyDetail, 'bulletinRoot') ??
    getStringProperty(data, 'merkleRoot') ??
    getStringProperty(data, 'bulletinRoot')
  );
}

function resolveTallyCounts(data: FinalizeScenarioData, tallyDetail: unknown, counts: Record<string, number>) {
  const computedTotal = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const totalVotes =
    getNumberProperty(tallyDetail, 'totalVotes') ??
    (typeof data.totalVotes === 'number' ? data.totalVotes : undefined) ??
    computedTotal;
  const tamperedCount =
    getNumberProperty(tallyDetail, 'tamperedCount') ??
    (typeof data.tamperedCount === 'number' ? data.tamperedCount : undefined) ??
    0;
  return { totalVotes, tamperedCount };
}

export function resolveTallyResult(data: FinalizeScenarioData): ResolvedTallyResult | null {
  const tally = data.tally;
  const tallyDetail = isTallyDetail(tally) ? tally : undefined;
  const counts = tallyDetail?.counts ?? (isNumberRecord(tally) ? tally : undefined);

  if (!counts) {
    return null;
  }

  const merkleRoot = resolveTallyRoot(data, tallyDetail);

  if (!merkleRoot) {
    return null;
  }

  const { totalVotes, tamperedCount } = resolveTallyCounts(data, tallyDetail, counts);

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

  return { receipt, ...omitUndefinedProperties({ imageId, tamperDetected }) };
}

export function resolveUserVoteProof(data: FinalizeScenarioData): UserVoteProofSummary | null {
  const userVote = data.userVote;
  if (!isNonNullObject(userVote)) {
    return null;
  }

  const proof = isNonNullObject(userVote.proof) ? userVote.proof : undefined;

  const commitment = getStringProperty(userVote, 'commitment');
  const merklePath = getStringArrayProperty(userVote, 'merklePath') ?? getStringArrayProperty(proof, 'merklePath');
  const leafIndex = getNumberProperty(userVote, 'leafIndex') ?? getNumberProperty(proof, 'leafIndex');
  const treeSize = getNumberProperty(userVote, 'treeSize') ?? getNumberProperty(proof, 'treeSize');
  const bulletinRootAtCast = getStringProperty(proof, 'bulletinRootAtCast');

  return {
    ...omitUndefinedProperties({ commitment: commitment }),
    ...omitUndefinedProperties({ merklePath, leafIndex, treeSize, bulletinRootAtCast }),
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
    ...omitUndefinedProperties({ commitment: existing?.commitment ?? fallbackCommitment }),
    merklePath: fetched.merklePath,
    leafIndex: fetched.leafIndex,
    ...omitUndefinedProperties({ treeSize: fetched.treeSize ?? existing?.treeSize }),
    ...omitUndefinedProperties({ bulletinRootAtCast: fetched.bulletinRootAtCast ?? existing?.bulletinRootAtCast }),
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
  return data.presentationPolicy ? { ...data.presentationPolicy.stageStatuses } : {};
}

export interface CliVerificationContractOptions {
  requireRequiredChecksSuccess?: boolean;
}

export function collectCliVerificationContractErrors(
  data: FinalizeScenarioData,
  options: CliVerificationContractOptions = {},
): string[] {
  const requireRequiredChecksSuccess = options.requireRequiredChecksSuccess ?? true;
  const errors: string[] = [];
  const checkStatuses = resolveVerificationCheckStatuses(data);
  const stepStatuses = resolveVerificationStepStatuses(data);

  collectRequiredVerificationErrors(errors, stepStatuses, checkStatuses, requireRequiredChecksSuccess);
  collectVerificationStageErrors(errors, stepStatuses, checkStatuses);
  collectJournalContractErrors(errors, data);
  return errors;
}

function collectRequiredVerificationErrors(
  errors: string[],
  stepStatuses: ReturnType<typeof resolveVerificationStepStatuses>,
  checkStatuses: ReturnType<typeof resolveVerificationCheckStatuses>,
  requireRequiredChecksSuccess: boolean,
): void {
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
    if (requireRequiredChecksSuccess && status !== 'success') {
      errors.push(`CLI verification required check ${checkId} was ${status}`);
    }
  }
}

function collectVerificationStageErrors(
  errors: string[],
  stepStatuses: ReturnType<typeof resolveVerificationStepStatuses>,
  checkStatuses: ReturnType<typeof resolveVerificationCheckStatuses>,
): void {
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
}

function collectJournalContractErrors(errors: string[], data: FinalizeScenarioData): void {
  if (typeof data.journal?.methodVersion === 'number' && data.journal.methodVersion !== CURRENT_METHOD_VERSION) {
    errors.push(
      `CLI verification journal methodVersion ${data.journal.methodVersion} does not match current contract ${CURRENT_METHOD_VERSION}`,
    );
  }

  const journal = data.journal;
  if (!journal) return;
  for (const field of CLI_JOURNAL_COUNT_FIELDS) {
    collectJournalCountErrors(errors, data, journal, field);
  }
}

function collectJournalCountErrors(
  errors: string[],
  data: FinalizeScenarioData,
  journal: NonNullable<FinalizeScenarioData['journal']>,
  field: (typeof CLI_JOURNAL_COUNT_FIELDS)[number],
): void {
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

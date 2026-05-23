import { existsSync, realpathSync } from 'fs';
import path from 'path';
import type {
  FinalizationBitmapData,
  FinalizationResult,
  FinalizationResultAuthority,
  FinalizationResultPublicProjection,
  FinalizationScenarioContext,
  SessionData,
  VerificationResult,
} from '@/types/server';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import type { CloseStatement, ElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildCloseStatement, recomputeElectionManifestHash } from '@/lib/verification/public-audit-artifacts';
import {
  sanitizeFinalizationPayloadVerificationStatus,
  sanitizeFinalizationResultVerificationStatus,
} from '@/lib/verification/fail-closed-status';
import { normalizeHexString } from '@/lib/utils/hex';
import { isSupportedJournalMethodVersion, isSupportedZkVMJournal } from '@/lib/zkvm/journal-guards';
import { logger } from '@/lib/utils/logger';
import { VOTE_CHOICES } from '@/shared/constants';
import { toPublicZkvmJournal } from '@/lib/zkvm/public-journal';
import { resolveFinalizationTamperDetected, resolveScenarioTamperCount } from '@/lib/finalize/finalization-tamper';
import { projectVerificationResultForPublicResponse } from '@/lib/verification/public-verification-result';

export interface FinalizationBundleMetadata {
  s3BundleKey?: string;
  /** @deprecated Delivery-only value accepted at helper boundaries and discarded. */
  s3BundleUrl?: string;
  s3UploadedAt?: string;
  /** @deprecated Delivery-only value accepted at helper boundaries and discarded. */
  s3BundleExpiresAt?: string;
}

interface FinalizationVerificationStateUpdate extends FinalizationBundleMetadata {
  verificationResult?: VerificationResult;
  verificationExecutionId?: string;
}

type FinalizationCompatibilityResult = FinalizationResult;
type CanonicalFinalizationResult = FinalizationResultAuthority;
type PublicAuditArtifact = 'publicInputArtifact' | 'electionManifest' | 'closeStatement';

export interface PublicAuditArtifactConsistencyIssue {
  artifact: PublicAuditArtifact;
  reason: string;
}

interface PublicAuditArtifactResolution {
  publicInputArtifact?: FinalizationCompatibilityResult['publicInputArtifact'];
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  issues: PublicAuditArtifactConsistencyIssue[];
}

interface LocalBundleIdentity {
  bundlePath: string;
  sessionId: string;
  executionId: string;
  bundleKey?: string;
}

export interface TrustedLocalBundleReference {
  bundlePath: string;
  reportPath: string;
  sessionId: string;
  executionId: string;
  bundleKey?: string;
}

const SAFE_BUNDLE_SEGMENT = /^[A-Za-z0-9-]+$/;

function resolveVerifierWorkDirForBundleAuthority(): string {
  const envDir = process.env.VERIFIER_WORK_DIR?.trim();
  if (envDir) {
    return path.resolve(envDir);
  }

  // Keep the default local bundle location without routing it through
  // realpathSync, which causes Turbopack to glob the whole directory at build time.
  return path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles');
}

function resolveScopedVerifierBundlePath(sessionId: string, executionId: string): string {
  const envDir = process.env.VERIFIER_WORK_DIR?.trim();
  if (envDir) {
    return path.join(/* turbopackIgnore: true */ path.resolve(envDir), sessionId, executionId);
  }

  return path.join(/* turbopackIgnore: true */ process.cwd(), '.verifier-bundles', sessionId, executionId);
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function buildCountsRecord(verifiedTally: number[]): Record<(typeof VOTE_CHOICES)[number], number> {
  const record = {} as Record<(typeof VOTE_CHOICES)[number], number>;
  for (const [index, choice] of VOTE_CHOICES.entries()) {
    record[choice] = Number.isFinite(verifiedTally[index]) ? verifiedTally[index] : 0;
  }
  return record;
}

export function updateFinalizationResultBundleMetadata(
  result: FinalizationResultAuthority,
  bundleMetadata: FinalizationBundleMetadata,
): FinalizationResultAuthority {
  const nextResult: FinalizationResultAuthority = { ...result };

  if (hasOwnProperty(bundleMetadata, 's3BundleKey')) {
    nextResult.s3BundleKey = bundleMetadata.s3BundleKey;
  }
  if (hasOwnProperty(bundleMetadata, 's3UploadedAt')) {
    nextResult.s3UploadedAt = bundleMetadata.s3UploadedAt;
  }

  if (nextResult.verificationResult) {
    const nextVerificationResult = { ...nextResult.verificationResult };
    if (hasOwnProperty(bundleMetadata, 's3BundleKey')) {
      nextVerificationResult.s3BundleKey = bundleMetadata.s3BundleKey;
    }
    if (hasOwnProperty(bundleMetadata, 's3UploadedAt')) {
      nextVerificationResult.s3UploadedAt = bundleMetadata.s3UploadedAt;
    }
    nextResult.verificationResult = nextVerificationResult;
  }

  return nextResult;
}

export function updateFinalizationResultVerificationState(
  result: FinalizationResultAuthority,
  update: FinalizationVerificationStateUpdate,
): FinalizationResultAuthority {
  const nextResult = updateFinalizationResultBundleMetadata(result, update);

  if (hasOwnProperty(update, 'verificationResult')) {
    nextResult.verificationResult = update.verificationResult;
  }
  if (hasOwnProperty(update, 'verificationExecutionId')) {
    nextResult.verificationExecutionId = update.verificationExecutionId;
  }

  return sanitizeFinalizationResultVerificationStatus(nextResult);
}

export function updateFinalizationResultBitmapData(
  result: FinalizationResultAuthority,
  bitmapData: FinalizationBitmapData,
): FinalizationResultAuthority {
  return {
    ...result,
    bitmapData: {
      ...bitmapData,
      includedBitmap: [...bitmapData.includedBitmap],
      ...(bitmapData.seenBitmap ? { seenBitmap: [...bitmapData.seenBitmap] } : {}),
    },
    bitmapProofSource: result.bitmapProofSource ?? 'real',
  };
}

function resolveUsableTally(
  tally: FinalizationCompatibilityResult['tally'] | undefined,
  fallback: CanonicalFinalizationResult['tally'],
): CanonicalFinalizationResult['tally'] {
  // Keep a structurally valid claimed tally for presentation flows like S2/S4,
  // while fail-closed verification still compares it against the canonical journal.
  if (!tally || typeof tally !== 'object') {
    return fallback;
  }

  const counts = (tally as { counts?: Partial<Record<(typeof VOTE_CHOICES)[number], unknown>> }).counts;
  if (!counts || typeof counts !== 'object') {
    return fallback;
  }

  for (const choice of VOTE_CHOICES) {
    const value = counts[choice];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
  }

  if (typeof tally.totalVotes !== 'number' || !Number.isFinite(tally.totalVotes)) {
    return fallback;
  }
  if (typeof tally.tamperedCount !== 'number' || !Number.isFinite(tally.tamperedCount)) {
    return fallback;
  }

  return tally;
}

function buildTamperSummary(
  scenarioContext?: FinalizationScenarioContext | null,
): FinalizationResultAuthority['tamperSummary'] {
  if (!scenarioContext) {
    return undefined;
  }

  const ignoredVotes = scenarioContext.summary.ignoredCount;
  const recountedVotes = scenarioContext.summary.recountedCount;
  if (ignoredVotes <= 0 && recountedVotes <= 0) {
    return undefined;
  }

  return {
    ignoredVotes,
    recountedVotes,
    userRecountedTo: scenarioContext.summary.userRecountChoice,
    ...(scenarioContext.summary.affectedBotIds ? { affectedBotIds: scenarioContext.summary.affectedBotIds } : {}),
  };
}

function applyScenarioContext(
  result: CanonicalFinalizationResult,
  scenarioContext?: FinalizationScenarioContext | null,
): CanonicalFinalizationResult {
  if (!scenarioContext) {
    return result;
  }

  const scenarioTamperCount = scenarioContext.summary.ignoredCount + scenarioContext.summary.recountedCount;
  const excludedSlots = result.journal.excludedSlots;
  const rejectedRecords = result.journal.rejectedRecords;
  const tamperDetected = resolveFinalizationTamperDetected({
    excludedSlots,
    rejectedRecords,
    scenarioTamperCount,
  });

  return {
    ...result,
    tally: {
      ...result.tally,
      counts: scenarioContext.claimedCounts,
      totalVotes: scenarioContext.claimedTotalVotes,
      tamperedCount: Math.max(excludedSlots, scenarioTamperCount),
    },
    tamperDetected,
    scenarios: scenarioContext.scenarios,
    tamperSummary: buildTamperSummary(scenarioContext),
  };
}

export function buildFinalizationResultFromJournal(options: {
  journal: ZkVMJournal;
  imageId?: string;
  verificationExecutionId?: string;
  bundleMetadata?: FinalizationBundleMetadata;
  scenarioContext?: FinalizationScenarioContext | null;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
}): CanonicalFinalizationResult {
  const { bundleMetadata, scenarioContext } = options;
  const journal = toPublicZkvmJournal(options.journal);
  const verifiedTally = journal.verifiedTally;
  const excludedSlots = journal.excludedSlots;
  const totalVotes = journal.totalExpected;
  const tamperDetected = resolveFinalizationTamperDetected({
    excludedSlots,
    rejectedRecords: journal.rejectedRecords,
  });
  const imageId = options.imageId ?? '';

  const baseResult: CanonicalFinalizationResult = {
    tally: {
      counts: buildCountsRecord(verifiedTally),
      totalVotes,
      tamperedCount: excludedSlots,
    },
    s3BundleKey: bundleMetadata?.s3BundleKey,
    s3UploadedAt: bundleMetadata?.s3UploadedAt,
    receipt: undefined,
    receiptRaw: undefined,
    receiptPublication: undefined,
    imageId,
    tamperDetected,
    electionManifest: options.electionManifest,
    closeStatement: options.closeStatement,
    journal,
    scenarios: undefined,
    verificationResult: undefined,
    verificationExecutionId: options.verificationExecutionId,
    tamperSummary: undefined,
  };

  return applyScenarioContext(baseResult, scenarioContext);
}

export function canonicalizeFinalizationResult(
  result: FinalizationCompatibilityResult | CanonicalFinalizationResult | undefined,
  scenarioContext?: FinalizationScenarioContext | null,
): CanonicalFinalizationResult | undefined {
  if (!result) {
    return result;
  }

  if (!isSupportedZkVMJournal(result.journal)) {
    return undefined;
  }

  const journal = toPublicZkvmJournal(result.journal);
  const artifactResolution = resolveConsistentPublicAuditArtifacts({
    journal,
    publicInputArtifact: result.publicInputArtifact,
    electionManifest: result.electionManifest,
    closeStatement: result.closeStatement,
    verificationExecutionId: resolveExpectedVerificationExecutionId(result),
    bundleKey: resolveExpectedBundleKey(result),
  });
  if (artifactResolution.issues.length > 0) {
    return undefined;
  }
  const { publicInputArtifact, electionManifest, closeStatement } = artifactResolution;

  const derived = buildFinalizationResultFromJournal({
    journal,
    imageId: result.imageId,
    bundleMetadata: {
      s3BundleKey: result.s3BundleKey,
      s3UploadedAt: result.s3UploadedAt,
    },
    scenarioContext,
    electionManifest,
    closeStatement,
  });
  const storedScenarioTamperCount = resolveScenarioTamperCount(result.tamperSummary);

  const canonical: CanonicalFinalizationResult = {
    tally: resolveUsableTally(result.tally, derived.tally),
    s3BundleKey: result.s3BundleKey,
    s3UploadedAt: result.s3UploadedAt,
    receipt: result.receipt,
    receiptRaw: result.receiptRaw,
    receiptPublication: result.receiptPublication,
    imageId: result.imageId,
    tamperDetected:
      Boolean(result.tamperDetected) ||
      resolveFinalizationTamperDetected({
        excludedSlots: derived.journal.excludedSlots,
        rejectedRecords: derived.journal.rejectedRecords,
        scenarioTamperCount: storedScenarioTamperCount,
      }),
    scenarios: result.scenarios,
    journal,
    publicInputArtifact,
    electionManifest,
    closeStatement,
    bitmapProofSource: result.bitmapProofSource,
    bitmapData: result.bitmapData,
    verificationResult: result.verificationResult,
    verificationExecutionId: result.verificationExecutionId,
    tamperSummary: result.tamperSummary,
  };

  const scenarioAware = scenarioContext ? applyScenarioContext(canonical, scenarioContext) : canonical;
  return sanitizeFinalizationResultVerificationStatus(scenarioAware);
}

export function hydrateFinalizationResultFromJournal(
  result: FinalizationCompatibilityResult | CanonicalFinalizationResult | undefined,
  scenarioContext?: FinalizationScenarioContext | null,
): CanonicalFinalizationResult | undefined {
  return canonicalizeFinalizationResult(result, scenarioContext);
}

export function projectFinalizationResultForPublicResponse(
  result: CanonicalFinalizationResult,
): FinalizationResultPublicProjection {
  const journal = toPublicZkvmJournal(result.journal);
  const publicVerificationResult = projectVerificationResultForPublicResponse(result.verificationResult);
  const projected: FinalizationResultPublicProjection = {
    tally: result.tally,
    receiptPublication: result.receiptPublication,
    imageId: result.imageId,
    tamperDetected: result.tamperDetected,
    scenarios: result.scenarios,
    journal,
    electionManifest: result.electionManifest,
    closeStatement: result.closeStatement,
    bitmapProofSource: result.bitmapProofSource,
    verificationResult: publicVerificationResult,
    verificationExecutionId: result.verificationExecutionId,
    tamperSummary: result.tamperSummary,
    bulletinRoot: journal.bulletinRoot,
    verifiedTally: [...journal.verifiedTally],
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
  };

  return sanitizeFinalizationPayloadVerificationStatus(projected);
}

export function hasConsistentPublicAuditArtifacts(
  result:
    | Pick<
        FinalizationCompatibilityResult,
        | 'journal'
        | 'publicInputArtifact'
        | 'electionManifest'
        | 'closeStatement'
        | 'verificationExecutionId'
        | 's3BundleKey'
        | 'verificationResult'
      >
    | undefined,
): boolean {
  if (!result || !isSupportedZkVMJournal(result.journal)) {
    return false;
  }

  const journal = toPublicZkvmJournal(result.journal);
  const artifactResolution = resolveConsistentPublicAuditArtifacts({
    journal,
    publicInputArtifact: result.publicInputArtifact,
    electionManifest: result.electionManifest,
    closeStatement: result.closeStatement,
    verificationExecutionId: resolveExpectedVerificationExecutionId(result),
    bundleKey: resolveExpectedBundleKey(result),
  });

  return Boolean(
    artifactResolution.issues.length === 0 &&
    artifactResolution.publicInputArtifact &&
    artifactResolution.electionManifest &&
    artifactResolution.closeStatement,
  );
}

export function resolveConsistentPublicAuditArtifacts(input: {
  journal: ZkVMJournal;
  publicInputArtifact?: FinalizationCompatibilityResult['publicInputArtifact'];
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  verificationExecutionId?: string;
  bundleKey?: string;
  hasLocalPublicInputAuthority?: boolean;
}): PublicAuditArtifactResolution {
  // Keep the public artifact consistency rules aligned with
  // docker/entrypoint.sh::validate_public_audit_artifacts for async bundles.
  const publicInputArtifact = resolveConsistentPublicInputArtifact(input.publicInputArtifact, input.journal, {
    verificationExecutionId: input.verificationExecutionId,
    bundleKey: input.bundleKey,
    hasLocalPublicInputAuthority: Boolean(input.hasLocalPublicInputAuthority),
  });
  const electionManifest = resolveConsistentElectionManifest(
    input.electionManifest,
    input.journal,
    publicInputArtifact.value,
  );
  const closeStatement = resolveConsistentCloseStatement(
    input.closeStatement,
    input.journal,
    publicInputArtifact.value,
  );

  return {
    publicInputArtifact: publicInputArtifact.value,
    electionManifest: electionManifest.value,
    closeStatement: closeStatement.value,
    issues: [...publicInputArtifact.issues, ...electionManifest.issues, ...closeStatement.issues],
  };
}

function resolveConsistentPublicInputArtifact(
  artifact: FinalizationResult['publicInputArtifact'],
  journal: ZkVMJournal,
  authority: {
    verificationExecutionId?: string;
    bundleKey?: string;
    hasLocalPublicInputAuthority: boolean;
  },
): {
  value: FinalizationResult['publicInputArtifact'];
  issues: PublicAuditArtifactConsistencyIssue[];
} {
  if (!artifact) {
    return {
      value: undefined,
      issues: [{ artifact: 'publicInputArtifact', reason: 'missing_authoritative_public_input_artifact' }],
    };
  }

  if (!hasAuthoritativePublicInputContext(artifact.provenance, authority)) {
    return {
      value: undefined,
      issues: [{ artifact: 'publicInputArtifact', reason: 'non_authoritative_provenance' }],
    };
  }

  const typedAuthority = artifact.typedAuthority;

  const issues: PublicAuditArtifactConsistencyIssue[] = [];
  if (typedAuthority.electionId !== journal.electionId) {
    issues.push({ artifact: 'publicInputArtifact', reason: 'election_id_mismatch' });
  }
  if (!matchesHex(typedAuthority.electionConfigHash, journal.electionConfigHash)) {
    issues.push({ artifact: 'publicInputArtifact', reason: 'election_config_hash_mismatch' });
  }
  if (!matchesHex(typedAuthority.bulletinRoot, journal.bulletinRoot)) {
    issues.push({ artifact: 'publicInputArtifact', reason: 'bulletin_root_mismatch' });
  }
  if (typedAuthority.treeSize !== journal.treeSize) {
    issues.push({ artifact: 'publicInputArtifact', reason: 'tree_size_mismatch' });
  }
  if (typedAuthority.totalExpected !== journal.totalExpected) {
    issues.push({ artifact: 'publicInputArtifact', reason: 'total_expected_mismatch' });
  }
  if (!matchesHex(typedAuthority.recomputedInputCommitment, journal.inputCommitment)) {
    issues.push({ artifact: 'publicInputArtifact', reason: 'input_commitment_mismatch' });
  }
  if (
    !isSupportedJournalMethodVersion(typedAuthority.methodVersion) ||
    typedAuthority.methodVersion !== journal.methodVersion
  ) {
    issues.push({ artifact: 'publicInputArtifact', reason: 'method_version_mismatch' });
  }

  if (issues.length > 0) {
    return { value: undefined, issues };
  }

  return { value: artifact, issues: [] };
}

function resolveConsistentElectionManifest(
  manifest: ElectionManifest | undefined,
  journal: ZkVMJournal,
  publicInputArtifact: FinalizationResult['publicInputArtifact'],
): {
  value: ElectionManifest | undefined;
  issues: PublicAuditArtifactConsistencyIssue[];
} {
  if (!manifest) {
    return { value: undefined, issues: [] };
  }

  const recomputedHash = recomputeElectionManifestHash(manifest);
  const issues: PublicAuditArtifactConsistencyIssue[] = [];

  if (manifest.electionId !== journal.electionId) {
    issues.push({ artifact: 'electionManifest', reason: 'election_id_mismatch' });
  }
  if (publicInputArtifact && manifest.electionId !== publicInputArtifact.typedAuthority.electionId) {
    issues.push({ artifact: 'electionManifest', reason: 'public_input_election_id_mismatch' });
  }
  if (manifest.totalExpected !== journal.totalExpected) {
    issues.push({ artifact: 'electionManifest', reason: 'total_expected_mismatch' });
  }
  if (publicInputArtifact && manifest.totalExpected !== publicInputArtifact.typedAuthority.totalExpected) {
    issues.push({ artifact: 'electionManifest', reason: 'public_input_total_expected_mismatch' });
  }
  if (!matchesHex(manifest.electionConfigHash, recomputedHash)) {
    issues.push({ artifact: 'electionManifest', reason: 'self_hash_mismatch' });
  }
  if (!matchesHex(manifest.electionConfigHash, journal.electionConfigHash)) {
    issues.push({ artifact: 'electionManifest', reason: 'journal_hash_mismatch' });
  }
  if (
    publicInputArtifact &&
    !matchesHex(manifest.electionConfigHash, publicInputArtifact.typedAuthority.electionConfigHash)
  ) {
    issues.push({ artifact: 'electionManifest', reason: 'public_input_hash_mismatch' });
  }

  if (issues.length > 0) {
    return { value: undefined, issues };
  }

  return { value: manifest, issues: [] };
}

function resolveConsistentCloseStatement(
  closeStatement: CloseStatement | undefined,
  journal: ZkVMJournal,
  publicInputArtifact: FinalizationResult['publicInputArtifact'],
): {
  value: CloseStatement | undefined;
  issues: PublicAuditArtifactConsistencyIssue[];
} {
  if (!closeStatement) {
    return { value: undefined, issues: [] };
  }

  const issues: PublicAuditArtifactConsistencyIssue[] = [];

  if (closeStatement.treeSize !== journal.treeSize) {
    issues.push({ artifact: 'closeStatement', reason: 'tree_size_mismatch' });
  }
  if (!matchesHex(closeStatement.bulletinRoot, journal.bulletinRoot)) {
    issues.push({ artifact: 'closeStatement', reason: 'bulletin_root_mismatch' });
  }

  try {
    const recomputed = buildCloseStatement({
      logId: closeStatement.logId,
      treeSize: journal.treeSize,
      timestamp: closeStatement.timestamp,
      bulletinRoot: journal.bulletinRoot,
    });
    if (!matchesHex(closeStatement.sthDigest, recomputed.sthDigest)) {
      issues.push({ artifact: 'closeStatement', reason: 'sth_digest_mismatch' });
    }
  } catch {
    issues.push({ artifact: 'closeStatement', reason: 'invalid_digest_inputs' });
  }
  if (!matchesHex(closeStatement.sthDigest, journal.sthDigest)) {
    issues.push({ artifact: 'closeStatement', reason: 'journal_sth_digest_mismatch' });
  }

  if (publicInputArtifact && !matchesHex(closeStatement.logId, publicInputArtifact.typedAuthority.logId)) {
    issues.push({ artifact: 'closeStatement', reason: 'log_id_mismatch' });
  }
  if (publicInputArtifact && closeStatement.timestamp !== publicInputArtifact.typedAuthority.timestamp) {
    issues.push({ artifact: 'closeStatement', reason: 'timestamp_mismatch' });
  }

  if (issues.length > 0) {
    return { value: undefined, issues };
  }

  return { value: closeStatement, issues: [] };
}

function matchesHex(left: string | undefined, right: string | undefined): boolean {
  return (
    typeof left === 'string' && typeof right === 'string' && normalizeHexString(left) === normalizeHexString(right)
  );
}

function hasAuthoritativePublicInputContext(
  provenance: NonNullable<NonNullable<SessionData['finalizationResult']>['publicInputArtifact']>['provenance'],
  authority: {
    verificationExecutionId?: string;
    bundleKey?: string;
    hasLocalPublicInputAuthority: boolean;
  },
): boolean {
  if (authority.hasLocalPublicInputAuthority) {
    if (authority.verificationExecutionId && provenance.executionId !== authority.verificationExecutionId) {
      return false;
    }
    if (authority.bundleKey && provenance.bundleKey !== authority.bundleKey) {
      return false;
    }
    return true;
  }

  if (provenance.source === 'generated') {
    if (authority.verificationExecutionId) {
      if (provenance.executionId !== authority.verificationExecutionId) {
        return false;
      }
    } else if (provenance.executionId !== undefined) {
      return false;
    }

    if (authority.bundleKey) {
      if (provenance.bundleKey !== authority.bundleKey) {
        return false;
      }
    } else if (provenance.bundleKey !== undefined) {
      return false;
    }

    return true;
  }

  if (provenance.source !== 'bundle') {
    return false;
  }

  if (!authority.bundleKey || !provenance.bundleKey || provenance.bundleKey !== authority.bundleKey) {
    return false;
  }

  if (!authority.verificationExecutionId) {
    return true;
  }

  return provenance.executionId === authority.verificationExecutionId;
}

function resolveExpectedVerificationExecutionId(
  result:
    | Pick<FinalizationResult, 'verificationExecutionId' | 'verificationResult'>
    | SessionData['finalizationResult']
    | undefined,
): string | undefined {
  return result?.verificationExecutionId;
}

function resolveExpectedBundleKey(
  result:
    | Pick<FinalizationResult, 's3BundleKey' | 'verificationResult'>
    | SessionData['finalizationResult']
    | undefined,
): string | undefined {
  return result?.s3BundleKey;
}

function resolveTrustedBundleIdentity(
  bundlePath: string | undefined,
  authority: {
    verificationExecutionId?: string;
    bundleKey?: string;
  },
): LocalBundleIdentity | undefined {
  if (!bundlePath || bundlePath.trim().length === 0) {
    return undefined;
  }

  const resolvedBaseDir = resolveVerifierWorkDirForBundleAuthority();

  let resolvedBundlePath: string;
  try {
    resolvedBundlePath = realpathSync(bundlePath);
  } catch {
    logger.debug('[FinalizationResult] Ignoring missing local bundle path', { bundlePath });
    return undefined;
  }

  const relative = path.relative(resolvedBaseDir, resolvedBundlePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    logger.debug('[FinalizationResult] Ignoring local bundle path outside verifier work dir', {
      bundlePath,
      resolvedBundlePath,
      resolvedBaseDir,
    });
    return undefined;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length !== 2) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with unexpected layout', {
      bundlePath,
      resolvedBundlePath,
      relative,
    });
    return undefined;
  }

  const [sessionId, executionId] = segments;
  if (!isSafeBundleSegment(sessionId) || !isSafeBundleSegment(executionId)) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with unsafe segments', {
      bundlePath,
      resolvedBundlePath,
      sessionId,
      executionId,
    });
    return undefined;
  }

  if (authority.verificationExecutionId && authority.verificationExecutionId !== executionId) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with mismatched execution identity', {
      bundlePath,
      resolvedBundlePath,
      expectedExecutionId: authority.verificationExecutionId,
      actualExecutionId: executionId,
    });
    return undefined;
  }

  const expectedBundleIdentity = extractBundleIdentityFromKey(authority.bundleKey);
  if (
    expectedBundleIdentity &&
    (expectedBundleIdentity.sessionId !== sessionId || expectedBundleIdentity.executionId !== executionId)
  ) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with mismatched bundle key identity', {
      bundlePath,
      resolvedBundlePath,
      expectedSessionId: expectedBundleIdentity.sessionId,
      actualSessionId: sessionId,
      expectedExecutionId: expectedBundleIdentity.executionId,
      actualExecutionId: executionId,
    });
    return undefined;
  }

  if (!existsSync(path.join(resolvedBundlePath, 'public-input.json'))) {
    logger.debug('[FinalizationResult] Ignoring local bundle path without public-input.json', {
      bundlePath: resolvedBundlePath,
    });
    return undefined;
  }

  return {
    bundlePath: resolvedBundlePath,
    sessionId,
    executionId,
    bundleKey: expectedBundleIdentity ? authority.bundleKey : undefined,
  };
}

export function resolveTrustedLocalBundleReference(
  sessionId: string,
  result: Pick<FinalizationResultAuthority, 'verificationExecutionId' | 's3BundleKey' | 'verificationResult'>,
): TrustedLocalBundleReference | undefined {
  const executionId = result.verificationExecutionId;
  if (!isSafeBundleSegment(sessionId) || !executionId || !isSafeBundleSegment(executionId)) {
    return undefined;
  }

  const scopedBundlePath = resolveScopedVerifierBundlePath(sessionId, executionId);
  const localBundleIdentity = resolveTrustedBundleIdentity(scopedBundlePath, {
    verificationExecutionId: result.verificationExecutionId,
    bundleKey: result.s3BundleKey,
  });
  if (!localBundleIdentity) {
    return undefined;
  }

  if (localBundleIdentity.sessionId !== sessionId) {
    logger.debug('[FinalizationResult] Ignoring local bundle path with mismatched session identity', {
      bundlePath: localBundleIdentity.bundlePath,
      expectedSessionId: sessionId,
      actualSessionId: localBundleIdentity.sessionId,
    });
    return undefined;
  }

  return {
    ...localBundleIdentity,
    reportPath: path.join(localBundleIdentity.bundlePath, 'verification.json'),
  };
}

function extractBundleIdentityFromKey(
  bundleKey: string | undefined,
): { sessionId: string; executionId: string } | undefined {
  if (!bundleKey || bundleKey.trim().length === 0) {
    return undefined;
  }

  const segments = bundleKey.split('/').filter(Boolean);
  if (segments.length < 3 || segments[segments.length - 1] !== 'bundle.zip') {
    return undefined;
  }

  const sessionId = segments[segments.length - 3];
  const executionId = segments[segments.length - 2];
  if (!isSafeBundleSegment(sessionId) || !isSafeBundleSegment(executionId)) {
    return undefined;
  }

  return { sessionId, executionId };
}

function isSafeBundleSegment(value: string): boolean {
  return SAFE_BUNDLE_SEGMENT.test(value);
}

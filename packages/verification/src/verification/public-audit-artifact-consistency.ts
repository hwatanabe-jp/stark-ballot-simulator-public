import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import { isSupportedJournalMethodVersion } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import { normalizeHexString } from '@stark-ballot/crypto-primitives';
import {
  buildCloseStatement,
  recomputeElectionManifestHash,
  type CloseStatement,
  type ElectionManifest,
} from './public-audit-artifacts';
import type { SupportedPublicInputArtifact } from './public-input-contract';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export interface PublicAuditArtifactConsistencyIssue {
  artifact: 'publicInputArtifact' | 'electionManifest' | 'closeStatement';
  reason: string;
}

export interface PublicAuditArtifactResolution {
  publicInputArtifact?: SupportedPublicInputArtifact;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  issues: PublicAuditArtifactConsistencyIssue[];
}

export function resolveConsistentPublicAuditArtifacts(input: {
  journal: ZkVMJournal;
  publicInputArtifact?: SupportedPublicInputArtifact;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  finalizationId?: string;
  bundleKey?: string;
  hasLocalPublicInputAuthority?: boolean;
}): PublicAuditArtifactResolution {
  const publicInputArtifact = resolveConsistentPublicInputArtifact(input.publicInputArtifact, input.journal, {
    ...omitUndefinedProperties({
      finalizationId: input.finalizationId,
      bundleKey: input.bundleKey,
    }),
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
    ...omitUndefinedProperties({
      publicInputArtifact: publicInputArtifact.value,
      electionManifest: electionManifest.value,
      closeStatement: closeStatement.value,
    }),
    issues: [...publicInputArtifact.issues, ...electionManifest.issues, ...closeStatement.issues],
  };
}

function resolveConsistentPublicInputArtifact(
  artifact: SupportedPublicInputArtifact | undefined,
  journal: ZkVMJournal,
  authority: {
    finalizationId?: string;
    bundleKey?: string;
    hasLocalPublicInputAuthority: boolean;
  },
): {
  value: SupportedPublicInputArtifact | undefined;
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

  return issues.length > 0 ? { value: undefined, issues } : { value: artifact, issues: [] };
}

function resolveConsistentElectionManifest(
  manifest: ElectionManifest | undefined,
  journal: ZkVMJournal,
  publicInputArtifact: SupportedPublicInputArtifact | undefined,
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

  return issues.length > 0 ? { value: undefined, issues } : { value: manifest, issues: [] };
}

function resolveConsistentCloseStatement(
  closeStatement: CloseStatement | undefined,
  journal: ZkVMJournal,
  publicInputArtifact: SupportedPublicInputArtifact | undefined,
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

  return issues.length > 0 ? { value: undefined, issues } : { value: closeStatement, issues: [] };
}

function matchesHex(left: string | undefined, right: string | undefined): boolean {
  return (
    typeof left === 'string' && typeof right === 'string' && normalizeHexString(left) === normalizeHexString(right)
  );
}

function hasAuthoritativePublicInputContext(
  provenance: SupportedPublicInputArtifact['provenance'],
  authority: {
    finalizationId?: string;
    bundleKey?: string;
    hasLocalPublicInputAuthority: boolean;
  },
): boolean {
  if (authority.hasLocalPublicInputAuthority) {
    if (authority.finalizationId && provenance.finalizationId !== authority.finalizationId) {
      return false;
    }
    if (authority.bundleKey && provenance.bundleKey !== authority.bundleKey) {
      return false;
    }
    return true;
  }

  if (provenance.source === 'generated') {
    if (authority.finalizationId) {
      if (provenance.finalizationId !== authority.finalizationId) {
        return false;
      }
    } else if (provenance.finalizationId !== undefined) {
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

  if (!authority.finalizationId) {
    return true;
  }

  return provenance.finalizationId === authority.finalizationId;
}

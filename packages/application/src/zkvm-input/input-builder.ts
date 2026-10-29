/**
 * zkVM input builder utilities
 * Shared helper functions for building zkVM input from session data.
 */

import type { ZkVMInput, VoteWithProof } from '@stark-ballot/zkvm-contract/zkvm/types';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import { hasMatchingElectionConfigHash } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import {
  assertCanonicalCtVoteIndices,
  getLatestCanonicalBulletinSnapshot,
  NON_CANONICAL_CT_VOTE_INDICES,
  parsePersistedRootHistory,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { asLeafIndex, asVoteIndex, type VoteIndex } from '@stark-ballot/domain/types/identifiers';
import { normalizeHexOrZero } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';

export class CtProofUnavailableError extends Error {
  readonly index: VoteIndex;
  readonly reason?: string;
  readonly expectedTreeSize?: number;
  readonly actualTreeSize?: number;

  constructor(index: VoteIndex, details?: { reason?: string; expectedTreeSize?: number; actualTreeSize?: number }) {
    super(`CT proof unavailable for vote index ${index}`);
    this.name = 'CtProofUnavailableError';
    this.index = index;
    if (details?.reason !== undefined) {
      this.reason = details.reason;
    }
    if (details?.expectedTreeSize !== undefined) {
      this.expectedTreeSize = details.expectedTreeSize;
    }
    if (details?.actualTreeSize !== undefined) {
      this.actualTreeSize = details.actualTreeSize;
    }
  }
}

export interface BuildZkVMInputOptions {
  /**
   * Allow sparse bulletin indices for finalize-time input tamper projections.
   *
   * Session/store state remains canonical by default; this escape hatch exists
   * only so educational exclusion scenarios can preserve original bulletin
   * indices and produce `missingSlots` inside the guest.
   */
  allowSparseVoteIndices?: boolean;
}

/**
 * Convert vote choice to number
 * A -> 0, B -> 1, C -> 2, D -> 3, E -> 4
 */
function choiceToNumber(choice: VoteChoice): number {
  const mapping: Record<VoteChoice, number> = {
    A: 0,
    B: 1,
    C: 2,
    D: 3,
    E: 4,
  };
  return mapping[choice];
}

export interface ZkVMInputSessionRecords {
  identity: SessionIdentityRecord;
  voting: SessionVotingRecord;
}

function getLatestVoteTimestamp(voting: Pick<SessionVotingRecord, 'votes'>): number | undefined {
  let latestTimestamp: number | undefined;

  for (const vote of voting.votes.values()) {
    if (typeof vote.timestamp === 'number' && Number.isInteger(vote.timestamp) && vote.timestamp > 0) {
      latestTimestamp = latestTimestamp === undefined ? vote.timestamp : Math.max(latestTimestamp, vote.timestamp);
    }
  }

  return latestTimestamp;
}

function getLiveBulletinSnapshot(
  voting: Pick<SessionVotingRecord, 'bulletin' | 'votes'>,
): { root: string; treeSize: number; timestamp: number } | undefined {
  const bulletin = voting.bulletin;

  const treeSize = typeof bulletin.getSize === 'function' ? bulletin.getSize() : undefined;
  if (treeSize === undefined || treeSize <= 0) {
    return undefined;
  }

  try {
    return {
      root: normalizeHexOrZero(bulletin.getCurrentRoot()),
      treeSize,
      timestamp: getLatestVoteTimestamp(voting) ?? Date.now(),
    };
  } catch {
    return undefined;
  }
}

function getLatestSTHSnapshot(
  voting: SessionVotingRecord,
  options: BuildZkVMInputOptions,
): { root: string; treeSize: number; timestamp: number } {
  const persistedSnapshot = getLatestPersistedSTHSnapshot(voting);
  if (persistedSnapshot !== undefined) {
    return persistedSnapshot;
  }

  if (options.allowSparseVoteIndices) {
    const liveBulletinSnapshot = getLiveBulletinSnapshot(voting);
    if (liveBulletinSnapshot !== undefined) {
      return liveBulletinSnapshot;
    }
  }

  const latestSnapshot = getLatestCanonicalBulletinSnapshot(voting);
  if (latestSnapshot !== undefined) {
    return latestSnapshot;
  }

  throw new Error('Missing STH snapshot data');
}

function getLatestPersistedSTHSnapshot(
  voting: SessionVotingRecord,
): { root: string; treeSize: number; timestamp: number } | undefined {
  const persistedHistory = parsePersistedRootHistory(voting.bulletinRootHistory);
  if (!persistedHistory || persistedHistory.length === 0) {
    return undefined;
  }

  const latestSnapshot = persistedHistory[persistedHistory.length - 1];
  if (!latestSnapshot) {
    return undefined;
  }
  return resolvePersistedBulletinSnapshot(voting.bulletin, latestSnapshot);
}

/**
 * Build zkVM input from session data
 * This function extracts all necessary data from a session
 * and formats it according to the ZkVMInput structure
 *
 * @param session The session data from the store
 * @param electionId Optional election ID (defaults to fixed value for PoC)
 * @param electionConfigHash Optional election config hash (defaults to zero for PoC)
 * @returns ZkVMInput structure ready for zkVM execution
 */
export function buildZkVMInputFromSession(
  records: ZkVMInputSessionRecords,
  options: BuildZkVMInputOptions = {},
): ZkVMInput {
  const { identity, voting } = records;
  if (identity.sessionId !== voting.sessionId) {
    throw new Error('Session identity and voting records do not match');
  }
  const { electionConfig, logId: rawLogId } = identity as Partial<SessionIdentityRecord>;
  if (!electionConfig) {
    throw new Error('Missing electionConfig for session');
  }
  if (!hasMatchingElectionConfigHash(electionConfig, identity.electionConfigHash)) {
    throw new Error('Session electionConfig does not match electionConfigHash');
  }
  if (!rawLogId) {
    throw new Error('Missing logId for session');
  }

  const electionId = identity.electionId;
  const electionConfigHash = identity.electionConfigHash;

  const sthSnapshot = getLatestSTHSnapshot(voting, options);
  const bulletinRoot = normalizeHexOrZero(sthSnapshot.root);
  const treeSize = sthSnapshot.treeSize;
  const totalExpected = electionConfig.totalExpected;
  const logId = normalizeHexOrZero(rawLogId);
  const votesWithProofs = buildVotesWithProofs(voting, electionId, treeSize, options);

  return {
    electionId,
    electionConfigHash,
    bulletinRoot,
    treeSize,
    totalExpected,
    logId,
    timestamp: sthSnapshot.timestamp,
    votes: votesWithProofs,
  };
}

function resolveInputVoteIndices(
  votes: ReadonlyMap<number, StoredVoteRecord>,
  options: BuildZkVMInputOptions,
): VoteIndex[] {
  const sortedIndices = Array.from(votes.keys()).sort((a, b) => a - b);

  if (!options.allowSparseVoteIndices) {
    assertCanonicalCtVoteIndices(sortedIndices);
    return sortedIndices.map(asVoteIndex);
  }

  try {
    return sortedIndices.map(asVoteIndex);
  } catch {
    throw new Error(NON_CANONICAL_CT_VOTE_INDICES);
  }
}

function buildVotesWithProofs(
  voting: SessionVotingRecord,
  electionId: string,
  treeSize: number,
  options: BuildZkVMInputOptions,
): VoteWithProof[] {
  const sortedIndices = resolveInputVoteIndices(voting.votes, options);

  return sortedIndices.map((index) => {
    const voteData = voting.votes.get(index);
    if (!voteData) {
      throw new Error(`Vote data not found for index ${index}`);
    }
    const choice = choiceToNumber(voteData.vote);
    const random = normalizeHexOrZero(voteData.rand);
    const commitment = computeCommitment(electionId, choice, random);
    return {
      commitment,
      choice,
      random,
      index,
      merklePath: resolveMerklePath(voting, index, voteData, treeSize),
    };
  });
}

/**
 * Resolve the Merkle inclusion path for a vote index from the canonical
 * bulletin authority. Stored vote records deliberately carry no proof path.
 */
function resolveMerklePath(
  voting: SessionVotingRecord,
  index: VoteIndex,
  voteData: StoredVoteRecord,
  treeSize: number,
): string[] {
  const bulletinProof = resolvePathFromBulletin(voting, index, voteData, treeSize);
  if (bulletinProof) {
    if (bulletinProof.path.length > 0 || bulletinProof.treeSize <= 1) {
      return bulletinProof.path;
    }
  }

  throw new CtProofUnavailableError(index);
}

function resolvePathFromBulletin(
  voting: SessionVotingRecord,
  index: VoteIndex,
  voteData: StoredVoteRecord,
  treeSize: number,
): { path: string[]; treeSize: number } | null {
  const bulletin = voting.bulletin;
  if (typeof bulletin.getInclusionProof !== 'function') {
    return null;
  }

  try {
    const proof = bulletin.getInclusionProof(voteData.voteId, treeSize);
    if (!proof || !Array.isArray(proof.proofNodes)) {
      return null;
    }
    const proofLeafIndex = asLeafIndex(proof.leafIndex);
    if (Number(proofLeafIndex) !== Number(index)) {
      throw new CtProofUnavailableError(index, { reason: 'leaf_index_mismatch' });
    }
    if (proof.treeSize !== treeSize) {
      throw new CtProofUnavailableError(index, {
        reason: 'tree_size_mismatch',
        expectedTreeSize: treeSize,
        actualTreeSize: proof.treeSize,
      });
    }

    // Return CT-style proof nodes with 0x prefix
    return {
      path: proof.proofNodes.map((node) => normalizeHexOrZero(node)),
      treeSize: proof.treeSize,
    };
  } catch (error) {
    if (error instanceof CtProofUnavailableError) {
      throw error;
    }
    logger.warn('[zkVM] Failed to obtain CT inclusion proof from bulletin:', error);
    return null;
  }
}

/**
 * Validate the canonical application/session input shape before exposing it as
 * a private debugging artifact. This is stricter than the Rust wire preflight:
 * guest-accounted records remain representable at the wire boundary.
 */
export function validateCanonicalZkVMInput(input: ZkVMInput): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const seenIndices = new Set<VoteIndex>();

  // Check election fields
  if (!input.electionId || input.electionId.length !== 36) {
    errors.push('Invalid electionId: must be a UUID v4');
  }

  if (!input.electionConfigHash || !input.electionConfigHash.match(/^0x[0-9a-f]{64}$/i)) {
    errors.push('Invalid electionConfigHash: must be 32 bytes hex');
  }

  // Check bulletin fields
  if (!input.bulletinRoot || !input.bulletinRoot.match(/^(0x)?[0-9a-f]+$/i)) {
    errors.push('Invalid bulletinRoot: must be hex string');
  }

  if (input.treeSize <= 0 || input.treeSize > 1000000) {
    errors.push('Invalid treeSize: must be between 1 and 1000000');
  }

  if (input.totalExpected <= 0 || input.totalExpected > 1000000) {
    errors.push('Invalid totalExpected: must be between 1 and 1000000');
  }

  // Check STH fields
  if (!input.logId || !input.logId.match(/^0x[0-9a-f]{64}$/i)) {
    errors.push('Invalid logId: must be 32 bytes hex');
  }

  if (input.timestamp <= 0) {
    errors.push('Invalid timestamp: must be positive');
  }

  // Check votes
  if (!Array.isArray(input.votes)) {
    errors.push('Invalid votes: must be an array');
  } else {
    // Check each vote
    input.votes.forEach((vote, i) => {
      if (!vote.commitment || !vote.commitment.match(/^0x[0-9a-f]{64}$/i)) {
        errors.push(`Invalid vote[${i}].commitment: must be 32 bytes hex`);
      }

      if (vote.choice < 0 || vote.choice > 4) {
        errors.push(`Invalid vote[${i}].choice: must be 0-4`);
      }

      if (!vote.random || !vote.random.match(/^0x[0-9a-f]{64}$/i)) {
        errors.push(`Invalid vote[${i}].random: must be 32 bytes hex`);
      }

      observeCanonicalVoteIndex(vote, i, seenIndices, errors);

      if (!Array.isArray(vote.merklePath)) {
        errors.push(`Invalid vote[${i}].merklePath: must be an array`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function resolvePersistedBulletinSnapshot(
  bulletin: SessionVotingRecord['bulletin'],
  latestSnapshot: { root: string; treeSize: number; timestamp: number },
): { root: string; treeSize: number; timestamp: number } | undefined {
  const bulletinSize = typeof bulletin.getSize === 'function' ? bulletin.getSize() : undefined;
  if (bulletinSize === undefined || bulletinSize <= 0) {
    return latestSnapshot;
  }

  try {
    const bulletinRoot = normalizeHexOrZero(bulletin.getCurrentRoot());
    if (bulletinSize === latestSnapshot.treeSize && bulletinRoot === normalizeHexOrZero(latestSnapshot.root)) {
      return latestSnapshot;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function observeCanonicalVoteIndex(
  vote: VoteWithProof,
  i: number,
  seenIndices: Set<VoteIndex>,
  errors: string[],
): void {
  try {
    const voteIndex = asVoteIndex(vote.index);
    if (seenIndices.has(voteIndex)) {
      errors.push(`Duplicate vote index: ${vote.index}`);
    } else {
      seenIndices.add(voteIndex);
    }
  } catch {
    errors.push(`Invalid vote[${i}].index: must be non-negative`);
  }
}

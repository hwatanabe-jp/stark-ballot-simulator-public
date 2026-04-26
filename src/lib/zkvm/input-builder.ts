/**
 * zkVM input builder utilities
 * Shared helper functions for building zkVM input from session data.
 */

import type { ZkVMInput, VoteWithProof } from './types';
import { computeCommitment } from './types';
import type { SessionData, VoteData } from '@/types/server';
import type { VoteChoice } from '@/shared/constants';
import { hasMatchingElectionConfigHash } from './election-config';
import {
  assertCanonicalCtVoteIndices,
  getLatestCanonicalBulletinSnapshot,
  NON_CANONICAL_CT_VOTE_INDICES,
  parsePersistedRootHistory,
} from '@/lib/store/ctSessionState';
import { normalizeHexOrZero } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';

export class CtProofUnavailableError extends Error {
  readonly index: number;
  readonly reason?: string;
  readonly expectedTreeSize?: number;
  readonly actualTreeSize?: number;

  constructor(index: number, details?: { reason?: string; expectedTreeSize?: number; actualTreeSize?: number }) {
    super(`CT proof unavailable for vote index ${index}`);
    this.name = 'CtProofUnavailableError';
    this.index = index;
    this.reason = details?.reason;
    this.expectedTreeSize = details?.expectedTreeSize;
    this.actualTreeSize = details?.actualTreeSize;
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
export function choiceToNumber(choice: VoteChoice): number {
  const mapping: Record<VoteChoice, number> = {
    A: 0,
    B: 1,
    C: 2,
    D: 3,
    E: 4,
  };
  return mapping[choice];
}

function getLatestVoteTimestamp(session: Pick<SessionData, 'votes'>): number | undefined {
  let latestTimestamp: number | undefined;

  for (const vote of session.votes.values()) {
    if (typeof vote.timestamp === 'number' && Number.isInteger(vote.timestamp) && vote.timestamp > 0) {
      latestTimestamp = latestTimestamp === undefined ? vote.timestamp : Math.max(latestTimestamp, vote.timestamp);
    }
  }

  return latestTimestamp;
}

function getLiveBulletinSnapshot(
  session: Pick<SessionData, 'bulletin' | 'votes'>,
): { root: string; treeSize: number; timestamp: number } | undefined {
  const bulletin = session.bulletin;
  if (!bulletin) {
    return undefined;
  }

  const treeSize = typeof bulletin.getSize === 'function' ? bulletin.getSize() : undefined;
  if (treeSize === undefined || treeSize <= 0) {
    return undefined;
  }

  try {
    return {
      root: normalizeHexOrZero(bulletin.getCurrentRoot()),
      treeSize,
      timestamp: getLatestVoteTimestamp(session) ?? Date.now(),
    };
  } catch {
    return undefined;
  }
}

function getLatestSTHSnapshot(
  session: SessionData,
  options: BuildZkVMInputOptions,
): { root: string; treeSize: number; timestamp: number } {
  const persistedSnapshot = getLatestPersistedSTHSnapshot(session);
  if (persistedSnapshot !== undefined) {
    return persistedSnapshot;
  }

  if (options.allowSparseVoteIndices) {
    const liveBulletinSnapshot = getLiveBulletinSnapshot(session);
    if (liveBulletinSnapshot !== undefined) {
      return liveBulletinSnapshot;
    }
  }

  const latestSnapshot = getLatestCanonicalBulletinSnapshot(session, 'zkVMInput');
  if (latestSnapshot !== undefined) {
    return latestSnapshot;
  }

  throw new Error('Missing STH snapshot data');
}

function getLatestPersistedSTHSnapshot(
  session: SessionData,
): { root: string; treeSize: number; timestamp: number } | undefined {
  const persistedHistory = parsePersistedRootHistory(session.bulletinRootHistory, {
    sessionId: session.sessionId,
    logLabel: 'zkVMInput',
  });
  if (!persistedHistory || persistedHistory.length === 0) {
    return undefined;
  }

  const latestSnapshot = persistedHistory[persistedHistory.length - 1];
  const bulletin = session.bulletin;
  if (!bulletin) {
    return latestSnapshot;
  }

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
export function buildZkVMInputFromSession(session: SessionData, options: BuildZkVMInputOptions = {}): ZkVMInput {
  if (!session.electionId) {
    throw new Error('Missing electionId for session');
  }
  if (!session.electionConfig) {
    throw new Error('Missing electionConfig for session');
  }
  if (!session.electionConfigHash) {
    throw new Error('Missing electionConfigHash for session');
  }
  if (!hasMatchingElectionConfigHash(session.electionConfig, session.electionConfigHash)) {
    throw new Error('Session electionConfig does not match electionConfigHash');
  }

  const electionId = session.electionId;
  const electionConfigHash = session.electionConfigHash;

  const sthSnapshot = getLatestSTHSnapshot(session, options);
  const bulletinRoot = normalizeHexOrZero(sthSnapshot.root);
  const treeSize = sthSnapshot.treeSize;
  const totalExpected = session.electionConfig.totalExpected;
  const logId = getLogId(session);
  const votesWithProofs = buildVotesWithProofs(session, electionId, treeSize, options);

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

function resolveInputVoteIndices(votes: ReadonlyMap<number, VoteData>, options: BuildZkVMInputOptions): number[] {
  const sortedIndices = Array.from(votes.keys()).sort((a, b) => a - b);

  if (!options.allowSparseVoteIndices) {
    assertCanonicalCtVoteIndices(sortedIndices);
    return sortedIndices;
  }

  for (const index of sortedIndices) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(NON_CANONICAL_CT_VOTE_INDICES);
    }
  }

  return sortedIndices;
}

function buildVotesWithProofs(
  session: SessionData,
  electionId: string,
  treeSize: number,
  options: BuildZkVMInputOptions,
): VoteWithProof[] {
  const sortedIndices = resolveInputVoteIndices(session.votes, options);

  return sortedIndices.map((index) => {
    const voteData = session.votes.get(index);
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
      merklePath: resolveMerklePath(session, index, voteData, treeSize),
    };
  });
}

/**
 * Resolve the Merkle inclusion path for a vote index using available session data.
 * Prefers pre-computed paths, falls back to dynamically generated proofs when possible.
 */
function resolveMerklePath(session: SessionData, index: number, voteData: VoteData, treeSize: number): string[] {
  const bulletinProof = resolvePathFromBulletin(session, index, voteData, treeSize);
  if (bulletinProof) {
    if (bulletinProof.path.length > 0 || bulletinProof.treeSize <= 1) {
      return bulletinProof.path;
    }
  }

  if (Array.isArray(voteData.path)) {
    if (typeof voteData.treeSize !== 'number') {
      throw new CtProofUnavailableError(index, { reason: 'missing_tree_size', expectedTreeSize: treeSize });
    }
    if (voteData.treeSize !== treeSize) {
      throw new CtProofUnavailableError(index, {
        reason: 'tree_size_mismatch',
        expectedTreeSize: treeSize,
        actualTreeSize: voteData.treeSize,
      });
    }
    if (voteData.path.length > 0 || treeSize <= 1) {
      return voteData.path.map((node) => normalizeHexOrZero(node));
    }
  }

  throw new CtProofUnavailableError(index);
}

function resolvePathFromBulletin(
  session: SessionData,
  index: number,
  voteData: VoteData,
  treeSize: number,
): { path: string[]; treeSize: number } | null {
  // SessionData.bulletin is already typed as SimpleBulletinBoard | undefined
  // No type casting needed
  const bulletin = session.bulletin;
  if (!bulletin || typeof bulletin.getInclusionProof !== 'function') {
    return null;
  }

  // Get voteId from voteData, or fallback to querying bulletin by index
  const voteEntry = typeof bulletin.getVoteByIndex === 'function' ? bulletin.getVoteByIndex(index) : undefined;
  const voteId = voteData.voteId ?? voteEntry?.voteId;

  if (!voteId) {
    return null;
  }

  try {
    const proof = bulletin.getInclusionProof(voteId, treeSize);
    if (!proof || !Array.isArray(proof.proofNodes)) {
      return null;
    }
    if (proof.leafIndex !== index) {
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

function getLogId(session: SessionData): string {
  const rawLogId = session.logId ?? (session.bulletin ? session.bulletin.getLogId() : undefined);

  if (!rawLogId) {
    throw new Error('Missing logId for session');
  }

  return normalizeHexOrZero(rawLogId);
}

/**
 * Validate zkVM input structure
 * Ensures all required fields are present and valid
 */
export function validateZkVMInput(input: ZkVMInput): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const seenIndices = new Set<number>();

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

      if (vote.index < 0) {
        errors.push(`Invalid vote[${i}].index: must be non-negative`);
      } else if (seenIndices.has(vote.index)) {
        errors.push(`Duplicate vote index: ${vote.index}`);
      } else {
        seenIndices.add(vote.index);
      }

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

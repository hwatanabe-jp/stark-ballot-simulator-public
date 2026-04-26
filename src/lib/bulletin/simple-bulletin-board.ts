/**
 * Simple Bulletin Board Implementation
 *
 * An append-only public bulletin board for vote commitments,
 * implementing the Certificate Transparency model with:
 * - Append-only Merkle tree (using RFC 6962 / CT)
 * - Monotonically increasing indices
 * - Root history tracking
 * - Consistency and inclusion proofs
 */

import { RFC6962MerkleTree } from '../merkle/rfc6962-merkle-tree';
import { isValidVoteId } from '../vote/voteId';
import type { ConsistencyProof } from '../merkle/consistency-proof';
import { generateLogId } from '@/lib/zkvm/log-id';
import { isValidHexString, normalizeHexString } from '@/lib/utils/hex';

/**
 * Vote information stored in the bulletin board
 */
export interface VoteEntry {
  voteId: string;
  commitment: string;
  index: number;
  timestamp: number;
  rootAtAppend: string;
}

/**
 * Result of appending a vote to the bulletin board
 */
export interface AppendResult {
  index: number;
  rootAtAppend: string;
  timestamp: number;
}

/**
 * Root snapshot for history tracking
 */
export interface RootSnapshot {
  timestamp: number;
  treeSize: number;
  root: string;
  signature?: string; // Optional for future TSA integration
}

/**
 * Inclusion proof for a specific vote
 */
export interface InclusionProof {
  leafIndex: number;
  proofNodes: string[];
  treeSize: number;
  rootHash: string;
}

/**
 * Simple Bulletin Board using an RFC 6962 / CT Merkle Tree
 *
 * Provides an append-only log for vote commitments with
 * cryptographic guarantees of integrity and consistency.
 */
export class SimpleBulletinBoard {
  private tree: RFC6962MerkleTree;
  private voteEntries: Map<string, VoteEntry>;
  private commitmentSet: Set<string>;
  private commitments: string[];
  private rootHistory: RootSnapshot[];
  private logId: string;

  constructor(logId?: string) {
    this.tree = new RFC6962MerkleTree();
    this.voteEntries = new Map();
    this.commitmentSet = new Set();
    this.commitments = [];
    this.rootHistory = [];
    this.logId = logId ?? generateLogId('simple-bulletin-board');
  }

  /**
   * Append a vote to the bulletin board
   *
   * @param voteId - Unique vote identifier (UUID v4)
   * @param commitment - Vote commitment (SHA-256 hash)
   * @returns Append result with index and root
   * @throws Error if vote ID or commitment is invalid or duplicate
   */
  appendVote(voteId: string, commitment: string): AppendResult {
    // Validate vote ID
    if (!isValidVoteId(voteId)) {
      throw new Error('Invalid vote ID format');
    }

    // Check for duplicate vote ID
    if (this.voteEntries.has(voteId)) {
      throw new Error('Vote ID already exists');
    }

    const normalizedCommitment = normalizeHexString(commitment);

    // Validate commitment
    if (!normalizedCommitment) {
      throw new Error('Commitment cannot be empty');
    }

    // Enforce SHA-256 length (32 bytes) and hex format
    if (!isValidHexString(normalizedCommitment, 32)) {
      throw new Error('Invalid commitment format');
    }

    // Check for duplicate commitment
    if (this.commitmentSet.has(normalizedCommitment)) {
      throw new Error('Commitment already exists');
    }

    // Get the index (monotonically increasing)
    const index = this.commitments.length;
    const timestamp = Date.now();

    // Append to the Merkle tree
    this.tree.append(normalizedCommitment);
    const rootAtAppend = this.tree.getRoot();

    // Store the vote entry
    const entry: VoteEntry = {
      voteId,
      commitment: normalizedCommitment,
      index,
      timestamp,
      rootAtAppend,
    };

    this.voteEntries.set(voteId, entry);
    this.commitmentSet.add(normalizedCommitment);
    this.commitments.push(normalizedCommitment);

    // Add to root history
    this.rootHistory.push({
      timestamp,
      treeSize: this.tree.size,
      root: rootAtAppend,
    });

    return {
      index,
      rootAtAppend,
      timestamp,
    };
  }

  /**
   * Get the current Merkle root
   */
  getCurrentRoot(): string {
    return this.tree.getRoot();
  }

  /**
   * Get the current size of the bulletin board
   */
  getSize(): number {
    return this.tree.size;
  }

  /**
   * Get all commitments in order
   */
  getCommitments(): string[] {
    return [...this.commitments];
  }

  /**
   * Get vote information by ID
   */
  getVoteById(voteId: string): VoteEntry | undefined {
    return this.voteEntries.get(voteId);
  }

  /**
   * Get vote information by index
   */
  getVoteByIndex(index: number): VoteEntry | undefined {
    if (index < 0 || index >= this.commitments.length) {
      return undefined;
    }

    // Find the vote entry with this index
    for (const entry of this.voteEntries.values()) {
      if (entry.index === index) {
        return entry;
      }
    }

    return undefined;
  }

  /**
   * Get the root history
   */
  getRootHistory(): RootSnapshot[] {
    return [...this.rootHistory];
  }

  getLogId(): string {
    return this.logId;
  }

  /**
   * Get the root at a specific tree size
   */
  getRootAtSize(size: number): string {
    return this.tree.getRootAtSize(size);
  }

  /**
   * Generate a consistency proof between two tree sizes
   */
  getConsistencyProof(oldSize: number, newSize: number): ConsistencyProof {
    return this.tree.getConsistencyProof(oldSize, newSize);
  }

  /**
   * Verify a consistency proof
   */
  verifyConsistency(oldRoot: string, newRoot: string, proof: ConsistencyProof): boolean {
    return this.tree.verifyConsistencyProof(oldRoot, newRoot, proof);
  }

  /**
   * Generate an inclusion proof for a vote
   *
   * @param voteId - The vote ID to generate proof for
   * @returns Inclusion proof or undefined if vote not found
   */
  getInclusionProof(voteId: string, treeSize?: number): InclusionProof | undefined {
    const entry = this.voteEntries.get(voteId);
    if (!entry) {
      return undefined;
    }

    const size = treeSize ?? this.tree.size;
    if (size <= 0) {
      throw new Error('Tree size must be positive');
    }
    if (size > this.tree.size) {
      throw new Error(`Tree size ${size} exceeds current tree size ${this.tree.size}`);
    }
    if (entry.index >= size) {
      throw new Error(`Leaf index ${entry.index} is out of range for tree size ${size}`);
    }

    const { proofNodes, leafIndex } = this.tree.getInclusionProof(entry.index, size);

    return {
      leafIndex,
      proofNodes,
      treeSize: size,
      rootHash: this.tree.getRootAtSize(size),
    };
  }

  /**
   * Verify an inclusion proof
   *
   * @param leafHash - The hash of the leaf (commitment)
   * @param leafIndex - The index of the leaf
   * @param proofNodes - The proof nodes
   * @param rootHash - The root hash to verify against
   * @param treeSize - The size of the tree
   * @returns true if the proof is valid
   */
  verifyInclusionProof(
    leafHash: string,
    leafIndex: number,
    proofNodes: string[],
    rootHash: string,
    treeSize: number,
  ): boolean {
    return this.tree.verifyInclusionProof(leafHash, leafIndex, proofNodes, rootHash, treeSize);
  }

  /**
   * Get statistics about the bulletin board
   */
  getStatistics(): {
    totalVotes: number;
    uniqueVoteIds: number;
    uniqueCommitments: number;
    rootHistoryLength: number;
    cacheHitRate: number;
  } {
    return {
      totalVotes: this.tree.size,
      uniqueVoteIds: this.voteEntries.size,
      uniqueCommitments: this.commitmentSet.size,
      rootHistoryLength: this.rootHistory.length,
      cacheHitRate: this.tree.getCacheHitRate(),
    };
  }

  /**
   * Clear all data (for testing purposes)
   */
  clear(): void {
    this.tree = new RFC6962MerkleTree();
    this.voteEntries.clear();
    this.commitmentSet.clear();
    this.commitments = [];
    this.rootHistory = [];
  }
}

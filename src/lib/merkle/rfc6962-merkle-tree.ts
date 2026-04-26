/**
 * RFC 6962-inspired / CT-style Merkle Tree implementation.
 *
 * Follows the RFC 6962 Certificate Transparency tree shape and proof
 * algorithms, with an application-specific leaf domain tag.
 *
 * Key features:
 * - CT-style MTH function for computing Merkle tree roots
 * - Domain separation (0x00 plus app tag for leaves, 0x01 for internal nodes)
 * - Efficient caching for historical roots
 * - Support for non-power-of-2 tree sizes
 */

import { utf8ToBytes } from '@noble/hashes/utils.js';
import { hexToBytesStrict, sha256Hex } from '@/lib/crypto/sha256';
import { isValidHexString, normalizeHexString } from '@/lib/utils/hex';
import type { ConsistencyProof } from './consistency-proof';

interface CacheStats {
  hits: number;
  misses: number;
}

export class RFC6962MerkleTree {
  private static readonly LEAF_DOMAIN_TAG = utf8ToBytes('stark-ballot:leaf|v1');

  private leaves: string[] = [];
  private rootCache: Map<number, string> = new Map();
  private mthCache: Map<string, string> = new Map();
  private cacheStats: CacheStats = { hits: 0, misses: 0 };

  /**
   * Current size of the tree (number of leaves)
   */
  get size(): number {
    return this.leaves.length;
  }

  /**
   * Get the current root of the tree
   */
  getRoot(): string {
    // For empty tree, return hash of empty input
    if (this.leaves.length === 0) {
      return sha256Hex();
    }
    return this.getRootAtSize(this.leaves.length);
  }

  /**
   * Append a new leaf to the tree
   */
  append(leaf: string): void {
    const normalized = normalizeHexString(leaf);

    // Validate input
    if (!normalized) {
      throw new Error('Leaf cannot be empty');
    }

    // Enforce SHA-256 length (32 bytes) and hex format
    if (!isValidHexString(normalized, 32)) {
      throw new Error('Invalid hex string');
    }

    // Add normalized leaf to the tree
    this.leaves.push(normalized);

    // Invalidate cache for sizes greater than the old size
    const oldSize = this.leaves.length - 1;
    const keysToDelete: number[] = [];
    for (const [size] of this.rootCache) {
      if (size > oldSize) {
        keysToDelete.push(size);
      }
    }
    keysToDelete.forEach((key) => this.rootCache.delete(key));
  }

  /**
   * Get the root at a specific historical size
   */
  getRootAtSize(size: number): string {
    if (size < 0) {
      throw new Error('Size must be positive');
    }

    // Special case: empty tree
    if (size === 0) {
      throw new Error('Size must be positive');
    }

    if (size > this.leaves.length) {
      throw new Error(`Size ${size} exceeds tree size ${this.leaves.length}`);
    }

    // Check cache first
    if (this.rootCache.has(size)) {
      this.cacheStats.hits++;
      const cached = this.rootCache.get(size);
      if (!cached) {
        throw new Error(`Missing cached root for size ${size}`);
      }
      return cached;
    }

    this.cacheStats.misses++;

    // Compute MTH for the given size
    const root = this.mthRange(0, size);

    // Cache the result
    this.rootCache.set(size, root);

    return root;
  }

  /**
   * CT-style MTH (Merkle Tree Hash) function
   *
   * Recursively computes the root hash of a subtree range
   */
  private mthRange(start: number, size: number): string {
    if (size < 0 || start < 0) {
      throw new Error('Invalid MTH range');
    }
    if (start + size > this.leaves.length) {
      throw new Error('MTH range exceeds tree size');
    }

    if (size === 0) {
      // MTH({}) = HASH()
      return sha256Hex();
    }

    if (size === 1) {
      const leaf = this.leaves[start];
      if (!leaf) {
        throw new Error(`Missing leaf at index ${start}`);
      }
      return this.hashLeaf(leaf);
    }

    const cacheKey = `${start}:${size}`;
    if (this.mthCache.has(cacheKey)) {
      const cached = this.mthCache.get(cacheKey);
      if (!cached) {
        throw new Error(`Missing cached MTH for key ${cacheKey}`);
      }
      return cached;
    }

    // For size > 1, find k = largest power of 2 < size
    const k = this.largestPowerOfTwoLessThan(size);
    if (k === 0) {
      throw new Error('Invalid MTH split encountered');
    }

    // MTH(D_n) = HASH(0x01 || MTH(D[0:k]) || MTH(D[k:n]))
    const leftHash = this.mthRange(start, k);
    const rightHash = this.mthRange(start + k, size - k);

    const result = sha256Hex(Uint8Array.of(0x01), hexToBytesStrict(leftHash), hexToBytesStrict(rightHash));

    // Cache the result
    this.mthCache.set(cacheKey, result);

    return result;
  }

  /**
   * Get cache statistics
   */
  getCacheSize(): number {
    return this.rootCache.size + this.mthCache.size;
  }

  /**
   * Get cache hit rate
   */
  getCacheHitRate(): number {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    if (total === 0) return 0;
    return this.cacheStats.hits / total;
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.rootCache.clear();
    this.mthCache.clear();
    this.cacheStats = { hits: 0, misses: 0 };
  }

  /**
   * Check if a number is a power of 2
   */
  private isPowerOfTwo(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
  }

  /**
   * Find the largest power of 2 less than n
   * For n = 5, returns 4
   * For n = 7, returns 4
   * For n = 8, returns 4 (since we want < n, not <= n)
   */
  private largestPowerOfTwoLessThan(n: number): number {
    if (n <= 1) return 0;
    let k = 1;
    while (k * 2 < n) {
      k *= 2;
    }
    return k;
  }

  /**
   * Generate a CT-style consistency proof between two tree states
   */
  getConsistencyProof(oldSize: number, newSize: number): ConsistencyProof {
    // Input validation
    if (oldSize <= 0) {
      throw new Error('oldSize must be positive');
    }
    if (newSize <= 0) {
      throw new Error('newSize must be positive');
    }
    if (oldSize > newSize) {
      throw new Error('oldSize must be <= newSize');
    }
    if (newSize > this.leaves.length) {
      throw new Error(`newSize ${newSize} exceeds tree size ${this.leaves.length}`);
    }

    // Same size - empty proof
    if (oldSize === newSize) {
      return {
        oldSize,
        newSize,
        proofNodes: [],
      };
    }

    // Generate the proof using the SubProof algorithm
    const proofNodes = this.subproof(oldSize, 0, newSize, true);

    return {
      oldSize,
      newSize,
      proofNodes,
    };
  }

  /**
   * RFC 6962-inspired SUBPROOF function
   * Generates minimal consistency proof recursively
   *
   * @param m - Size of the old tree
   * @param leaves - Current tree leaves
   * @param b - Whether the old tree is a complete subtree
   */
  private subproof(m: number, start: number, size: number, b: boolean): string[] {
    const n = size;

    // Base cases
    if (m === n && b) {
      return []; // Empty proof
    }

    if (m === n && !b) {
      // Return the root hash of the subtree
      return [this.mthRange(start, size)];
    }

    // Special case for 1→2: Return raw leaf, not MTH
    // According to RFC 6962, the consistency proof for 1→2 contains the raw second leaf
    if (m === 1 && n === 2 && b) {
      const leaf = this.leaves[start + 1];
      if (!leaf) {
        throw new Error('Missing leaf for 1→2 consistency proof');
      }
      return [leaf]; // Return raw leaf1, not MTH(leaf1)
    }

    // Find k = largest power of 2 < n
    const k = this.largestPowerOfTwoLessThan(n);

    // Recursive cases
    if (m <= k) {
      // Prove that the left subtree is consistent
      const leftProof = this.subproof(m, start, k, b);
      const rightHash = this.mthRange(start + k, n - k);
      return [...leftProof, rightHash];
    } else {
      // Prove that the right subtree is consistent
      const rightProof = this.subproof(m - k, start + k, n - k, false);
      const leftHash = this.mthRange(start, k);
      return [...rightProof, leftHash];
    }
  }

  /**
   * Verify a consistency proof
   * Verifies that oldRoot is consistent with newRoot using the provided proof
   */
  verifyConsistencyProof(oldRoot: string, newRoot: string, proof: ConsistencyProof): boolean {
    const { oldSize, newSize, proofNodes } = proof;

    // Same size - roots should match and proof should be empty
    if (oldSize === newSize) {
      return oldRoot === newRoot && proofNodes.length === 0;
    }

    // Empty proof for different sizes is invalid
    if (proofNodes.length === 0) {
      return false;
    }

    // Validate proof nodes are valid hex strings
    for (const node of proofNodes) {
      // Check valid hex string of correct length
      if (!node || node.length !== 64 || !/^[0-9a-fA-F]+$/.test(node)) {
        return false;
      }
    }

    // Special case: 1→2 verification
    if (oldSize === 1 && newSize === 2) {
      if (proofNodes.length !== 1) {
        return false;
      }

      // oldRoot = MTH(leaf0) = HASH(0x00 || leaf0)
      // newRoot should be = HASH(0x01 || MTH(leaf0) || MTH(leaf1))
      // proof contains raw leaf1
      const leaf1 = proofNodes[0];
      const mthLeaf1 = this.hashLeaf(leaf1);

      // Compute expected new root
      const computedNewRoot = this.hashPair(oldRoot, mthLeaf1);

      return computedNewRoot === newRoot;
    }

    // Special case: Power-of-2 to power-of-2 (e.g., 4→8)
    if (this.isPowerOfTwo(oldSize) && this.isPowerOfTwo(newSize) && newSize === oldSize * 2) {
      if (proofNodes.length !== 1) {
        return false;
      }

      // Simple doubling case: newRoot = HASH(0x01 || oldRoot || proofNodes[0])
      const computedNewRoot = this.hashPair(oldRoot, proofNodes[0]);

      return computedNewRoot === newRoot;
    }

    try {
      const { oldHash, newHash, nextIndex } = this.reconstructConsistencyHashes(
        oldSize,
        newSize,
        proofNodes,
        0,
        true,
        oldRoot,
      );

      // All proof nodes must be consumed and both hashes must match
      return nextIndex === proofNodes.length && oldHash === oldRoot && newHash === newRoot;
    } catch {
      return false;
    }
  }

  /**
   * Recursively reconstruct the old and new roots from the proof nodes.
   *
   * Mirrors the SUBPROOF generation logic to ensure we only rely on
   * the provided proof nodes and the known old root, making the proof
   * independently verifiable.
   */
  private reconstructConsistencyHashes(
    oldSize: number,
    newSize: number,
    proofNodes: string[],
    index: number,
    includeOldRoot: boolean,
    knownOldRoot?: string,
  ): { oldHash: string; newHash: string; nextIndex: number } {
    // When the subtree sizes are equal, either reuse the known old root
    // (includeOldRoot = true) or consume the subtree hash from the proof
    if (oldSize === newSize) {
      if (includeOldRoot) {
        if (!knownOldRoot) {
          throw new Error('Known old root required for prefix subtree');
        }
        return { oldHash: knownOldRoot, newHash: knownOldRoot, nextIndex: index };
      }

      if (index >= proofNodes.length) {
        throw new Error('Proof exhausted while reading subtree hash');
      }

      const subtreeHash = proofNodes[index];
      return { oldHash: subtreeHash, newHash: subtreeHash, nextIndex: index + 1 };
    }

    // Special-case the 1→2 transition where the proof carries the raw leaf
    if (oldSize === 1 && newSize === 2 && includeOldRoot) {
      if (!knownOldRoot) {
        throw new Error('Known old root required for 1→2 verification');
      }

      if (index >= proofNodes.length) {
        throw new Error('Proof exhausted while reading raw leaf');
      }

      const rawLeaf = proofNodes[index];
      const hashedLeaf = this.hashLeaf(rawLeaf);
      const newHash = this.hashPair(knownOldRoot, hashedLeaf);
      return { oldHash: knownOldRoot, newHash, nextIndex: index + 1 };
    }

    const split = this.largestPowerOfTwoLessThan(newSize);
    if (split === 0) {
      throw new Error('Invalid tree split encountered');
    }

    if (oldSize <= split) {
      // Entire old prefix lies in the left subtree
      const left = this.reconstructConsistencyHashes(oldSize, split, proofNodes, index, includeOldRoot, knownOldRoot);

      const nextIndex = left.nextIndex;
      if (nextIndex >= proofNodes.length) {
        throw new Error('Proof exhausted while reading right subtree hash');
      }

      const rightHash = proofNodes[nextIndex];
      const combinedNewHash = this.hashPair(left.newHash, rightHash);
      return {
        oldHash: left.oldHash,
        newHash: combinedNewHash,
        nextIndex: nextIndex + 1,
      };
    }

    // Old prefix spans into the right subtree. The right branch is generated
    // with includeOldRoot = false, so the proof carries all hashes we need.
    const right = this.reconstructConsistencyHashes(oldSize - split, newSize - split, proofNodes, index, false);

    const nextIndex = right.nextIndex;
    if (nextIndex >= proofNodes.length) {
      throw new Error('Proof exhausted while reading left subtree hash');
    }

    const leftHash = proofNodes[nextIndex];
    const combinedOldHash = this.hashPair(leftHash, right.oldHash);
    const combinedNewHash = this.hashPair(leftHash, right.newHash);

    if (includeOldRoot && knownOldRoot && combinedOldHash !== knownOldRoot) {
      throw new Error('Old root mismatch detected');
    }

    return {
      oldHash: combinedOldHash,
      newHash: combinedNewHash,
      nextIndex: nextIndex + 1,
    };
  }

  /**
   * Hash a single leaf with domain separator
   */
  private hashLeaf(leafHex: string): string {
    return sha256Hex(Uint8Array.of(0x00), RFC6962MerkleTree.LEAF_DOMAIN_TAG, hexToBytesStrict(leafHex));
  }

  /**
   * Hash two nodes together with internal node domain separator
   */
  private hashPair(left: string, right: string): string {
    return sha256Hex(Uint8Array.of(0x01), hexToBytesStrict(left), hexToBytesStrict(right));
  }

  /**
   * Generate a CT-style inclusion proof (audit path) for a leaf
   *
   * @param leafIndex - The 0-based index of the leaf
   * @param treeSize - The size of the tree
   * @returns The inclusion proof containing the audit path
   */
  getInclusionProof(
    leafIndex: number,
    treeSize?: number,
  ): {
    leafIndex: number;
    proofNodes: string[];
  } {
    const size = treeSize ?? this.leaves.length;

    // Input validation
    if (leafIndex < 0) {
      throw new Error('Leaf index must be non-negative');
    }

    if (leafIndex >= size) {
      throw new Error(`Leaf index ${leafIndex} is out of range for tree size ${size}`);
    }

    if (size > this.leaves.length) {
      throw new Error(`Tree size ${size} exceeds actual tree size ${this.leaves.length}`);
    }

    // Generate the audit path using the PATH function
    const proofNodes = this.path(leafIndex, 0, size);

    return {
      leafIndex,
      proofNodes,
    };
  }

  /**
   * RFC 6962-inspired PATH function
   * Generates the audit path for a leaf in the Merkle tree
   *
   * @param m - The 0-based index of the leaf
   * @param leaves - The leaves of the tree
   * @returns The audit path nodes
   */
  private path(m: number, start: number, size: number): string[] {
    const n = size;

    if (n === 0) {
      return [];
    }

    if (n === 1) {
      // Single leaf, no proof needed
      return [];
    }

    // Find k = largest power of 2 < n
    const k = this.largestPowerOfTwoLessThan(n);

    if (m < k) {
      // Leaf is in the left subtree
      const leftPath = this.path(m, start, k);
      const rightHash = this.mthRange(start + k, n - k);
      return [...leftPath, rightHash];
    } else {
      // Leaf is in the right subtree
      const rightPath = this.path(m - k, start + k, n - k);
      const leftHash = this.mthRange(start, k);
      return [...rightPath, leftHash];
    }
  }

  /**
   * Verify a CT-style inclusion proof
   *
   * Verifies that a leaf at a given index is included in the tree
   * by reconstructing the root using the audit path.
   *
   * The algorithm follows the same tree structure as the PATH function,
   * recursively dividing the tree at the largest power of 2 less than
   * the tree size, ensuring consistency between proof generation and verification.
   *
   * @param leafHash - The raw leaf data (will be hashed with domain separator)
   * @param leafIndex - The 0-based index of the leaf
   * @param proofNodes - The audit path nodes (sibling hashes)
   * @param rootHash - The root hash to verify against
   * @param treeSize - The total size of the tree
   * @returns true if the proof is valid, false otherwise
   */
  verifyInclusionProof(
    leafHash: string,
    leafIndex: number,
    proofNodes: string[],
    rootHash: string,
    treeSize: number,
  ): boolean {
    // Input validation
    if (leafIndex < 0 || leafIndex >= treeSize) {
      return false;
    }

    // Hash the leaf with the app-specific CT-style leaf domain separator.
    const hashedLeaf = this.hashLeaf(leafHash);

    // Special case: single leaf tree has no proof nodes
    if (treeSize === 1 && proofNodes.length === 0) {
      return hashedLeaf === rootHash;
    }

    // Recursively verify the proof path
    try {
      const result = this.verifyPathRecursive(leafIndex, treeSize, hashedLeaf, proofNodes, 0);

      return result.computedRoot === rootHash && result.nodesConsumed === proofNodes.length;
    } catch {
      // Invalid proof structure (e.g., insufficient proof nodes)
      return false;
    }
  }

  /**
   * Recursively verify inclusion proof following the MTH tree structure
   *
   * This helper function mirrors the PATH function's recursive traversal,
   * ensuring that proof verification follows the same tree decomposition
   * as proof generation.
   *
   * @param index - Current index within the subtree
   * @param size - Size of the current subtree
   * @param nodeHash - Hash of the current node
   * @param proofNodes - Complete array of proof nodes
   * @param proofPos - Current position in the proof array
   * @returns Object containing the computed root and number of proof nodes consumed
   */
  private verifyPathRecursive(
    index: number,
    size: number,
    nodeHash: string,
    proofNodes: string[],
    proofPos: number,
  ): { computedRoot: string; nodesConsumed: number } {
    // Base case: single element subtree
    if (size === 1) {
      return { computedRoot: nodeHash, nodesConsumed: 0 };
    }

    // Find split point: k = largest power of 2 < size
    // This matches the tree structure used by the MTH function
    const k = this.largestPowerOfTwoLessThan(size);

    if (index < k) {
      // Target is in the left subtree [0, k)
      // Recursively process left subtree
      const leftResult = this.verifyPathRecursive(index, k, nodeHash, proofNodes, proofPos);

      // Get right subtree hash from proof
      const rightSiblingHash = proofNodes[proofPos + leftResult.nodesConsumed];
      if (!rightSiblingHash) {
        throw new Error('Insufficient proof nodes');
      }

      // Combine left and right to get parent hash
      const parentHash = this.hashPair(leftResult.computedRoot, rightSiblingHash);

      return {
        computedRoot: parentHash,
        nodesConsumed: leftResult.nodesConsumed + 1,
      };
    } else {
      // Target is in the right subtree [k, size)
      // Recursively process right subtree
      const rightResult = this.verifyPathRecursive(
        index - k, // Adjust index relative to right subtree
        size - k, // Right subtree size
        nodeHash,
        proofNodes,
        proofPos,
      );

      // Get left subtree hash from proof
      const leftSiblingHash = proofNodes[proofPos + rightResult.nodesConsumed];
      if (!leftSiblingHash) {
        throw new Error('Insufficient proof nodes');
      }

      // Combine left and right to get parent hash
      const parentHash = this.hashPair(leftSiblingHash, rightResult.computedRoot);

      return {
        computedRoot: parentHash,
        nodesConsumed: rightResult.nodesConsumed + 1,
      };
    }
  }
}

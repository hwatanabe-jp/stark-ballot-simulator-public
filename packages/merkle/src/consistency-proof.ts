/**
 * RFC 6962 consistency proof shape used by the canonical bulletin-board path.
 *
 * `oldSubtreeHashes` and `appendSubtreeHashes` are optional public diagnostic
 * metadata. RFC 6962 verification depends only on `proofNodes`.
 */

/**
 * Consistency proof data structure
 * Contains the minimal set of nodes needed to verify consistency
 */
export interface ConsistencyProof {
  oldSize: number; // Size of the tree at the older state
  newSize: number; // Size of the tree at the newer state
  proofNodes: string[]; // Minimal set of nodes for verification (hex strings)
  oldSubtreeHashes?: string[];
  appendSubtreeHashes?: string[];
}

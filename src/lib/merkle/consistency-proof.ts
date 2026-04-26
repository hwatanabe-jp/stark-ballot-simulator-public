/**
 * RFC 6962 consistency proof shape used by the canonical bulletin-board path.
 *
 * `oldSubtreeHashes`, `appendSubtreeHashes`, and `treeCapacity` remain optional
 * compatibility fields on the type because older fixtures and responses may
 * still surface them at parse boundaries, but the maintained runtime path does
 * not generate or consume them.
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
  treeCapacity?: number;
}

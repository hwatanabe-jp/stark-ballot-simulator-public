/**
 * Type definitions for consistency proof API
 *
 * These types define the contract for the consistency proof endpoint,
 * which is critical for verifying the append-only property of the
 * bulletin board and preventing split-view attacks.
 */

/**
 * Request parameters for consistency proof generation
 */
export interface ConsistencyProofRequest {
  /** Size of the tree at the older state (must be >= 0) */
  oldSize: number;
  /** Size of the tree at the newer state (must be >= oldSize) */
  newSize: number;
}

/**
 * Response structure for consistency proof
 *
 * Contains the proof data needed to verify consistency between two tree states,
 * as specified in RFC 6962 Certificate Transparency.
 */
export interface ConsistencyProofResponse {
  /** Size of the tree at the older state */
  oldSize: number;
  /** Size of the tree at the newer state */
  newSize: number;
  /** Root hash at the older tree state */
  rootAtOldSize: string;
  /** Root hash at the newer tree state */
  rootAtNewSize: string;
  /** Minimal set of nodes needed for verification */
  proofNodes: string[];
  /** Optional structured hashes for old tree prefix ("size:hash") */
  oldSubtreeHashes?: string[];
  /** Optional structured hashes for appended suffix ("size:hash") */
  appendSubtreeHashes?: string[];
  /** Timestamp of the proof generation */
  timestamp: number;
}

/**
 * Error response structure for consistency proof API
 */
export interface ConsistencyProofError {
  /** Error message */
  error: string;
  /** Optional detailed error information */
  details?: string;
}

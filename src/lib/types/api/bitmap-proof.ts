/**
 * Bitmap proof API types following final_design.md §2.6.1
 *
 * Server returns only raw materials, client calculates bit positions
 * to prevent UI attacks that could misrepresent indices
 */

export type BitmapKind = 'included' | 'seen';
export type BitmapProofErrorCode =
  | 'INVALID_INDEX'
  | 'INVALID_BITMAP_KIND'
  | 'SESSION_NOT_FOUND'
  | 'BITMAP_NOT_FOUND'
  | 'INTERNAL_ERROR';
export type BitmapProofArtifactState = 'unsupported_current_artifact' | 'corrupt_or_unreadable';

/**
 * Request for bitmap proof
 * Client requests proof for a specific vote index
 */
export interface BitmapProofRequest {
  /** Vote index to verify (0-based, must be < treeSize) */
  i: number;
  /** Which bitmap to prove against (default: included) */
  kind?: BitmapKind;
}

/**
 * Response containing proof materials
 * Server provides chunk and audit path, client does verification
 */
export interface BitmapProofResponse {
  /**
   * 32-byte chunk containing the requested bit
   * Hex string (64 characters)
   * Warning: This reveals the inclusion status of up to 255 neighboring votes
   */
  leafChunk: string;

  /**
   * Merkle audit path from chunk to root
   * CT-style hashing with domain separators
   */
  auditPath: Array<{
    /** Hash value (hex string, 64 characters) */
    hash: string;
    /** Position of this hash relative to the current node */
    position: 'left' | 'right';
  }>;
}

/**
 * Error response for bitmap proof API
 */
export interface BitmapProofError {
  error: string;
  code?: BitmapProofErrorCode;
  message?: string;
  statusCode?: number;
  artifactState?: BitmapProofArtifactState;
}

/**
 * Internal structure for storing bitmap data
 * (Not exposed to API, used internally)
 */
export interface StoredBitmapData {
  /** Session ID this bitmap belongs to */
  sessionId: string;
  /** The included bitmap (true = counted, false = excluded) */
  includedBitmap: boolean[];
  /** The computed Merkle root of the bitmap */
  includedBitmapRoot: string;
  /** Optional presented-index bitmap used for explainability */
  seenBitmap?: boolean[];
  /** Root of the presented-index bitmap */
  seenBitmapRoot?: string;
  /** Tree size at finalization */
  treeSize: number;
  /** Timestamp of finalization */
  finalizedAt: number;
}

/**
 * Client-side verification result
 */
export interface BitmapVerificationResult {
  /** Whether the proof is valid */
  valid: boolean;
  /** The bit value at the requested index (true = counted, false = excluded) */
  included: boolean;
  /** The leaf index in the Merkle tree */
  leafIndex: number;
  /** The bit offset within the leaf chunk */
  bitOffset: number;
}

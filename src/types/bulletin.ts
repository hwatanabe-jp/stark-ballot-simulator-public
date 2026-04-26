/**
 * Public bulletin board for E2E verification
 */
export interface BulletinBoard {
  /** All vote commitments in chronological order */
  commitments: string[];
  /** Bulletin board root */
  bulletinRoot: string;
  /** Current tree size */
  treeSize: number;
  /** Timestamp of last update */
  timestamp: number;
  /** Root history for consistency proofs */
  rootHistory: RootSnapshot[];
}

/**
 * Root snapshot for history tracking
 */
export interface RootSnapshot {
  /** Unix timestamp */
  timestamp: number;
  /** Bulletin root at this time */
  bulletinRoot: string;
  /** Tree size at this time */
  treeSize: number;
  /** Optional TSA signature */
  signature?: string;
}

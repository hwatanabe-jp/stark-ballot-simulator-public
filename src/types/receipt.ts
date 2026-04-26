/**
 * Vote receipt for E2E verification
 */
export interface VoteReceipt {
  /** Unique vote identifier (UUID v4) */
  voteId: string;
  /** SHA-256 commitment of the vote */
  commitment: string;
  /** Position in the bulletin board (monotone index) */
  bulletinIndex: number;
  /** Merkle root at the time of casting the vote */
  bulletinRootAtCast: string;
  /** Hash of the zkVM input for tamper-evident verification (required after finalization) */
  inputCommitment?: string;
  /** Unix timestamp when the vote was cast */
  timestamp: number;
  /** Optional: Digital signature for future extension */
  signature?: string;
}

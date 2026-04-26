/**
 * zkVM input hash API types
 *
 * This endpoint calculates and returns the hash of zkVM input data
 * Useful for debugging and verification purposes
 */

import type { ZkVMInput } from '@/lib/zkvm/types';

/**
 * Request for zkVM input hash calculation
 * GET /api/zkvm-input-hash
 */
export interface ZkVMInputHashRequest {
  /** Session ID to calculate hash for */
  sessionId: string;
  /** Include the full zkVM input data in response (requires debug authorization) */
  includeData?: boolean;
}

/**
 * Response containing the zkVM input hash
 */
export interface ZkVMInputHashResponse {
  /**
   * The input commitment hash (SHA256)
   * This is the same value that would be included in the zkVM journal
   * Hex string (64 characters)
   */
  inputCommitment: string;

  /**
   * Optional: Full zkVM input data (only if includeData=true and debug authorization is valid)
   * Warning: This contains sensitive vote data and should only be used for debugging
   */
  data?: {
    /** The complete zkVM input structure */
    zkVMInput: ZkVMInput;
    /** Number of votes in the input */
    votesCount: number;
    /** Tree size from the bulletin board */
    treeSize: number;
    /** Bulletin board root hash */
    bulletinRoot: string;
    /** Election ID */
    electionId: string;
    /** Timestamp when the input was prepared */
    timestamp: number;
  };
}

/**
 * Error response for zkVM input hash API
 */
export interface ZkVMInputHashError {
  error: string;
  code?:
    | 'SESSION_NOT_FOUND'
    | 'SESSION_NOT_FINALIZED'
    | 'INVALID_REQUEST'
    | 'CT_PROOF_UNAVAILABLE'
    | 'INCLUDE_DATA_FORBIDDEN'
    | 'INTERNAL_ERROR';
  details?: string;
  message?: string;
  statusCode?: number;
  artifactState?: 'unsupported_current_artifact' | 'corrupt_or_unreadable';
}

/**
 * Type guard for error response
 */
export function isZkVMInputHashError(response: unknown): response is ZkVMInputHashError {
  return typeof response === 'object' && response !== null && 'error' in response && 'code' in response;
}

/**
 * zkVM input hash API types
 *
 * This endpoint calculates and returns the public commitment for zkVM input data.
 */

/**
 * Request for zkVM input hash calculation
 * GET /api/zkvm-input-hash
 */
export interface ZkVMInputHashRequest {
  /** Session ID to calculate hash for */
  sessionId: string;
  /** Retired private-data variant. Truthy values are rejected by the target API. */
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
    | 'ROUTE_RETIRED'
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

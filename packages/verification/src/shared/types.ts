export interface VoteReceipt {
  voteId: string;
  commitment: string;
  bulletinIndex: number;
  bulletinRootAtCast: string;
  inputCommitment?: string;
  timestamp: number;
  signature?: string;
}

export interface RootSnapshot {
  timestamp: number;
  bulletinRoot: string;
  treeSize: number;
  signature?: string;
}

export interface BulletinBoard {
  commitments: string[];
  bulletinRoot: string;
  treeSize: number;
  timestamp: number;
  rootHistory: RootSnapshot[];
}

export type BitmapProofSource = 'mock' | 'real';
export type VerificationStatus = 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running';
export const VERIFICATION_FAILURE_CATEGORY_VALUES = [
  'none',
  'verifier_crash',
  'corrupt_bundle',
  's3_denied',
  's3_missing',
  'timeout',
  'unknown',
] as const;
export type VerificationFailureCategory = (typeof VERIFICATION_FAILURE_CATEGORY_VALUES)[number];
export type PublicVerificationErrorMessage =
  | 'ImageID mismatch'
  | 'Receipt does not contain ImageID'
  | 'Invalid proof'
  | 'Failed to download bundle'
  | 'Verification failed';

export interface VerificationReport {
  status: VerificationStatus;
  verifier_version: string;
  verified_at: string;
  duration_ms: number;
  expected_image_id: string;
  receipt_image_id: string | null;
  dev_mode_receipt: boolean;
  errors?: string[];
}

export interface VerificationResult {
  status: VerificationStatus;
  report?: VerificationReport;
  /** Internal-only worker infrastructure classification. Never expose through public projections. */
  failureCategory?: VerificationFailureCategory;
}

export interface PublicVerificationReport {
  status: VerificationStatus;
  verifier_version?: string;
  verified_at?: string;
  duration_ms?: number;
  expected_image_id?: string;
  receipt_image_id?: string | null;
  dev_mode_receipt?: boolean;
  errors?: PublicVerificationErrorMessage[];
}

export interface PublicVerificationResult {
  status: VerificationStatus;
  report?: PublicVerificationReport;
}

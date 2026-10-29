import type {
  VerifierServiceDevModeReport,
  VerifierServiceFailedReport,
  VerifierServiceReport,
  VerifierServiceSuccessReport,
} from '../verification/verifier-service-report';

export interface VoteReceipt {
  voteId: string;
  commitment: string;
  bulletinIndex: number;
  bulletinRootAtCast: string;
  inputCommitment?: string;
  timestamp: number;
  signature?: string;
}

export type BitmapProofSource = 'mock' | 'real';
export const VERIFICATION_STATUS_VALUES = ['success', 'failed', 'dev_mode', 'not_run', 'running'] as const;
export const TERMINAL_VERIFICATION_STATUS_VALUES = ['success', 'failed', 'dev_mode'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUS_VALUES)[number];

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
/** Exact terminal report projected from the verifier-service wire contract. */
export type VerificationReport = VerifierServiceReport;

type InfrastructureVerificationFailureCategory = Exclude<VerificationFailureCategory, 'none'>;

/**
 * Internal verifier state is one closed outcome. Status-only variants remain
 * intentional for queued work and synthetic/mock execution; whenever a report
 * is present, its terminal status must match the result discriminator.
 */
export type VerificationResult =
  | Readonly<{
      status: 'not_run' | 'running';
      report?: never;
      failureCategory?: 'none';
    }>
  | Readonly<{
      status: 'success';
      report?: VerifierServiceSuccessReport;
      failureCategory?: 'none';
    }>
  | Readonly<{
      status: 'dev_mode';
      report?: VerifierServiceDevModeReport;
      failureCategory?: 'none';
    }>
  | Readonly<{
      status: 'failed';
      report?: VerifierServiceFailedReport;
      /** Internal-only worker infrastructure classification. Never expose through public projections. */
      failureCategory?: InfrastructureVerificationFailureCategory;
    }>;

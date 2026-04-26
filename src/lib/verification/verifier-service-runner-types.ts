export interface VerifierServiceRunnerOptions {
  uploadToS3?: boolean;
  workDir?: string;
}

export interface VerifierServiceRunnerS3Payload {
  mode: 's3_bundle';
  sessionId: string;
  executionId: string;
  bundleKey: string;
  expectedImageId: string;
  options?: VerifierServiceRunnerOptions;
}

/**
 * Supported app-side runner payload.
 *
 * Trusted local bundle verification stays in-process via verifier-service and is
 * intentionally not modeled as a second runner selector contract here.
 */
export type VerifierServiceRunnerPayload = VerifierServiceRunnerS3Payload;

export interface VerifierServiceRunnerSuccess {
  status: 'success';
  sessionId: string;
  executionId: string;
  verifierStatus: string;
  verificationReport: unknown;
  s3?: {
    bundleUrl?: string;
    bundleKey?: string;
    reportKey?: string;
    uploadedAt?: string;
    expiresAt?: string;
  };
}

export interface VerifierServiceRunnerError {
  status: 'error';
  message: string;
  details?: unknown;
}

export type VerifierServiceRunnerResponse = VerifierServiceRunnerSuccess | VerifierServiceRunnerError;

import type { VerificationReport } from '@stark-ballot/verification/shared/types';

interface VerificationWorkerSuccessBase {
  status: 'success';
  sessionId: string;
  finalizationId: string;
  s3?: {
    bundleKey?: string;
    reportKey?: string;
    uploadedAtMs?: number;
  };
}

export type VerificationWorkerSuccess =
  | (VerificationWorkerSuccessBase & {
      verifierStatus: 'success';
      verificationReport: Extract<VerificationReport, { status: 'success' }>;
    })
  | (VerificationWorkerSuccessBase & {
      verifierStatus: 'dev_mode';
      verificationReport: Extract<VerificationReport, { status: 'dev_mode' }>;
    })
  | (VerificationWorkerSuccessBase & {
      verifierStatus: 'failed';
      verificationReport: Extract<VerificationReport, { status: 'failed' }>;
    });

export interface VerificationWorkerError {
  status: 'error';
  message: string;
  details?: unknown;
}

export type VerificationWorkerResponse = VerificationWorkerSuccess | VerificationWorkerError;

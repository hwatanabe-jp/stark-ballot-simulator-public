import type { VerificationResult, VerificationStatus } from '@stark-ballot/verification/shared/types';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import type { AdmittedReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import type { ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import type { FinalizationId } from './finalization-types';

export type ProofBundleVerificationResult = VerificationResult;

export interface ProofBundleOptions {
  sessionId: string;
  finalizationId: FinalizationId;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  electionManifest?: ElectionManifest;
  zkvmResult: ZkVMExecutionResult;
  normalizedReceipt: {
    receipt: ReceiptWithImageId;
    rawPayload: AdmittedReceiptPayload;
  };
  expectedImageId: string;
  allowDevMode: boolean;
  verificationMode?: 'verify' | 'mock';
}

export type ProofBundleFailure =
  | {
      type: 'verifier_failed';
      finalizationId: FinalizationId;
      status: VerificationStatus;
      report: NonNullable<VerificationResult['report']>;
    }
  | {
      type: 'invocation_failed';
      error: Error;
    };

export type ProofBundleOutcome =
  | {
      ok: true;
      verificationResult: ProofBundleVerificationResult;
      finalizationId: FinalizationId;
    }
  | { ok: false; error: ProofBundleFailure };

export interface ProofBundleService {
  createBundle: (options: ProofBundleOptions) => Promise<ProofBundleOutcome>;
}

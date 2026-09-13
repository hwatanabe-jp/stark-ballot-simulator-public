import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import type { AdmittedReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import type { ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import type { FinalizationId } from './finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export type ProofBundleVerificationResult = VerificationResult;

export interface ProofBundleOptions {
  sessionId: SessionId;
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
  | ({
      type: 'verifier_failed';
      finalizationId: FinalizationId;
    } & (
      | {
          status: 'dev_mode';
          report: Extract<NonNullable<VerificationResult['report']>, { status: 'dev_mode' }>;
        }
      | {
          status: 'failed';
          report: Extract<NonNullable<VerificationResult['report']>, { status: 'failed' }>;
        }
    ))
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

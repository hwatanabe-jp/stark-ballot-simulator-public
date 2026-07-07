import type {
  VerificationReport,
  VerificationResult,
  VerificationStatus,
} from '@stark-ballot/verification/shared/types';
import type { ProofBundleOptions, ProofBundleService } from '@stark-ballot/application/finalize/proof-bundle-service';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import type { AdmittedReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import type { ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { logger } from '@stark-ballot/diagnostics/logger';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export type { ProofBundleOptions };

export type VerifierStatus = VerificationStatus;

export interface VerifierInvocationResult {
  status: VerifierStatus;
  bundlePath: string;
  reportPath: string;
  report: VerificationReport;
}

export type InvokeVerifier = (input: {
  bundlePath: string;
  expectedImageId: string;
  reportPath: string;
}) => Promise<VerifierInvocationResult>;

export interface VerificationBundleResult {
  bundlePath: string;
  receiptPath: string;
  inputPath: string;
  journalPath: string;
  electionManifestPath: string;
  closeStatementPath: string;
  metadataPath: string;
  reportPath: string;
  sessionId: string;
  executionId: string;
}

export interface ProofBundlePersistenceInput {
  sessionId: string;
  contractGeneration: string;
  verifierWorkDir?: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  electionManifest?: ElectionManifest;
  zkvmResult: ZkVMExecutionResult;
  normalizedReceipt: {
    receipt: ReceiptWithImageId;
    rawPayload: AdmittedReceiptPayload;
  };
}

export interface BundlePublicationResult {
  bundleArchivePath: string;
  s3BundleKey?: string;
  s3ReportKey?: string;
  s3UploadedAt?: string;
}

export interface ApiProofBundleRuntimeOptions {
  verifierWorkDir?: string;
}

export interface ApiProofBundleDependencies {
  persistBundle: (input: ProofBundlePersistenceInput) => Promise<VerificationBundleResult>;
  invokeVerifier: InvokeVerifier;
  publishBundleArtifacts: (input: {
    bundlePath: string;
    sessionId: string;
    executionId: string;
    upload: boolean;
  }) => Promise<BundlePublicationResult>;
  recordBundlePublication?: (input: {
    sessionId: string;
    executionId: string;
    s3BundleKey?: string;
    s3ReportKey?: string;
    s3UploadedAt?: string;
  }) => Promise<void>;
  createMockVerificationReport: (input: {
    bundle: VerificationBundleResult;
    options: ProofBundleOptions;
  }) => Promise<VerifierInvocationResult>;
}

export function createApiProofBundleService(
  runtime: ApiProofBundleRuntimeOptions,
  deps: ApiProofBundleDependencies,
): ProofBundleService {
  return {
    async createBundle(options: ProofBundleOptions) {
      try {
        const bundle = await deps.persistBundle({
          sessionId: options.sessionId,
          contractGeneration: options.contractGeneration,
          ...omitUndefinedProperties({ verifierWorkDir: runtime.verifierWorkDir }),
          zkvmInput: options.zkvmInput,
          electionConfig: options.electionConfig,
          ...omitUndefinedProperties({ electionManifest: options.electionManifest }),
          zkvmResult: options.zkvmResult,
          normalizedReceipt: options.normalizedReceipt,
        });

        if (options.verificationMode === 'mock') {
          const mockInvocation = await deps.createMockVerificationReport({ bundle, options });
          const publication = await deps.publishBundleArtifacts({
            bundlePath: bundle.bundlePath,
            sessionId: bundle.sessionId,
            executionId: bundle.executionId,
            upload: true,
          });
          await recordBundlePublication(deps, bundle, publication);

          return {
            ok: true,
            ...buildVerificationOutcome({
              invocation: mockInvocation,
              bundle,
            }),
          };
        }

        const invocation = await deps.invokeVerifier({
          bundlePath: bundle.bundlePath,
          expectedImageId: options.expectedImageId,
          reportPath: bundle.reportPath,
        });

        const accepted = invocation.status === 'success' || (invocation.status === 'dev_mode' && options.allowDevMode);
        const publication = await deps.publishBundleArtifacts({
          bundlePath: bundle.bundlePath,
          sessionId: bundle.sessionId,
          executionId: bundle.executionId,
          upload: accepted,
        });
        if (invocation.status === 'dev_mode' && options.allowDevMode) {
          logger.warn('[API] verifier-service returned dev_mode; accepting because dev mode is enabled');
        } else if (invocation.status !== 'success') {
          logger.error('[API] verifier-service returned non-success status', invocation.status);
          return {
            ok: false,
            error: {
              type: 'verifier_failed',
              executionId: bundle.executionId,
              status: invocation.status,
              report: invocation.report,
            },
          };
        }
        await recordBundlePublication(deps, bundle, publication);

        return {
          ok: true,
          ...buildVerificationOutcome({
            invocation,
            bundle,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            type: 'invocation_failed',
            error: error instanceof Error ? error : new Error('Verifier service invocation failed'),
          },
        };
      }
    },
  };
}

async function recordBundlePublication(
  deps: ApiProofBundleDependencies,
  bundle: VerificationBundleResult,
  publication: BundlePublicationResult,
): Promise<void> {
  if (!deps.recordBundlePublication) {
    return;
  }

  await deps.recordBundlePublication({
    sessionId: bundle.sessionId,
    executionId: bundle.executionId,
    ...(publication.s3BundleKey ? { s3BundleKey: publication.s3BundleKey } : {}),
    ...(publication.s3ReportKey ? { s3ReportKey: publication.s3ReportKey } : {}),
    ...(publication.s3UploadedAt ? { s3UploadedAt: publication.s3UploadedAt } : {}),
  });
}

function buildVerificationOutcome(options: {
  invocation: VerifierInvocationResult;
  bundle: VerificationBundleResult;
}): {
  verificationResult: VerificationResult;
  executionId: string;
} {
  const { invocation, bundle } = options;

  return {
    verificationResult: {
      status: invocation.status,
      report: invocation.report,
    },
    executionId: bundle.executionId,
  };
}

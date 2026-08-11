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
  finalizationId: string;
}

export interface ProofBundlePersistenceInput {
  sessionId: string;
  finalizationId: string;
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
  s3UploadedAtMs?: number;
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
    finalizationId: string;
    upload: boolean;
  }) => Promise<BundlePublicationResult>;
  recordBundlePublication?: (input: {
    sessionId: string;
    finalizationId: string;
    s3BundleKey?: string;
    s3ReportKey?: string;
    s3UploadedAtMs?: number;
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
          finalizationId: options.finalizationId,
          ...omitUndefinedProperties({ verifierWorkDir: runtime.verifierWorkDir }),
          zkvmInput: options.zkvmInput,
          electionConfig: options.electionConfig,
          ...omitUndefinedProperties({ electionManifest: options.electionManifest }),
          zkvmResult: options.zkvmResult,
          normalizedReceipt: options.normalizedReceipt,
        });
        assertPersistedBundleIdentity(bundle, options);

        if (options.verificationMode === 'mock') {
          const mockInvocation = await deps.createMockVerificationReport({ bundle, options });
          const publication = await deps.publishBundleArtifacts({
            bundlePath: bundle.bundlePath,
            sessionId: bundle.sessionId,
            finalizationId: bundle.finalizationId,
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
          finalizationId: bundle.finalizationId,
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
              finalizationId: bundle.finalizationId,
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

function assertPersistedBundleIdentity(bundle: VerificationBundleResult, options: ProofBundleOptions): void {
  if (bundle.sessionId !== options.sessionId) {
    throw new Error('Persisted proof bundle session identity does not match the request');
  }
  if (bundle.finalizationId !== options.finalizationId) {
    throw new Error('Persisted proof bundle finalization identity does not match the request');
  }
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
    finalizationId: bundle.finalizationId,
    ...(publication.s3BundleKey ? { s3BundleKey: publication.s3BundleKey } : {}),
    ...(publication.s3ReportKey ? { s3ReportKey: publication.s3ReportKey } : {}),
    ...(publication.s3UploadedAtMs !== undefined ? { s3UploadedAtMs: publication.s3UploadedAtMs } : {}),
  });
}

function buildVerificationOutcome(options: {
  invocation: VerifierInvocationResult;
  bundle: VerificationBundleResult;
}): {
  verificationResult: VerificationResult;
  finalizationId: string;
} {
  const { invocation, bundle } = options;

  return {
    verificationResult: {
      status: invocation.status,
      report: invocation.report,
    },
    finalizationId: bundle.finalizationId,
  };
}

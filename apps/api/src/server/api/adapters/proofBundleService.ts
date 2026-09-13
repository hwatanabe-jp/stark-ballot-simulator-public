import type {
  VerifierServiceDevModeReport,
  VerifierServiceFailedReport,
  VerifierServiceSuccessReport,
} from '@stark-ballot/verification/verifier-service-report';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { ProofBundleOptions, ProofBundleService } from '@stark-ballot/application/finalize/proof-bundle-service';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import type { AdmittedReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import type { ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { logger } from '@stark-ballot/diagnostics/logger';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export type { ProofBundleOptions };

interface VerifierInvocationResultBase {
  bundlePath: string;
  reportPath: string;
}

export type VerifierInvocationResult =
  | (VerifierInvocationResultBase & {
      status: 'success';
      report: VerifierServiceSuccessReport;
    })
  | (VerifierInvocationResultBase & {
      status: 'dev_mode';
      report: VerifierServiceDevModeReport;
    })
  | (VerifierInvocationResultBase & {
      status: 'failed';
      report: VerifierServiceFailedReport;
    });

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
  sessionId: SessionId;
  finalizationId: FinalizationId;
}

export interface ProofBundlePersistenceInput {
  sessionId: SessionId;
  finalizationId: FinalizationId;
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
    sessionId: SessionId;
    finalizationId: FinalizationId;
    upload: boolean;
  }) => Promise<BundlePublicationResult>;
  recordBundlePublication?: (input: {
    sessionId: SessionId;
    finalizationId: FinalizationId;
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
        if (invocation.status === 'dev_mode') {
          if (options.allowDevMode) {
            logger.warn('[API] verifier-service returned dev_mode; accepting because dev mode is enabled');
          } else {
            logger.error('[API] verifier-service returned non-success status', invocation.status);
            return {
              ok: false,
              error: {
                type: 'verifier_failed',
                finalizationId: bundle.finalizationId,
                status: 'dev_mode',
                report: invocation.report,
              },
            };
          }
        } else if (invocation.status === 'failed') {
          logger.error('[API] verifier-service returned non-success status', invocation.status);
          return {
            ok: false,
            error: {
              type: 'verifier_failed',
              finalizationId: bundle.finalizationId,
              status: 'failed',
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
  finalizationId: FinalizationId;
} {
  const { invocation, bundle } = options;

  return {
    verificationResult: projectVerificationResult(invocation),
    finalizationId: bundle.finalizationId,
  };
}

function projectVerificationResult(invocation: VerifierInvocationResult): VerificationResult {
  switch (invocation.status) {
    case 'success':
      return { status: 'success', report: invocation.report };
    case 'dev_mode':
      return { status: 'dev_mode', report: invocation.report };
    case 'failed':
      return { status: 'failed', report: invocation.report };
  }
}

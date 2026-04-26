import { promises as fs } from 'node:fs';
import type { VerificationResult } from '@/types/server';
import type { ZkVMInput } from '@/lib/zkvm/types';
import type { ZkVMExecutionResult } from '@/lib/zkvm/executor';
import type { ElectionConfig } from '@/lib/zkvm/election-config';
import type { ReceiptWithImageId } from '@/lib/verification/image-id-types';
import type { ElectionManifest } from '@/lib/verification/public-audit-artifacts';
import type {
  VerificationReport,
  VerifierInvocationResult,
  VerifierStatus,
} from '@/lib/verification/verifier-service-client';
import {
  persistVerificationBundle,
  createVerificationBundleArchive,
  uploadVerificationBundleToS3,
  type VerificationBundleResult,
  type S3UploadResult,
} from '@/lib/verification/verification-bundle';
import { invokeVerifierService } from '@/lib/verification/verifier-service-client';
import { logger } from '@/lib/utils/logger';

export interface ProofBundleOptions {
  sessionId: string;
  contractGeneration: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  electionManifest?: ElectionManifest;
  zkvmResult: ZkVMExecutionResult;
  normalizedReceipt: {
    receipt: ReceiptWithImageId;
    rawPayload: Record<string, unknown>;
  };
  expectedImageId: string;
  publicBaseUrl: string;
  allowDevMode: boolean;
  verificationMode?: 'verify' | 'mock';
  buildBundleUrl: (baseUrl: string, sessionId: string, executionId: string, ...segments: string[]) => string;
}

export type ProofBundleFailure =
  | {
      type: 'verifier_failed';
      executionId: string;
      status: VerifierStatus;
      reportPath: string;
      bundlePath: string;
      bundleArchivePath: string;
      bundleUrl: string;
      reportUrl: string;
      report: VerifierInvocationResult['report'];
    }
  | {
      type: 'invocation_failed';
      error: Error;
    };

export type ProofBundleOutcome =
  | { ok: true; verificationResult: VerificationResult }
  | { ok: false; error: ProofBundleFailure };

export interface ProofBundleService {
  createBundle: (options: ProofBundleOptions) => Promise<ProofBundleOutcome>;
}

export interface ProofBundleDependencies {
  persistBundle?: typeof persistVerificationBundle;
  invokeVerifier?: typeof invokeVerifierService;
  createArchive?: typeof createVerificationBundleArchive;
  uploadToS3?: typeof uploadVerificationBundleToS3;
}

/**
 * Build a proof bundle service that persists artifacts, runs verifier-service, and uploads to S3.
 */
export function createProofBundleService(deps: ProofBundleDependencies = {}): ProofBundleService {
  const persistBundle = deps.persistBundle ?? persistVerificationBundle;
  const invokeVerifier = deps.invokeVerifier ?? invokeVerifierService;
  const createArchive = deps.createArchive ?? createVerificationBundleArchive;
  const uploadToS3 = deps.uploadToS3 ?? uploadVerificationBundleToS3;

  return {
    async createBundle(options: ProofBundleOptions): Promise<ProofBundleOutcome> {
      try {
        const bundle = await persistBundle({
          sessionId: options.sessionId,
          contractGeneration: options.contractGeneration,
          zkvmInput: options.zkvmInput,
          electionConfig: options.electionConfig,
          electionManifest: options.electionManifest,
          zkvmResult: options.zkvmResult,
          normalizedReceipt: options.normalizedReceipt,
        });

        if (options.verificationMode === 'mock') {
          const mockInvocation = await writeMockVerificationReport(bundle, options);
          await createArchive(bundle.bundlePath);
          const s3Result = await uploadToS3(bundle.bundlePath, bundle.sessionId, bundle.executionId);

          return {
            ok: true,
            verificationResult: buildVerificationResult({
              invocation: mockInvocation,
              bundle,
              s3Result,
            }),
          };
        }

        const invocation = await invokeVerifier({
          bundlePath: bundle.bundlePath,
          expectedImageId: options.expectedImageId,
          reportPath: bundle.reportPath,
        });

        const bundleArchivePath = await createArchive(bundle.bundlePath);
        const bundleUrl = options.buildBundleUrl(options.publicBaseUrl, bundle.sessionId, bundle.executionId);
        const reportUrl = options.buildBundleUrl(options.publicBaseUrl, bundle.sessionId, bundle.executionId, 'report');

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
              reportPath: invocation.reportPath,
              bundlePath: invocation.bundlePath,
              bundleArchivePath,
              bundleUrl,
              reportUrl,
              report: invocation.report,
            },
          };
        }

        const s3Result = await uploadToS3(bundle.bundlePath, bundle.sessionId, bundle.executionId);

        return {
          ok: true,
          verificationResult: buildVerificationResult({
            invocation,
            bundle,
            s3Result,
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

async function writeMockVerificationReport(
  bundle: VerificationBundleResult,
  options: ProofBundleOptions,
): Promise<VerifierInvocationResult> {
  const report: VerificationReport = {
    status: 'dev_mode',
    verifier_version: 'mock-bundle',
    verified_at: new Date().toISOString(),
    duration_ms: 0,
    expected_image_id: options.expectedImageId,
    receipt_image_id: options.normalizedReceipt.receipt.imageId ?? options.expectedImageId,
    bundle_path: bundle.bundlePath,
    receipt_path: bundle.receiptPath,
    dev_mode_receipt: true,
    errors: [],
  };

  await fs.writeFile(bundle.reportPath, JSON.stringify(report, null, 2), 'utf-8');

  logger.info('[API] Persisted mock verification report for bundle download contract', {
    sessionId: bundle.sessionId,
    executionId: bundle.executionId,
  });

  return {
    status: report.status,
    bundlePath: bundle.bundlePath,
    reportPath: bundle.reportPath,
    report,
  };
}

function buildVerificationResult(options: {
  invocation: VerifierInvocationResult;
  bundle: VerificationBundleResult;
  s3Result: S3UploadResult;
}): VerificationResult {
  const { invocation, bundle, s3Result } = options;

  return {
    status: invocation.status,
    report: invocation.report,
    s3BundleKey: s3Result.s3BundleKey,
    s3ReportKey: s3Result.s3ReportKey,
    s3UploadedAt: s3Result.s3UploadedAt,
    executionId: bundle.executionId,
  };
}

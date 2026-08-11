import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  persistVerificationBundleArtifacts,
  type PersistVerificationBundleArtifactsInput,
} from '@stark-ballot/node-adapters/verification-bundle';
import {
  buildVerificationBundleArtifacts,
  type VerificationBundleArtifactContext,
} from '@stark-ballot/verification/bundle';
import type { ProofBundleOptions, VerifierInvocationResult, VerificationBundleResult } from './proofBundleService';
import type { VerificationReport } from '@stark-ballot/verification/shared/types';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export function persistProofVerificationBundle(
  input: Omit<VerificationBundleArtifactContext, 'createdAt'> &
    Pick<PersistVerificationBundleArtifactsInput, 'finalizationId' | 'verifierWorkDir'>,
): Promise<VerificationBundleResult> {
  const { verifierWorkDir, ...artifactInput } = input;
  const { artifacts } = buildVerificationBundleArtifacts({
    ...artifactInput,
    createdAt: new Date().toISOString(),
  });

  return persistVerificationBundleArtifacts({
    sessionId: input.sessionId,
    finalizationId: input.finalizationId,
    ...omitUndefinedProperties({ verifierWorkDir: verifierWorkDir }),
    artifacts,
  }).then((persisted) => ({
    bundlePath: persisted.bundlePath,
    receiptPath: path.join(persisted.bundlePath, 'receipt.json'),
    inputPath: path.join(persisted.bundlePath, 'input.json'),
    journalPath: path.join(persisted.bundlePath, 'journal.json'),
    electionManifestPath: path.join(persisted.bundlePath, 'election-manifest.json'),
    closeStatementPath: path.join(persisted.bundlePath, 'close-statement.json'),
    metadataPath: path.join(persisted.bundlePath, 'metadata.json'),
    reportPath: path.join(persisted.bundlePath, 'verification.json'),
    sessionId: persisted.sessionId,
    finalizationId: persisted.finalizationId,
  }));
}

export async function createMockVerificationReport(input: {
  bundle: VerificationBundleResult;
  options: ProofBundleOptions;
}): Promise<VerifierInvocationResult> {
  const { bundle, options } = input;
  const report: VerificationReport = {
    status: 'dev_mode',
    verifier_version: 'mock-bundle',
    verified_at: new Date().toISOString(),
    duration_ms: 0,
    expected_image_id: options.expectedImageId,
    receipt_image_id: options.normalizedReceipt.receipt.imageId ?? options.expectedImageId,
    dev_mode_receipt: true,
    errors: [],
  };

  await fs.writeFile(bundle.reportPath, JSON.stringify(report, null, 2), 'utf-8');

  logger.info('[API] Persisted mock verification report for bundle download contract', {
    session_id_hash: hashSessionIdForLogging(bundle.sessionId),
    finalization_id: bundle.finalizationId,
  });

  return {
    status: report.status,
    bundlePath: bundle.bundlePath,
    reportPath: bundle.reportPath,
    report,
  };
}

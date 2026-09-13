import { promises as fs } from 'node:fs';
import path from 'node:path';
import { persistVerificationBundleArtifacts } from '@stark-ballot/node-adapters/verification-bundle';
import { buildVerificationBundleArtifacts } from '@stark-ballot/verification/bundle';
import {
  parseVerifierServiceWireReport,
  projectVerifierServiceWireReport,
} from '@stark-ballot/verification/verifier-service-report';
import type {
  ProofBundleOptions,
  ProofBundlePersistenceInput,
  VerifierInvocationResult,
  VerificationBundleResult,
} from './proofBundleService';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export function persistProofVerificationBundle(input: ProofBundlePersistenceInput): Promise<VerificationBundleResult> {
  const { verifierWorkDir, ...artifactInput } = input;
  const { artifacts } = buildVerificationBundleArtifacts({
    ...artifactInput,
    createdAt: new Date().toISOString(),
  });

  return persistVerificationBundleArtifacts({
    sessionId: input.sessionId,
    finalizationId: input.finalizationId,
    ...omitUndefinedProperties({ verifierWorkDir: verifierWorkDir }),
    artifacts: { ...artifacts },
  }).then((persisted) => {
    if (persisted.sessionId !== input.sessionId || persisted.finalizationId !== input.finalizationId) {
      throw new Error('Persisted verification bundle identity does not match admitted input');
    }
    return {
      bundlePath: persisted.bundlePath,
      receiptPath: path.join(persisted.bundlePath, 'receipt.json'),
      inputPath: path.join(persisted.bundlePath, 'input.json'),
      journalPath: path.join(persisted.bundlePath, 'journal.json'),
      electionManifestPath: path.join(persisted.bundlePath, 'election-manifest.json'),
      closeStatementPath: path.join(persisted.bundlePath, 'close-statement.json'),
      metadataPath: path.join(persisted.bundlePath, 'metadata.json'),
      reportPath: path.join(persisted.bundlePath, 'verification.json'),
      sessionId: input.sessionId,
      finalizationId: input.finalizationId,
    };
  });
}

export async function createMockVerificationReport(input: {
  bundle: VerificationBundleResult;
  options: ProofBundleOptions;
}): Promise<VerifierInvocationResult> {
  const { bundle, options } = input;
  const wireReport = parseVerifierServiceWireReport({
    status: 'dev_mode',
    verifier_version: 'mock-bundle',
    verified_at: new Date().toISOString(),
    duration_ms: 0,
    expected_image_id: options.expectedImageId,
    bundle_path: path.basename(bundle.bundlePath),
    receipt_path: path.basename(bundle.receiptPath),
    receipt_image_id: options.normalizedReceipt.receipt.imageId ?? options.expectedImageId,
    dev_mode_receipt: true,
  });
  if (wireReport.status !== 'dev_mode') {
    throw new Error('Mock verifier report did not preserve dev-mode status');
  }
  const report = projectVerifierServiceWireReport(wireReport);

  await fs.writeFile(bundle.reportPath, JSON.stringify(wireReport, null, 2), 'utf-8');

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

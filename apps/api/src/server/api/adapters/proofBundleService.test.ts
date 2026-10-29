import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProofBundleOptions } from '@stark-ballot/application/finalize/proof-bundle-service';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { admitReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import {
  parseVerifierServiceWireReport,
  projectVerifierServiceWireReport,
} from '@stark-ballot/verification/verifier-service-report';
import { createMockZkvmInput, createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import {
  createApiProofBundleService,
  type ApiProofBundleDependencies,
  type VerificationBundleResult,
  type VerifierInvocationResult,
} from './proofBundleService';
import { createMockVerificationReport } from './proofBundleLocalArtifacts';

const SESSION_ID = asSessionId('session-123');
const FINALIZATION_ID = asFinalizationId('01JCGXZ8M00000000000000000');
const EXPECTED_IMAGE_ID = '0x' + '11'.repeat(32);

function createProofBundleOptions(verificationMode: NonNullable<ProofBundleOptions['verificationMode']>) {
  const zkvmInput = createMockZkvmInput({ voteCount: 1, totalExpected: 1, treeSize: 1 });

  return {
    sessionId: SESSION_ID,
    finalizationId: FINALIZATION_ID,
    zkvmInput,
    electionConfig: buildDefaultElectionConfig(),
    zkvmResult: {
      ...createTestJournal({
        electionId: zkvmInput.electionId,
        totalExpected: 1,
        validVotes: 1,
      }),
    },
    normalizedReceipt: {
      receipt: {
        seal: 'test-seal',
        journal: 'test-journal',
        imageId: EXPECTED_IMAGE_ID,
      },
      rawPayload: admitReceiptPayload({ test: true }),
    },
    expectedImageId: EXPECTED_IMAGE_ID,
    allowDevMode: false,
    verificationMode,
  } satisfies ProofBundleOptions;
}

function createPersistedBundle(
  overrides: Partial<Pick<VerificationBundleResult, 'sessionId' | 'finalizationId'>> = {},
): VerificationBundleResult {
  return {
    bundlePath: '/tmp/bundle',
    receiptPath: '/tmp/bundle/receipt.json',
    inputPath: '/tmp/bundle/input.json',
    journalPath: '/tmp/bundle/journal.json',
    electionManifestPath: '/tmp/bundle/election-manifest.json',
    closeStatementPath: '/tmp/bundle/close-statement.json',
    metadataPath: '/tmp/bundle/metadata.json',
    reportPath: '/tmp/bundle/verification.json',
    sessionId: SESSION_ID,
    finalizationId: FINALIZATION_ID,
    ...overrides,
  };
}

function createDependencies(bundle: VerificationBundleResult) {
  const invocation: VerifierInvocationResult = {
    status: 'success',
    bundlePath: bundle.bundlePath,
    reportPath: bundle.reportPath,
    report: {
      status: 'success',
      verifier_version: 'test',
      verified_at: '2026-01-01T00:00:00.000Z',
      duration_ms: 1,
      expected_image_id: EXPECTED_IMAGE_ID,
      receipt_image_id: EXPECTED_IMAGE_ID,
      dev_mode_receipt: false,
    },
  };
  const persistBundle = vi.fn<ApiProofBundleDependencies['persistBundle']>().mockResolvedValue(bundle);
  const invokeVerifier = vi.fn<ApiProofBundleDependencies['invokeVerifier']>().mockResolvedValue(invocation);
  const publishBundleArtifacts = vi
    .fn<ApiProofBundleDependencies['publishBundleArtifacts']>()
    .mockResolvedValue({ bundleArchivePath: '/tmp/bundle/bundle.zip' });
  const recordBundlePublication = vi
    .fn<NonNullable<ApiProofBundleDependencies['recordBundlePublication']>>()
    .mockResolvedValue(undefined);
  const createMockVerificationReport = vi
    .fn<ApiProofBundleDependencies['createMockVerificationReport']>()
    .mockResolvedValue(invocation);

  return {
    dependencies: {
      persistBundle,
      invokeVerifier,
      publishBundleArtifacts,
      recordBundlePublication,
      createMockVerificationReport,
    },
    invokeVerifier,
    publishBundleArtifacts,
    recordBundlePublication,
    createMockVerificationReport,
  };
}

describe('createApiProofBundleService', () => {
  it.each([
    {
      mismatch: 'session',
      verificationMode: 'verify' as const,
      bundleOverrides: { sessionId: asSessionId('different-session') },
    },
    {
      mismatch: 'finalization',
      verificationMode: 'mock' as const,
      bundleOverrides: { finalizationId: asFinalizationId('01JCGXZ8M00000000000000001') },
    },
  ])(
    'fails closed before downstream effects when persistence returns a mismatched $mismatch identity',
    async ({ verificationMode, bundleOverrides }) => {
      const bundle = createPersistedBundle(bundleOverrides);
      const {
        dependencies,
        invokeVerifier,
        publishBundleArtifacts,
        recordBundlePublication,
        createMockVerificationReport,
      } = createDependencies(bundle);
      const service = createApiProofBundleService({}, dependencies);

      const result = await service.createBundle(createProofBundleOptions(verificationMode));

      expect(result.ok).toBe(false);
      if (result.ok || result.error.type !== 'invocation_failed') {
        throw new Error('Expected mismatched persisted identity to fail as an invocation error');
      }
      expect(result.error.error.message).toContain('identity');
      expect(invokeVerifier).not.toHaveBeenCalled();
      expect(createMockVerificationReport).not.toHaveBeenCalled();
      expect(publishBundleArtifacts).not.toHaveBeenCalled();
      expect(recordBundlePublication).not.toHaveBeenCalled();
    },
  );

  it('persists the protected mock report as wire data and returns its application projection', async () => {
    const testWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-verification-report-'));
    const bundlePath = path.join(testWorkDir, 'bundle');
    const bundle = {
      ...createPersistedBundle(),
      bundlePath,
      receiptPath: path.join(bundlePath, 'receipt.json'),
      reportPath: path.join(bundlePath, 'verification.json'),
    };

    try {
      await fs.mkdir(bundlePath);

      const invocation = await createMockVerificationReport({
        bundle,
        options: createProofBundleOptions('mock'),
      });
      const protectedReport = parseVerifierServiceWireReport(JSON.parse(await fs.readFile(bundle.reportPath, 'utf8')));

      expect(protectedReport).toMatchObject({
        status: 'dev_mode',
        bundle_path: 'bundle',
        receipt_path: 'receipt.json',
      });
      expect(invocation.report).toEqual(projectVerifierServiceWireReport(protectedReport));
      expect(invocation.report).not.toHaveProperty('bundle_path');
      expect(invocation.report).not.toHaveProperty('receipt_path');
    } finally {
      await fs.rm(testWorkDir, { recursive: true, force: true });
    }
  });
});

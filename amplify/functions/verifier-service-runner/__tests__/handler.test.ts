/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import * as yazl from 'yazl';
import { handler } from '../handler';

vi.mock('../../../../src/lib/aws/s3-download.js', () => ({
  downloadFromS3: vi.fn(),
}));

vi.mock('../../../../src/lib/verification/verifier-service-client.js', () => ({
  invokeVerifierService: vi.fn(),
}));

vi.mock('../../../../src/lib/verification/verification-bundle.js', () => ({
  uploadVerificationBundleToS3: vi.fn(),
}));

import { downloadFromS3 } from '../../../../src/lib/aws/s3-download.js';
import { invokeVerifierService } from '../../../../src/lib/verification/verifier-service-client.js';
import { uploadVerificationBundleToS3 } from '../../../../src/lib/verification/verification-bundle.js';

describe('verifier-service-runner handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function buildZipBuffer(entries: Record<string, string>): Promise<Buffer> {
    return await new Promise((resolve, reject) => {
      const zipfile = new yazl.ZipFile();
      const chunks: Buffer[] = [];

      const toBuffer = (chunk: unknown): Buffer => {
        if (Buffer.isBuffer(chunk)) {
          return chunk;
        }
        if (typeof chunk === 'string') {
          return Buffer.from(chunk);
        }
        if (chunk instanceof Uint8Array) {
          return Buffer.from(chunk);
        }
        if (chunk instanceof ArrayBuffer) {
          return Buffer.from(new Uint8Array(chunk));
        }
        throw new Error('Unexpected zip chunk');
      };

      for (const [fileName, content] of Object.entries(entries)) {
        zipfile.addBuffer(Buffer.from(content, 'utf8'), fileName, { mtime: new Date(0), compress: false });
      }

      zipfile.outputStream.on('data', (chunk: unknown) => {
        chunks.push(toBuffer(chunk));
      });
      zipfile.outputStream.on('error', reject);
      zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
      zipfile.on('error', reject);

      zipfile.end();
    });
  }

  it('processes s3_bundle mode by downloading and re-uploading the bundle', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-123';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const workDir = path.join(process.cwd(), '.test-verifier-runner');

    const zipBuffer = await buildZipBuffer({
      'input.json': JSON.stringify({ input: true }),
      'receipt.json': JSON.stringify({ receipt: true }),
      'journal.json': JSON.stringify({ journal: true }),
    });

    vi.mocked(downloadFromS3).mockResolvedValue(zipBuffer);

    vi.mocked(invokeVerifierService).mockResolvedValue({
      status: 'success',
      bundlePath: path.join(workDir, sessionId, executionId),
      reportPath: path.join(workDir, sessionId, executionId, 'verification.json'),
      report: { status: 'success' },
    });

    vi.mocked(uploadVerificationBundleToS3).mockResolvedValue({
      s3BundleUrl: 'https://example.com/bundle.zip',
      s3BundleKey: bundleKey,
      s3ReportKey: `sessions/${sessionId}/${executionId}/verification.json`,
      s3UploadedAt: '2025-12-31T00:00:00Z',
      s3BundleExpiresAt: '2026-01-01T00:00:00Z',
    });

    const response = await handler({
      mode: 's3_bundle',
      sessionId,
      executionId,
      bundleKey,
      expectedImageId: '0x' + '1'.repeat(64),
      options: {
        uploadToS3: true,
        workDir,
      },
    });

    expect(downloadFromS3).toHaveBeenCalledWith(bundleKey);
    expect(invokeVerifierService).toHaveBeenCalledWith(
      expect.objectContaining({
        bundlePath: path.join(workDir, sessionId, executionId),
        reportPath: path.join(workDir, sessionId, executionId, 'verification.json'),
      }),
    );
    expect(uploadVerificationBundleToS3).toHaveBeenCalledWith(
      path.join(workDir, sessionId, executionId),
      sessionId,
      executionId,
    );
    expect(response).toEqual(
      expect.objectContaining({
        status: 'success',
        sessionId,
        executionId,
        verifierStatus: 'success',
        s3: expect.objectContaining({
          reportKey: `sessions/${sessionId}/${executionId}/verification.json`,
        }),
      }),
    );
  });

  it('rejects legacy direct mode payloads', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';

    const response = await handler({
      mode: 'direct',
      sessionId,
      contractGeneration: '2026-04-zkvm-current-v3',
      expectedImageId: '0x' + '1'.repeat(64),
      zkvmInput: {
        electionId: '550e8400-e29b-41d4-a716-446655440001',
        bulletinRoot: '0x' + '2'.repeat(64),
        treeSize: 1,
        logId: '0x' + '3'.repeat(64),
        timestamp: 1730000000000,
        totalExpected: 1,
        electionConfigHash: '0x' + '4'.repeat(64),
        votes: [],
      },
      electionConfig: {
        totalExpected: 1,
        choices: ['A'],
        version: 'test-v1',
        botCount: 0,
        merkleTreeDepth: 1,
      },
      zkvmResult: {
        electionId: '550e8400-e29b-41d4-a716-446655440001',
      },
      options: {
        uploadToS3: false,
        workDir: path.join(process.cwd(), '.test-verifier-runner'),
      },
    });

    expect(response).toEqual(
      expect.objectContaining({
        status: 'error',
        message: 'Invalid verifier invocation payload',
      }),
    );
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
  });

  it('uses the provided expectedImageId when verifying bundles', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-456';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const workDir = path.join(process.cwd(), '.test-verifier-runner');
    const fallbackImageId = '0x' + '1'.repeat(64);
    const receiptImageId = '0x' + '2'.repeat(64);
    const zipBuffer = await buildZipBuffer({
      'input.json': JSON.stringify({ input: true }),
      'receipt.json': JSON.stringify({ image_id: receiptImageId, receipt: true }),
      'journal.json': JSON.stringify({ journal: true }),
    });

    vi.mocked(downloadFromS3).mockResolvedValue(zipBuffer);

    vi.mocked(invokeVerifierService).mockResolvedValue({
      status: 'success',
      bundlePath: path.join(workDir, sessionId, executionId),
      reportPath: path.join(workDir, sessionId, executionId, 'verification.json'),
      report: { status: 'success' },
    });

    vi.mocked(uploadVerificationBundleToS3).mockResolvedValue({
      s3BundleUrl: 'https://example.com/bundle.zip',
      s3BundleKey: bundleKey,
      s3UploadedAt: '2025-12-31T00:00:00Z',
      s3BundleExpiresAt: '2026-01-01T00:00:00Z',
    });

    await handler({
      mode: 's3_bundle',
      sessionId,
      executionId,
      bundleKey,
      expectedImageId: fallbackImageId,
      options: {
        uploadToS3: true,
        workDir,
      },
    });

    expect(invokeVerifierService).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedImageId: fallbackImageId,
      }),
    );
  });

  it('rejects payloads that do not match the bundle-backed contract', async () => {
    const response = await handler({
      mode: 's3_bundle',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      bundleKey: 'sessions/bad/bundle.zip',
      expectedImageId: '0x' + '1'.repeat(64),
    });

    expect(response).toEqual(
      expect.objectContaining({
        status: 'error',
        message: 'Invalid verifier invocation payload',
      }),
    );
    expect(downloadFromS3).not.toHaveBeenCalled();
  });
});

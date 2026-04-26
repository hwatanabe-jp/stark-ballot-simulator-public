import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as yazl from 'yazl';
import type { RestoredReceipt } from '../bundle-restore';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { computeIncludedBitmapRoot } from '@/lib/zkvm/bitmap';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';

vi.mock('../s3-download', () => ({
  downloadFromS3: vi.fn(),
}));

describe('restoreReceiptFromS3', () => {
  let restoreReceiptFromS3: (key: string) => Promise<RestoredReceipt>;
  let mockDownload: ReturnType<typeof vi.fn>;

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

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockDownload = vi.mocked((await import('../s3-download')).downloadFromS3);
    ({ restoreReceiptFromS3 } = await import('../bundle-restore'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores receipt and journal from a valid bundle.zip', async () => {
    const receiptPayload = {
      receipt: {
        seal: 'base64seal',
        journal: { bytes: [1, 2, 3] },
        imageId: '0xabc',
      },
      metadata: { foo: 'bar' },
    };
    const journalPayload = {
      verifiedTally: [30, 20, 10, 3, 1],
      treeSize: 1,
      seenBitmapRoot: computeIncludedBitmapRoot([true]),
      includedBitmapRoot: computeIncludedBitmapRoot([true]),
    };
    const publicInputPayload = {
      schema: 'stark-ballot.public_input',
      version: '1.1',
      contractGeneration: '2026-04-zkvm-current-v2',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '1'.repeat(64),
      bulletinRoot: '0x' + '2'.repeat(64),
      treeSize: 1,
      totalExpected: 1,
      logId: '0x' + '3'.repeat(64),
      timestamp: 123,
      methodVersion: 10,
      votes: [
        {
          index: 0,
          commitment: '0x' + '4'.repeat(64),
          merklePath: [],
        },
      ],
    };
    const electionManifestPayload = buildElectionManifest(
      '550e8400-e29b-41d4-a716-446655440000',
      buildDefaultElectionConfig(),
    );
    const closeStatementPayload = buildCloseStatement({
      logId: '0x' + '3'.repeat(64),
      treeSize: 1,
      timestamp: 123,
      bulletinRoot: '0x' + '2'.repeat(64),
    });
    const includedBitmapPayload = {
      schema: 'stark-ballot.included_bitmap',
      version: '1.0',
      treeSize: 1,
      includedBitmapRoot: computeIncludedBitmapRoot([true]),
      includedBitmap: [true],
    };
    const seenBitmapPayload = {
      schema: 'stark-ballot.seen_bitmap',
      version: '1.0',
      treeSize: 1,
      seenBitmapRoot: computeIncludedBitmapRoot([true]),
      seenBitmap: [true],
    };
    const zipBuffer = await buildZipBuffer({
      'receipt.json': JSON.stringify(receiptPayload),
      'journal.json': JSON.stringify(journalPayload),
      'public-input.json': JSON.stringify(publicInputPayload),
      'election-manifest.json': JSON.stringify(electionManifestPayload),
      'close-statement.json': JSON.stringify(closeStatementPayload),
    });

    mockDownload
      .mockResolvedValueOnce(zipBuffer)
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(includedBitmapPayload), 'utf8'))
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(seenBitmapPayload), 'utf8'));

    const result = await restoreReceiptFromS3('sessions/test/bundle.zip');

    expect(mockDownload).toHaveBeenNthCalledWith(1, 'sessions/test/bundle.zip');
    expect(mockDownload).toHaveBeenNthCalledWith(2, 'sessions/test/included-bitmap.json');
    expect(mockDownload).toHaveBeenNthCalledWith(3, 'sessions/test/seen-bitmap.json');
    expect(result.receipt).toEqual(receiptPayload.receipt);
    expect(result.receiptRaw).toEqual(receiptPayload);
    expect(result.journal).toEqual(journalPayload);
    expect(result.publicInputArtifact).toEqual(
      createTestPublicInputArtifact({
        contractGeneration: publicInputPayload.contractGeneration,
        source: 'bundle',
        executionId: 'test',
        bundleKey: 'sessions/test/bundle.zip',
        typedAuthority: {
          electionId: publicInputPayload.electionId,
          electionConfigHash: publicInputPayload.electionConfigHash,
          bulletinRoot: publicInputPayload.bulletinRoot,
          treeSize: publicInputPayload.treeSize,
          totalExpected: publicInputPayload.totalExpected,
          votesCount: 1,
          logId: publicInputPayload.logId,
          timestamp: publicInputPayload.timestamp,
          methodVersion: publicInputPayload.methodVersion,
          recomputedInputCommitment: expect.any(String) as unknown as string,
        },
      }),
    );
    expect(result.publicInput).toEqual(publicInputPayload);
    expect(result.electionManifest).toEqual(electionManifestPayload);
    expect(result.closeStatement).toEqual(closeStatementPayload);
    expect(result.includedBitmapArtifact).toEqual(includedBitmapPayload);
    expect(result.seenBitmapArtifact).toEqual(seenBitmapPayload);
  });

  it('ignores included bitmap artifact when it does not match journal root', async () => {
    const receiptPayload = { receipt: { seal: 'base64seal' } };
    const journalPayload = {
      verifiedTally: [1, 0, 0, 0, 0],
      treeSize: 1,
      includedBitmapRoot: computeIncludedBitmapRoot([true]),
    };
    const mismatchedBitmapPayload = {
      schema: 'stark-ballot.included_bitmap',
      version: '1.0',
      treeSize: 1,
      includedBitmapRoot: computeIncludedBitmapRoot([false]),
      includedBitmap: [false],
    };
    const zipBuffer = await buildZipBuffer({
      'receipt.json': JSON.stringify(receiptPayload),
      'journal.json': JSON.stringify(journalPayload),
    });

    mockDownload
      .mockResolvedValueOnce(zipBuffer)
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(mismatchedBitmapPayload), 'utf8'));

    const result = await restoreReceiptFromS3('sessions/mismatched-bitmap/bundle.zip');

    expect(result.includedBitmapArtifact).toBeUndefined();
  });

  it('gracefully handles missing journal.json', async () => {
    const receiptPayload = { foo: 'bar' };
    const zipBuffer = await buildZipBuffer({
      'receipt.json': JSON.stringify(receiptPayload),
    });

    mockDownload.mockResolvedValueOnce(zipBuffer);

    const result = await restoreReceiptFromS3('sessions/no-journal/bundle.zip');

    expect(result.receipt).toEqual(receiptPayload);
    expect(result.receiptRaw).toEqual(receiptPayload);
    expect(result.journal).toBeUndefined();
    expect(result.publicInputArtifact).toBeUndefined();
    expect(result.electionManifest).toBeUndefined();
    expect(result.closeStatement).toBeUndefined();
  });

  it('logs warning when journal.json is invalid JSON but still returns receipt', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const receiptPayload = { receipt: { nested: true } };
    const zipBuffer = await buildZipBuffer({
      'receipt.json': JSON.stringify(receiptPayload),
      'journal.json': '{invalid-json',
    });

    mockDownload.mockResolvedValueOnce(zipBuffer);

    const result = await restoreReceiptFromS3('sessions/invalid-journal/bundle.zip');

    expect(warnSpy).toHaveBeenCalled();
    expect(result.receipt).toEqual(receiptPayload.receipt);
    expect(result.receiptRaw).toEqual(receiptPayload);
    expect(result.journal).toBeUndefined();
    expect(result.publicInputArtifact).toBeUndefined();
    expect(result.electionManifest).toBeUndefined();
    expect(result.closeStatement).toBeUndefined();
  });

  it('keeps raw public-input.json but leaves authority undefined when the readable payload is unsupported', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const receiptPayload = { receipt: { nested: true } };
    const unsupportedPublicInputPayload = {
      schema: 'stark-ballot.public_input',
      version: '1.1',
      contractGeneration: '',
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '1'.repeat(64),
      bulletinRoot: '0x' + '2'.repeat(64),
      treeSize: 1,
      totalExpected: 1,
      logId: '0x' + '3'.repeat(64),
      timestamp: 123,
      methodVersion: 10,
      votes: [
        {
          index: 0,
          commitment: '0x' + '4'.repeat(64),
          merklePath: [],
        },
      ],
    };
    const zipBuffer = await buildZipBuffer({
      'receipt.json': JSON.stringify(receiptPayload),
      'public-input.json': JSON.stringify(unsupportedPublicInputPayload),
    });

    mockDownload.mockResolvedValueOnce(zipBuffer).mockRejectedValue(new Error('missing sibling artifact'));

    const result = await restoreReceiptFromS3('sessions/unsupported-public-input/bundle.zip');

    expect(warnSpy).toHaveBeenCalled();
    expect(result.receipt).toEqual(receiptPayload.receipt);
    expect(result.receiptRaw).toEqual(receiptPayload);
    expect(result.publicInput).toEqual(unsupportedPublicInputPayload);
    expect(result.publicInputArtifact).toBeUndefined();
  });

  it('throws when receipt.json entry is missing', async () => {
    const zipBuffer = await buildZipBuffer({
      'metadata.json': '{}',
    });
    mockDownload.mockResolvedValueOnce(zipBuffer);

    await expect(restoreReceiptFromS3('sessions/missing-receipt/bundle.zip')).rejects.toThrow(
      'Receipt restoration failed: receipt.json not found in bundle',
    );
  });

  it('propagates download errors', async () => {
    mockDownload.mockRejectedValueOnce(new Error('S3 unavailable'));

    await expect(restoreReceiptFromS3('sessions/error/bundle.zip')).rejects.toThrow(
      'Receipt restoration failed: S3 unavailable',
    );
  });
});

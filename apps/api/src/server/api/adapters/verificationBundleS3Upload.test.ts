import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { extractZipFromFile } from '@stark-ballot/node-adapters/zip';
import { logger } from '@stark-ballot/diagnostics/logger';
import { uploadVerificationBundleToS3 } from './verificationBundleS3Upload';

vi.mock('@stark-ballot/aws-adapters/aws/s3-upload', () => ({
  uploadFileToS3: vi.fn(({ filePath }: { filePath: string }) =>
    Promise.resolve({
      bucket: 'test-bucket',
      key: `uploads/${path.basename(filePath)}`,
      uploadedAt: '2025-01-01T00:00:00.000Z',
      success: true,
    }),
  ),
}));

describe('uploadVerificationBundleToS3', () => {
  let testWorkDir: string;
  let loggerWarnSpy: MockInstance<typeof logger.warn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    vi.mocked(uploadFileToS3).mockImplementation(({ filePath }: { filePath: string }) =>
      Promise.resolve({
        bucket: 'test-bucket',
        key: `uploads/${path.basename(filePath)}`,
        uploadedAt: '2025-01-01T00:00:00.000Z',
        success: true,
      }),
    );

    const parentDir = path.join(process.cwd(), '.tmp');
    await fs.mkdir(parentDir, { recursive: true });
    testWorkDir = await fs.mkdtemp(path.join(parentDir, 'verification-bundle-upload-'));
  });

  afterEach(async () => {
    loggerWarnSpy.mockRestore();
    delete process.env['USE_S3'];
    delete process.env['TARGET_AWS_RUNTIME'];
    await fs.rm(testWorkDir, { recursive: true, force: true });
  });

  async function writeUploadBundleWithPrivateSidecars(bundleDir: string): Promise<void> {
    await fs.mkdir(bundleDir, { recursive: true });
    for (const [fileName, content] of Object.entries({
      'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
      'election-manifest.json': { electionId: 'election-1' },
      'close-statement.json': { treeSize: 1 },
      'receipt.json': { receipt: true },
      'journal.json': { journal: true },
      'verification.json': { status: 'success' },
      'input.json': { private: true },
      'included-bitmap.json': { private: true },
      'seen-bitmap.json': { private: true },
    })) {
      await fs.writeFile(path.join(bundleDir, fileName), JSON.stringify(content), 'utf-8');
    }
  }

  it('uploads bundle archive and report when S3 is enabled', async () => {
    const sessionId = 'session-upload';
    const executionId = 'exec-upload';
    process.env['USE_S3'] = 'true';

    const bundleDir = path.join(testWorkDir, sessionId, executionId);
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, 'public-input.json'),
      JSON.stringify({ schema: 'stark-ballot.public_input', version: '1.0', votes: [] }),
      'utf-8',
    );
    await fs.writeFile(path.join(bundleDir, 'election-manifest.json'), JSON.stringify({}), 'utf-8');
    await fs.writeFile(path.join(bundleDir, 'close-statement.json'), JSON.stringify({}), 'utf-8');
    await fs.writeFile(path.join(bundleDir, 'receipt.json'), JSON.stringify({ receipt: {} }), 'utf-8');
    await fs.writeFile(path.join(bundleDir, 'journal.json'), JSON.stringify({}), 'utf-8');
    await fs.writeFile(path.join(bundleDir, 'metadata.json'), JSON.stringify({}), 'utf-8');
    await fs.writeFile(path.join(bundleDir, 'verification.json'), JSON.stringify({ status: 'success' }));

    const result = await uploadVerificationBundleToS3(bundleDir, sessionId, executionId);

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    const mockedUpload = vi.mocked(uploadFileToS3);
    expect(mockedUpload).toHaveBeenCalledTimes(2);

    const uploadedFiles = mockedUpload.mock.calls.map((call) => path.basename(call[0].filePath)).sort();
    expect(uploadedFiles).toEqual(['bundle.zip', 'verification.json']);

    expect(result.s3BundleKey).toBe('uploads/bundle.zip');
    expect(result.s3ReportKey).toBe('uploads/verification.json');
    expect(result.s3UploadedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result).not.toHaveProperty('s3BundleUrl');
    expect(result).not.toHaveProperty('s3BundleExpiresAt');
    expect(loggerWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('bitmap'), expect.anything());
  });

  it('fails closed when target runtime has S3 upload disabled', async () => {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    delete process.env['USE_S3'];

    await expect(uploadVerificationBundleToS3(testWorkDir, 'session-upload', 'exec-upload')).rejects.toThrow(
      'USE_S3=true is required for target AWS runtime bundle persistence',
    );
  });

  it('fails closed when target runtime report upload fails', async () => {
    const sessionId = 'session-upload';
    const executionId = 'exec-upload';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';

    const bundleDir = path.join(testWorkDir, sessionId, executionId);
    await fs.mkdir(bundleDir, { recursive: true });
    for (const fileName of [
      'public-input.json',
      'election-manifest.json',
      'close-statement.json',
      'receipt.json',
      'journal.json',
      'metadata.json',
      'verification.json',
    ]) {
      await fs.writeFile(path.join(bundleDir, fileName), JSON.stringify({}), 'utf-8');
    }

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    vi.mocked(uploadFileToS3)
      .mockResolvedValueOnce({
        bucket: 'test-bucket',
        key: 'uploads/bundle.zip',
        uploadedAt: '2025-01-01T00:00:00.000Z',
        success: true,
      })
      .mockResolvedValueOnce({
        bucket: 'test-bucket',
        key: 'uploads/verification.json',
        uploadedAt: '2025-01-01T00:00:00.000Z',
        success: false,
        error: 'denied',
      });

    await expect(uploadVerificationBundleToS3(bundleDir, sessionId, executionId)).rejects.toThrow(
      'Target AWS runtime verification report upload failed: denied',
    );
  });

  it.each([
    ['included-bitmap.json', 'Target AWS runtime included bitmap upload failed: denied'],
    ['seen-bitmap.json', 'Target AWS runtime seen bitmap upload failed: denied'],
  ])('fails closed when target runtime %s upload fails', async (failedFileName, expectedMessage) => {
    const sessionId = 'session-upload';
    const executionId = `exec-${failedFileName}`;
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';

    const bundleDir = path.join(testWorkDir, sessionId, executionId);
    await writeUploadBundleWithPrivateSidecars(bundleDir);

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    vi.mocked(uploadFileToS3).mockImplementation(({ filePath }: { filePath: string }) =>
      Promise.resolve({
        bucket: 'test-bucket',
        key: `uploads/${path.basename(filePath)}`,
        uploadedAt: '2025-01-01T00:00:00.000Z',
        success: path.basename(filePath) !== failedFileName,
        ...(path.basename(filePath) === failedFileName ? { error: 'denied' } : {}),
      }),
    );

    await expect(uploadVerificationBundleToS3(bundleDir, sessionId, executionId)).rejects.toThrow(expectedMessage);
  });

  it('fails closed when target runtime cannot access an optional private sidecar unexpectedly', async () => {
    const sessionId = 'session-upload';
    const executionId = 'exec-sidecar-access';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';

    const bundleDir = path.join(testWorkDir, sessionId, executionId);
    await writeUploadBundleWithPrivateSidecars(bundleDir);
    const realAccess = fs.access.bind(fs);
    const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async (filePath) => {
      if (path.basename(String(filePath)) === 'included-bitmap.json') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return await realAccess(filePath);
    });

    try {
      await expect(uploadVerificationBundleToS3(bundleDir, sessionId, executionId)).rejects.toThrow(
        'permission denied',
      );
      expect(loggerWarnSpy).toHaveBeenCalledWith('[Bundle] Included bitmap access failed:', 'permission denied');
    } finally {
      accessSpy.mockRestore();
    }
  });

  it('fails closed when target runtime private bitmap sidecar upload throws', async () => {
    const sessionId = 'session-upload';
    const executionId = 'exec-sidecar-throw';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';

    const bundleDir = path.join(testWorkDir, sessionId, executionId);
    await writeUploadBundleWithPrivateSidecars(bundleDir);

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    vi.mocked(uploadFileToS3).mockImplementation(({ filePath }: { filePath: string }) => {
      if (path.basename(filePath) === 'included-bitmap.json') {
        throw new Error('network unavailable');
      }
      return Promise.resolve({
        bucket: 'test-bucket',
        key: `uploads/${path.basename(filePath)}`,
        uploadedAt: '2025-01-01T00:00:00.000Z',
        success: true,
      });
    });

    await expect(uploadVerificationBundleToS3(bundleDir, sessionId, executionId)).rejects.toThrow(
      'network unavailable',
    );
  });

  it('uploads a Docker-shaped async public bundle without requiring metadata.json', async () => {
    const sessionId = 'session-upload';
    const executionId = 'exec-async-upload';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';

    const bundleDir = path.join(testWorkDir, sessionId, executionId);
    await writeUploadBundleWithPrivateSidecars(bundleDir);

    const result = await uploadVerificationBundleToS3(bundleDir, sessionId, executionId);

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    const mockedUpload = vi.mocked(uploadFileToS3);
    const bundleUpload = mockedUpload.mock.calls.find((call) => path.basename(call[0].filePath) === 'bundle.zip');
    expect(bundleUpload).toBeDefined();
    const uploadedFiles = mockedUpload.mock.calls.map((call) => path.basename(call[0].filePath));
    expect(uploadedFiles).toEqual(
      expect.arrayContaining(['bundle.zip', 'verification.json', 'included-bitmap.json', 'seen-bitmap.json']),
    );

    const extractionDir = path.join(bundleDir, 'extracted-async');
    await extractZipFromFile(path.join(bundleDir, 'bundle.zip'), { destination: extractionDir });
    const extractedFiles = (await fs.readdir(extractionDir)).sort();
    expect(extractedFiles).toEqual(
      ['close-statement.json', 'election-manifest.json', 'journal.json', 'public-input.json', 'receipt.json'].sort(),
    );
    expect(extractedFiles).not.toContain('metadata.json');
    expect(extractedFiles).not.toContain('input.json');
    expect(extractedFiles).not.toContain('included-bitmap.json');
    expect(extractedFiles).not.toContain('seen-bitmap.json');
    expect(extractedFiles).not.toContain('verification.json');
    expect(result.s3BundleKey).toBe('uploads/bundle.zip');
    expect(result.s3ReportKey).toBe('uploads/verification.json');
    expect(result.s3UploadedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result).not.toHaveProperty('s3BundleUrl');
    expect(result).not.toHaveProperty('s3BundleExpiresAt');
  });
});

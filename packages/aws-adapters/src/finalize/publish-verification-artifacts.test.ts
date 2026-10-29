import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '@stark-ballot/diagnostics/logger';
import { publishVerificationBundleArtifacts } from './publish-verification-artifacts';
import { resolvePublicBundlePolicy } from '@stark-ballot/verification/public-bundle-manifest';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';

const targetProfile = targetRuntimeProfile();

vi.mock('@stark-ballot/aws-adapters/aws/s3-upload', () => ({
  uploadFileToS3: vi.fn(({ filePath }: { filePath: string }) =>
    Promise.resolve({
      bucket: 'test-bucket',
      key: `uploads/${path.basename(filePath)}`,
      uploadedAtMs: 1735689600000,
      success: true,
    }),
  ),
}));

describe.each(['sync', 'async'] as const)('publishVerificationBundleArtifacts (%s)', (mode) => {
  const uploadVerificationBundleToS3 = (
    profile: ResolvedRuntimeProfile,
    bundlePath: string,
    sessionId: string,
    finalizationId: string,
  ) =>
    publishVerificationBundleArtifacts({
      profile,
      bundlePath,
      sessionId,
      finalizationId,
      upload: true,
      policy: resolvePublicBundlePolicy(mode),
    });
  let testWorkDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    vi.mocked(uploadFileToS3).mockImplementation(({ filePath }: { filePath: string }) =>
      Promise.resolve({
        bucket: 'test-bucket',
        key: `uploads/${path.basename(filePath)}`,
        uploadedAtMs: 1735689600000,
        success: true,
      }),
    );

    const parentDir = path.join(process.cwd(), '.tmp');
    await fs.mkdir(parentDir, { recursive: true });
    testWorkDir = await fs.mkdtemp(path.join(parentDir, 'verification-bundle-upload-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testWorkDir, { recursive: true, force: true });
  });

  function captureExpectedWarnings(): MockInstance<typeof logger.warn> {
    return vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  }

  function captureExpectedErrors(): MockInstance<typeof logger.error> {
    return vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  }

  async function writeUploadBundleWithPrivateSidecars(bundleDir: string): Promise<void> {
    await fs.mkdir(bundleDir, { recursive: true });
    for (const [fileName, content] of Object.entries({
      'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
      'election-manifest.json': { electionId: 'election-1' },
      'close-statement.json': { treeSize: 1 },
      'receipt.json': { receipt: true },
      'journal.json': { journal: true },
      'metadata.json': { sessionId: 'session-upload' },
      'verification.json': { status: 'success' },
      'input.json': { private: true },
      'included-bitmap.json': { private: true },
      'seen-bitmap.json': { private: true },
    })) {
      await fs.writeFile(path.join(bundleDir, fileName), JSON.stringify(content), 'utf-8');
    }
  }

  it('uploads bundle archive and report when S3 is enabled', async () => {
    const loggerWarnSpy = captureExpectedWarnings();
    const sessionId = 'session-upload';
    const finalizationId = 'exec-upload';
    const bundleDir = path.join(testWorkDir, sessionId, finalizationId);
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

    const result = await uploadVerificationBundleToS3(targetProfile, bundleDir, sessionId, finalizationId);

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    const mockedUpload = vi.mocked(uploadFileToS3);
    expect(mockedUpload).toHaveBeenCalledTimes(2);

    const uploadedFiles = mockedUpload.mock.calls.map((call) => path.basename(call[0].filePath)).sort();
    expect(uploadedFiles).toEqual(['bundle.zip', 'verification.json']);

    expect(result.s3BundleKey).toBe('uploads/bundle.zip');
    expect(result.s3ReportKey).toBe('uploads/verification.json');
    expect(result.s3UploadedAtMs).toBe(1735689600000);
    expect(result).not.toHaveProperty('s3BundleUrl');
    expect(result).not.toHaveProperty('s3BundleExpiresAt');
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it('does not construct an S3 upload for a local artifact profile', async () => {
    await writeUploadBundleWithPrivateSidecars(testWorkDir);
    const result = await uploadVerificationBundleToS3(
      localRuntimeProfile(),
      testWorkDir,
      'session-upload',
      'exec-upload',
    );

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    expect(uploadFileToS3).not.toHaveBeenCalled();
    expect(result.s3BundleKey).toBeUndefined();
  });

  it('fails closed when target runtime report upload fails', async () => {
    const loggerWarnSpy = captureExpectedWarnings();
    const loggerErrorSpy = captureExpectedErrors();
    const sessionId = 'session-upload';
    const finalizationId = 'exec-upload';
    const bundleDir = path.join(testWorkDir, sessionId, finalizationId);
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
        uploadedAtMs: 1735689600000,
        success: true,
      })
      .mockResolvedValueOnce({
        bucket: 'test-bucket',
        key: 'uploads/verification.json',
        uploadedAtMs: 1735689600000,
        success: false,
        error: 'denied',
      });

    await expect(uploadVerificationBundleToS3(targetProfile, bundleDir, sessionId, finalizationId)).rejects.toThrow(
      'Target AWS runtime verification report upload failed: denied',
    );
    expect(loggerWarnSpy.mock.calls).toEqual([
      ['[Bundle] Verification report upload failed: denied'],
      ['[Bundle] Verification report upload skipped:', 'Target AWS runtime verification report upload failed: denied'],
    ]);
    expect(loggerErrorSpy).toHaveBeenCalledExactlyOnceWith(
      '[Bundle] S3 upload error:',
      'Target AWS runtime verification report upload unavailable: Target AWS runtime verification report upload failed: denied',
    );
  });

  it.each([
    ['included-bitmap.json', 'Target AWS runtime included bitmap upload failed: denied'],
    ['seen-bitmap.json', 'Target AWS runtime seen bitmap upload failed: denied'],
  ])('fails closed when target runtime %s upload fails', async (failedFileName, expectedMessage) => {
    const loggerWarnSpy = captureExpectedWarnings();
    const loggerErrorSpy = captureExpectedErrors();
    const sessionId = 'session-upload';
    const finalizationId = `exec-${failedFileName}`;
    const bundleDir = path.join(testWorkDir, sessionId, finalizationId);
    await writeUploadBundleWithPrivateSidecars(bundleDir);

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    vi.mocked(uploadFileToS3).mockImplementation(({ filePath }: { filePath: string }) =>
      Promise.resolve({
        bucket: 'test-bucket',
        key: `uploads/${path.basename(filePath)}`,
        uploadedAtMs: 1735689600000,
        success: path.basename(filePath) !== failedFileName,
        ...(path.basename(filePath) === failedFileName ? { error: 'denied' } : {}),
      }),
    );

    await expect(uploadVerificationBundleToS3(targetProfile, bundleDir, sessionId, finalizationId)).rejects.toThrow(
      expectedMessage,
    );
    const label = failedFileName === 'included-bitmap.json' ? 'Included bitmap' : 'Seen bitmap';
    expect(loggerWarnSpy.mock.calls).toEqual([
      [`[Bundle] ${label} upload failed: denied`],
      [`[Bundle] ${label} upload failed:`, expectedMessage],
    ]);
    expect(loggerErrorSpy).toHaveBeenCalledExactlyOnceWith('[Bundle] S3 upload error:', expectedMessage);
  });

  it('fails closed when target runtime cannot access an optional private sidecar unexpectedly', async () => {
    const loggerWarnSpy = captureExpectedWarnings();
    const loggerErrorSpy = captureExpectedErrors();
    const sessionId = 'session-upload';
    const finalizationId = 'exec-sidecar-access';
    const bundleDir = path.join(testWorkDir, sessionId, finalizationId);
    await writeUploadBundleWithPrivateSidecars(bundleDir);
    const realAccess = fs.access.bind(fs);
    const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async (filePath) => {
      if (path.basename(String(filePath)) === 'included-bitmap.json') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return await realAccess(filePath);
    });

    try {
      await expect(uploadVerificationBundleToS3(targetProfile, bundleDir, sessionId, finalizationId)).rejects.toThrow(
        'permission denied',
      );
      expect(loggerWarnSpy).toHaveBeenCalledExactlyOnceWith(
        '[Bundle] Included bitmap access failed:',
        'permission denied',
      );
      expect(loggerErrorSpy).toHaveBeenCalledExactlyOnceWith('[Bundle] S3 upload error:', 'permission denied');
    } finally {
      accessSpy.mockRestore();
    }
  });

  it('fails closed when target runtime private bitmap sidecar upload throws', async () => {
    const loggerWarnSpy = captureExpectedWarnings();
    const loggerErrorSpy = captureExpectedErrors();
    const sessionId = 'session-upload';
    const finalizationId = 'exec-sidecar-throw';
    const bundleDir = path.join(testWorkDir, sessionId, finalizationId);
    await writeUploadBundleWithPrivateSidecars(bundleDir);

    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    vi.mocked(uploadFileToS3).mockImplementation(({ filePath }: { filePath: string }) => {
      if (path.basename(filePath) === 'included-bitmap.json') {
        throw new Error('network unavailable');
      }
      return Promise.resolve({
        bucket: 'test-bucket',
        key: `uploads/${path.basename(filePath)}`,
        uploadedAtMs: 1735689600000,
        success: true,
      });
    });

    await expect(uploadVerificationBundleToS3(targetProfile, bundleDir, sessionId, finalizationId)).rejects.toThrow(
      'network unavailable',
    );
    expect(loggerWarnSpy).toHaveBeenCalledExactlyOnceWith(
      '[Bundle] Included bitmap upload failed:',
      'network unavailable',
    );
    expect(loggerErrorSpy).toHaveBeenCalledExactlyOnceWith('[Bundle] S3 upload error:', 'network unavailable');
  });

  it('enforces the selected policy for missing metadata before publication', async () => {
    const sessionId = 'session-upload';
    const finalizationId = 'exec-missing-metadata';
    const bundleDir = path.join(testWorkDir, sessionId, finalizationId);
    await writeUploadBundleWithPrivateSidecars(bundleDir);
    await fs.rm(path.join(bundleDir, 'metadata.json'));

    const publication = uploadVerificationBundleToS3(targetProfile, bundleDir, sessionId, finalizationId);
    const { uploadFileToS3 } = await import('@stark-ballot/aws-adapters/aws/s3-upload');
    if (mode === 'sync') {
      await expect(publication).rejects.toThrow(/missing required public bundle member.*metadata\.json/i);
      expect(uploadFileToS3).not.toHaveBeenCalled();
    } else {
      await expect(publication).resolves.toMatchObject({ s3BundleKey: 'uploads/bundle.zip' });
      expect(uploadFileToS3).toHaveBeenCalled();
    }
  });
});

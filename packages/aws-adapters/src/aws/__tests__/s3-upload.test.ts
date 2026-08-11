import { describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';

const targetProfile = targetRuntimeProfile();

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

vi.mock('../s3-client', () => ({
  getS3Config: vi.fn(),
  getS3Client: vi.fn(),
}));

describe('uploadFileToS3', () => {
  let uploadFileToS3: typeof import('../s3-upload').uploadFileToS3;
  let isS3UploadEnabled: typeof import('../s3-upload').isS3UploadEnabled;
  let getS3Config: Mock;
  let getS3Client: Mock;
  let sendMock: Mock;
  let readFileSpy: Mock;
  let consoleLogSpy: MockInstance<typeof console.log>;
  let consoleWarnSpy: MockInstance<typeof console.warn>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const s3ClientModule = await import('../s3-client');
    getS3Config = vi.mocked(s3ClientModule.getS3Config);
    getS3Client = vi.mocked(s3ClientModule.getS3Client);
    sendMock = vi.fn();
    getS3Config.mockReturnValue({
      region: 'ap-northeast-1',
      bucket: 'test-bucket',
      prefix: 'sessions/',
      expectedBucketOwner: '123456789012',
    });
    getS3Client.mockReturnValue({
      send: sendMock,
    });

    readFileSpy = vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('mock-zip'));

    ({ uploadFileToS3, isS3UploadEnabled } = await import('../s3-upload'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('uploads bundle successfully with metadata', async () => {
    sendMock.mockResolvedValueOnce({});

    const result = await uploadFileToS3({
      profile: targetProfile,
      sessionId: 'session-123',
      finalizationId: 'exec-456',
      filePath: '/tmp/bundle.zip',
      contentType: 'application/zip',
    });

    expect(readFileSpy).toHaveBeenCalledWith('/tmp/bundle.zip');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = strictDefined(sendMock.mock.calls[0])[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe('test-bucket');
    expect(command.input.Key).toBe('sessions/session-123/exec-456/bundle.zip');
    expect(command.input.ExpectedBucketOwner).toBe('123456789012');
    expect(command.input.Metadata).toMatchObject({
      sessionId: 'session-123',
      finalizationId: 'exec-456',
    });
    expect(result.success).toBe(true);
    expect(result.bucket).toBe('test-bucket');
    expect(result.key).toBe('sessions/session-123/exec-456/bundle.zip');
    expect(result.uploadedAtMs).toEqual(expect.any(Number));
  });

  it.each([
    ['sessionId', 'session/123', 'exec-456'],
    ['finalizationId with slash', 'session-123', 'bad/segment-123'],
    ['finalizationId with dot', 'session-123', 'bad.segment-123'],
    ['finalizationId as URL', 'session-123', 'https://example.invalid/execution'],
  ])('rejects unsafe %s before reading or uploading', async (_label, sessionId, finalizationId) => {
    await expect(
      uploadFileToS3({
        profile: targetProfile,
        sessionId,
        finalizationId,
        filePath: '/tmp/bundle.zip',
        contentType: 'application/zip',
      }),
    ).rejects.toThrow(/safe single path segment/);

    expect(readFileSpy).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('retries up to max attempts and returns failure metadata', async () => {
    vi.useFakeTimers();

    sendMock.mockRejectedValue(new Error('network error'));
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const promise = uploadFileToS3({
      profile: targetProfile,
      sessionId: 'session-123',
      finalizationId: 'exec-456',
      filePath: '/tmp/bundle.zip',
      contentType: 'application/zip',
      maxRetries: 3,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 1000);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 2000);
    expect(result.success).toBe(false);
    expect(result.error).toBe('network error');
  });

  it('does not enable S3 for a local runtime profile', () => {
    expect(isS3UploadEnabled(localRuntimeProfile())).toBe(false);
    expect(getS3Config).not.toHaveBeenCalled();
  });

  it('enables S3 only when the target runtime profile config validates', () => {
    expect(isS3UploadEnabled(targetProfile)).toBe(true);
    expect(getS3Config).toHaveBeenCalledTimes(1);
  });

  it('does not enable S3 when target profile config validation fails', () => {
    getS3Config.mockImplementationOnce(() => {
      throw new Error('S3_PROOF_BUCKET is required for target AWS runtime');
    });

    expect(isS3UploadEnabled(targetProfile)).toBe(false);
  });
});

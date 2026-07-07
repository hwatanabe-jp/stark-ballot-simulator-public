import { describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import { PutObjectCommand } from '@aws-sdk/client-s3';

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
      sessionId: 'session-123',
      executionId: 'exec-456',
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
      executionId: 'exec-456',
    });
    expect(result.success).toBe(true);
    expect(result.bucket).toBe('test-bucket');
    expect(result.key).toBe('sessions/session-123/exec-456/bundle.zip');
    expect(result.uploadedAt).toEqual(expect.any(String));
  });

  it.each([
    ['sessionId', 'session/123', 'exec-456'],
    ['executionId with slash', 'session-123', 'bad/segment-123'],
    ['executionId with dot', 'session-123', 'bad.segment-123'],
    ['executionId as URL', 'session-123', 'https://example.invalid/execution'],
  ])('rejects unsafe %s before reading or uploading', async (_label, sessionId, executionId) => {
    await expect(
      uploadFileToS3({
        sessionId,
        executionId,
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
      sessionId: 'session-123',
      executionId: 'exec-456',
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

  it.each([
    ['legacy Amplify Lambda name', 'amplify-starkballotsimulator-dev-honoapi-lambda'],
    ['arbitrary Lambda name', 'custom-prod-worker'],
    ['target-like Lambda name', 'stark-ballot-simulator-stark-dev-develop-public-api'],
  ])('does not enable S3 from %s without target runtime config', (_label, functionName) => {
    process.env['USE_S3'] = 'true';
    delete process.env['TARGET_AWS_RUNTIME'];
    process.env['AWS_LAMBDA_FUNCTION_NAME'] = functionName;

    expect(isS3UploadEnabled()).toBe(false);
    expect(getS3Config).not.toHaveBeenCalled();
  });

  it('enables S3 only when target runtime config validates', () => {
    process.env['USE_S3'] = 'true';
    process.env['TARGET_AWS_RUNTIME'] = '1';

    expect(isS3UploadEnabled()).toBe(true);
    expect(getS3Config).toHaveBeenCalledTimes(1);
  });

  it('does not enable S3 when target runtime config validation fails', () => {
    process.env['USE_S3'] = 'true';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    getS3Config.mockImplementationOnce(() => {
      throw new Error('S3_PROOF_BUCKET is required for target AWS runtime');
    });

    expect(isS3UploadEnabled()).toBe(false);
  });
});

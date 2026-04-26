import { describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockInstance } from 'vitest';
import { promises as fs } from 'fs';
import { PutObjectCommand } from '@aws-sdk/client-s3';

vi.mock('../s3-client', () => ({
  getS3Config: vi.fn(),
  getS3Client: vi.fn(),
}));

describe('uploadFileToS3', () => {
  let uploadFileToS3: typeof import('../s3-upload').uploadFileToS3;
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
    });
    getS3Client.mockReturnValue({
      send: sendMock,
    });

    readFileSpy = vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('mock-zip'));

    ({ uploadFileToS3 } = await import('../s3-upload'));
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
    const command = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe('test-bucket');
    expect(command.input.Key).toBe('sessions/session-123/exec-456/bundle.zip');
    expect(command.input.Metadata).toMatchObject({
      sessionId: 'session-123',
      executionId: 'exec-456',
    });
    expect(result.success).toBe(true);
    expect(result.bucket).toBe('test-bucket');
    expect(result.key).toBe('sessions/session-123/exec-456/bundle.zip');
    expect(result.uploadedAt).toEqual(expect.any(String));
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
});

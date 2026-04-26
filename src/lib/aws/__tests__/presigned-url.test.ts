import { describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockInstance } from 'vitest';
import { getNumberProperty, getRecordProperty, isRecord } from '@/lib/utils/guards';

vi.mock('../s3-client', () => ({
  getS3Config: vi.fn(),
  getS3Client: vi.fn().mockReturnValue({}),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}));

describe('presigned-url helpers', () => {
  let generatePresignedUrl: typeof import('../presigned-url').generatePresignedUrl;
  let generateBundlePresignedUrl: typeof import('../presigned-url').generateBundlePresignedUrl;
  let generateBundlePresignedUrlForKey: typeof import('../presigned-url').generateBundlePresignedUrlForKey;
  let getSignedUrl: Mock;
  let getS3Config: Mock;
  let consoleLogSpy: MockInstance<typeof console.log>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-10-19T05:00:00Z'));
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    ({ generatePresignedUrl, generateBundlePresignedUrl, generateBundlePresignedUrlForKey } =
      await import('../presigned-url'));
    const presignerModule = await import('@aws-sdk/s3-request-presigner');
    getSignedUrl = vi.mocked(presignerModule.getSignedUrl);
    const s3ClientModule = await import('../s3-client');
    getS3Config = vi.mocked(s3ClientModule.getS3Config);

    getS3Config.mockReturnValue({
      bucket: 'example-proof-bundles-develop',
      prefix: 'sessions/',
      region: 'ap-northeast-1',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    delete process.env.S3_SIGNED_URL_TTL_SECONDS;
    delete process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS;
  });

  it('generates presigned URL with default TTL and derived expiresAt', async () => {
    getSignedUrl.mockResolvedValueOnce('https://example.com/presigned');

    const result = await generatePresignedUrl({ key: 'sessions/session-1/bundle.zip' });

    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const optionsPayload: unknown = getSignedUrl.mock.calls[0]?.[2];
    const options = isRecord(optionsPayload) ? optionsPayload : {};
    expect(getNumberProperty(options, 'expiresIn')).toBe(3600);
    expect(result).toEqual({
      url: 'https://example.com/presigned',
      expiresAt: '2025-10-19T06:00:00.000Z',
      expiresIn: 3600,
      success: true,
    });
  });

  it('respects S3_SIGNED_URL_TTL_SECONDS override', async () => {
    process.env.S3_SIGNED_URL_TTL_SECONDS = '120';
    getSignedUrl.mockResolvedValueOnce('https://example.com/short');

    const result = await generatePresignedUrl({ key: 'sessions/session-1/bundle.zip' });

    const optionsPayload: unknown = getSignedUrl.mock.calls[0]?.[2];
    const options = isRecord(optionsPayload) ? optionsPayload : {};
    expect(getNumberProperty(options, 'expiresIn')).toBe(120);
    expect(result.expiresIn).toBe(120);
    expect(result.expiresAt).toBe('2025-10-19T05:02:00.000Z');
  });

  it('propagates errors from getSignedUrl', async () => {
    getSignedUrl.mockRejectedValueOnce(new Error('signing failed'));

    const result = await generatePresignedUrl({ key: 'sessions/session-1/bundle.zip' });

    expect(result.success).toBe(false);
    expect(result.url).toBe('');
    expect(result.error).toBe('signing failed');
  });

  it('builds bundle key using configured prefix', async () => {
    getSignedUrl.mockResolvedValueOnce('https://example.com/presigned');

    await generateBundlePresignedUrl('session-abc', 'exec-123', 'bundle.zip');

    const commandPayload: unknown = getSignedUrl.mock.calls[0]?.[1];
    const command = isRecord(commandPayload) ? commandPayload : {};
    const input = getRecordProperty(command, 'input');
    expect(input).toMatchObject({
      Bucket: 'example-proof-bundles-develop',
      Key: 'sessions/session-abc/exec-123/bundle.zip',
    });
    const optionsPayload: unknown = getSignedUrl.mock.calls[0]?.[2];
    const options = isRecord(optionsPayload) ? optionsPayload : {};
    expect(getNumberProperty(options, 'expiresIn')).toBe(300);
  });

  it('caps bundle presigned URL TTL to 900 seconds', async () => {
    process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS = '5000';
    getSignedUrl.mockResolvedValueOnce('https://example.com/presigned');

    await generateBundlePresignedUrl('session-abc', 'exec-123');

    const optionsPayload: unknown = getSignedUrl.mock.calls[0]?.[2];
    const options = isRecord(optionsPayload) ? optionsPayload : {};
    expect(getNumberProperty(options, 'expiresIn')).toBe(900);
  });

  it('uses bundle-specific TTL override when valid', async () => {
    process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS = '120';
    getSignedUrl.mockResolvedValueOnce('https://example.com/presigned');

    await generateBundlePresignedUrl('session-abc', 'exec-123');

    const optionsPayload: unknown = getSignedUrl.mock.calls[0]?.[2];
    const options = isRecord(optionsPayload) ? optionsPayload : {};
    expect(getNumberProperty(options, 'expiresIn')).toBe(120);
  });

  it('presigns an authoritative bundle key without rebuilding the prefix or layout', async () => {
    process.env.S3_BUNDLE_SIGNED_URL_TTL_SECONDS = '180';
    getSignedUrl.mockResolvedValueOnce('https://example.com/exact-key');

    await generateBundlePresignedUrlForKey('custom/prefix/session-abc/exec-123/bundle.zip');

    const commandPayload: unknown = getSignedUrl.mock.calls[0]?.[1];
    const command = isRecord(commandPayload) ? commandPayload : {};
    const input = getRecordProperty(command, 'input');
    expect(input).toMatchObject({
      Bucket: 'example-proof-bundles-develop',
      Key: 'custom/prefix/session-abc/exec-123/bundle.zip',
    });
    const optionsPayload: unknown = getSignedUrl.mock.calls[0]?.[2];
    const options = isRecord(optionsPayload) ? optionsPayload : {};
    expect(getNumberProperty(options, 'expiresIn')).toBe(180);
  });
});

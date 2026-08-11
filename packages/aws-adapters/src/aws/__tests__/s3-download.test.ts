import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { targetRuntimeProfile } from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';

const targetProfile = targetRuntimeProfile();

vi.mock('../s3-client', () => ({
  getS3Config: vi.fn(() => ({
    region: 'ap-northeast-1',
    bucket: 'proof-bucket',
    prefix: 'sessions/',
    expectedBucketOwner: '123456789012',
  })),
  getS3Client: vi.fn(),
}));

describe('S3 downloads', () => {
  const send = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const { getS3Client } = await import('../s3-client');
    vi.mocked(getS3Client).mockReturnValue({ send } as never);
  });

  it('sets ExpectedBucketOwner on full object downloads', async () => {
    send.mockResolvedValueOnce({
      Body: (async function* stream() {
        await Promise.resolve();
        yield Uint8Array.from(Buffer.from('bundle'));
      })(),
      ContentLength: 6,
      ETag: '"etag-1"',
      VersionId: 'version-1',
    });
    const { downloadS3Object } = await import('../s3-download');

    await expect(
      downloadS3Object(targetProfile, 'sessions/session-1/exec-1/bundle.zip', {
        etag: '"etag-1"',
        versionId: 'version-1',
      }),
    ).resolves.toEqual({
      body: Buffer.from('bundle'),
      contentLength: 6,
      etag: '"etag-1"',
      versionId: 'version-1',
    });

    const command = send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input.ExpectedBucketOwner).toBe('123456789012');
    expect(command.input.IfMatch).toBe('"etag-1"');
    expect(command.input.VersionId).toBe('version-1');
  });

  it('sets ExpectedBucketOwner on metadata reads and range downloads', async () => {
    send
      .mockResolvedValueOnce({
        ContentLength: 123,
        ETag: '"etag-1"',
        VersionId: 'version-1',
      })
      .mockResolvedValueOnce({
        Body: (async function* stream() {
          await Promise.resolve();
          yield Uint8Array.from(Buffer.from('part'));
        })(),
        ContentLength: 4,
        ContentRange: 'bytes 0-3/123',
        ETag: '"etag-1"',
        VersionId: 'version-1',
      });
    const { headS3Object, downloadRangeFromS3 } = await import('../s3-download');

    await expect(headS3Object(targetProfile, 'sessions/session-1/exec-1/bundle.zip')).resolves.toEqual({
      contentLength: 123,
      etag: '"etag-1"',
      versionId: 'version-1',
    });
    await expect(
      downloadRangeFromS3(
        targetProfile,
        'sessions/session-1/exec-1/bundle.zip',
        { start: 0, end: 3 },
        { etag: '"etag-1"', versionId: 'version-1' },
      ),
    ).resolves.toEqual({
      body: Buffer.from('part'),
      contentLength: 4,
      contentRange: 'bytes 0-3/123',
      etag: '"etag-1"',
      versionId: 'version-1',
    });

    const headCommand = send.mock.calls[0]?.[0] as HeadObjectCommand;
    const rangeCommand = send.mock.calls[1]?.[0] as GetObjectCommand;
    expect(headCommand).toBeInstanceOf(HeadObjectCommand);
    expect(headCommand.input.ExpectedBucketOwner).toBe('123456789012');
    expect(rangeCommand).toBeInstanceOf(GetObjectCommand);
    expect(rangeCommand.input.Range).toBe('bytes=0-3');
    expect(rangeCommand.input.ExpectedBucketOwner).toBe('123456789012');
    expect(rangeCommand.input.IfMatch).toBe('"etag-1"');
    expect(rangeCommand.input.VersionId).toBe('version-1');
  });
});

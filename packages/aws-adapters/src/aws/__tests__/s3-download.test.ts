import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

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
    });
    const { downloadFromS3 } = await import('../s3-download');

    await expect(downloadFromS3('sessions/session-1/exec-1/bundle.zip')).resolves.toEqual(Buffer.from('bundle'));

    const command = send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input.ExpectedBucketOwner).toBe('123456789012');
  });

  it('sets ExpectedBucketOwner on metadata reads and range downloads', async () => {
    send.mockResolvedValueOnce({ ContentLength: 123 }).mockResolvedValueOnce({
      Body: (async function* stream() {
        await Promise.resolve();
        yield Uint8Array.from(Buffer.from('part'));
      })(),
      ContentLength: 4,
      ContentRange: 'bytes 0-3/123',
    });
    const { headS3Object, downloadRangeFromS3 } = await import('../s3-download');

    await expect(headS3Object('sessions/session-1/exec-1/bundle.zip')).resolves.toEqual({ contentLength: 123 });
    await expect(downloadRangeFromS3('sessions/session-1/exec-1/bundle.zip', { start: 0, end: 3 })).resolves.toEqual({
      body: Buffer.from('part'),
      contentLength: 4,
      contentRange: 'bytes 0-3/123',
    });

    const headCommand = send.mock.calls[0]?.[0] as HeadObjectCommand;
    const rangeCommand = send.mock.calls[1]?.[0] as GetObjectCommand;
    expect(headCommand).toBeInstanceOf(HeadObjectCommand);
    expect(headCommand.input.ExpectedBucketOwner).toBe('123456789012');
    expect(rangeCommand).toBeInstanceOf(GetObjectCommand);
    expect(rangeCommand.input.Range).toBe('bytes=0-3');
    expect(rangeCommand.input.ExpectedBucketOwner).toBe('123456789012');
  });
});

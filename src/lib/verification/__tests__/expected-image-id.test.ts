import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CURRENT_METHOD_VERSION, LEGACY_METHOD_VERSION } from '@/lib/zkvm/types';

vi.mock('../image-id-verifier', async () => {
  const actual = await vi.importActual<typeof import('../image-id-verifier')>('../image-id-verifier');
  return {
    ...actual,
    getExpectedImageId: vi.fn().mockResolvedValue('0ximageid-from-mapping'),
  };
});

describe('resolveExpectedImageId', () => {
  let consoleWarnSpy: MockInstance<typeof console.warn>;
  let consoleErrorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    const keys = ['EXPECTED_IMAGE_ID', 'EXPECTED_IMAGEID_POC', 'EXPECTED_IMAGE_ID_VARIANT'];
    for (const key of keys) {
      if (process.env[key] !== undefined) {
        delete process.env[key];
      }
    }
    vi.clearAllMocks();
    vi.resetModules();

    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('prefers EXPECTED_IMAGE_ID when set', async () => {
    process.env.EXPECTED_IMAGE_ID = '0xenv-image-id';

    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    await expect(resolveExpectedImageId()).resolves.toBe('0xenv-image-id');
    expect(verifier.getExpectedImageId).not.toHaveBeenCalled();
  });

  it('ignores legacy EXPECTED_IMAGEID_POC and loads mapping instead', async () => {
    process.env.EXPECTED_IMAGEID_POC = '0xlegacy-image-id';

    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    const result = await resolveExpectedImageId();
    expect(result).toBe('0ximageid-from-mapping');
    expect(verifier.getExpectedImageId).toHaveBeenCalledTimes(1);
  });

  it('uses mapping when env vars are missing', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    const result = await resolveExpectedImageId();
    expect(result).toBe('0ximageid-from-mapping');
    expect(verifier.getExpectedImageId).toHaveBeenCalledWith(undefined, 'default');
  });

  it('uses the requested methodVersion when provided', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    const result = await resolveExpectedImageId(CURRENT_METHOD_VERSION);
    expect(result).toBe('0ximageid-from-mapping');
    expect(verifier.getExpectedImageId).toHaveBeenCalledWith(CURRENT_METHOD_VERSION, 'default');
  });

  it('uses the configured variant when EXPECTED_IMAGE_ID_VARIANT is set', async () => {
    process.env.EXPECTED_IMAGE_ID_VARIANT = 'x86_64';

    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    await expect(resolveExpectedImageId()).resolves.toBe('0ximageid-from-mapping');
    expect(verifier.getExpectedImageId).toHaveBeenCalledWith(undefined, 'x86_64');
  });

  it('prefers an explicit variant option over the environment', async () => {
    process.env.EXPECTED_IMAGE_ID_VARIANT = 'default';

    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    await expect(resolveExpectedImageId(undefined, { variant: 'x86_64' })).resolves.toBe('0ximageid-from-mapping');
    expect(verifier.getExpectedImageId).toHaveBeenCalledWith(undefined, 'x86_64');
  });

  it('rethrows unavailable variant errors without using a fallback', async () => {
    const verifier = await import('../image-id-verifier');
    const error = new verifier.ImageIdResolutionError('variant_unavailable', 'variant unavailable');
    vi.mocked(verifier.getExpectedImageId).mockRejectedValueOnce(error);

    const { resolveExpectedImageId } = await import('../expected-image-id');

    await expect(resolveExpectedImageId()).rejects.toThrow('variant unavailable');
  });

  it('rejects unsupported non-current method versions', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');

    await expect(resolveExpectedImageId(LEGACY_METHOD_VERSION)).rejects.toThrow(
      `Unsupported method version: ${LEGACY_METHOD_VERSION}`,
    );
  });

  it('rethrows mapping failures for an explicit current methodVersion', async () => {
    const error = new Error('mapping failed');
    const verifier = await import('../image-id-verifier');
    vi.mocked(verifier.getExpectedImageId).mockRejectedValueOnce(error);

    const { resolveExpectedImageId } = await import('../expected-image-id');

    await expect(resolveExpectedImageId(CURRENT_METHOD_VERSION)).rejects.toThrow('mapping failed');
  });

  it('rejects unsupported ImageID variants from the environment', async () => {
    process.env.EXPECTED_IMAGE_ID_VARIANT = 'auto';

    const { resolveExpectedImageId } = await import('../expected-image-id');

    await expect(resolveExpectedImageId()).rejects.toThrow('Unsupported ImageID variant: auto');
  });
});

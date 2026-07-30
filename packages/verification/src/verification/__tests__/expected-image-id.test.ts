import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CURRENT_METHOD_VERSION, LEGACY_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

vi.mock('../image-id-verifier', async () => {
  const actual = await vi.importActual<typeof import('../image-id-verifier')>('../image-id-verifier');
  return {
    ...actual,
    getExpectedImageId: vi.fn().mockReturnValue('0ximageid-from-mapping'),
  };
});

describe('resolveExpectedImageId', () => {
  let consoleWarnSpy: MockInstance<typeof console.warn>;
  let consoleErrorSpy: MockInstance<typeof console.error>;
  const mapping = {
    mappingType: 'image-id-mapping' as const,
    current: String(CURRENT_METHOD_VERSION),
    deprecated: [],
    mappings: {
      [String(CURRENT_METHOD_VERSION)]: {
        methodVersion: CURRENT_METHOD_VERSION,
        variants: {
          default: {
            state: 'confirmed' as const,
            imageId: '0ximageid-from-mapping',
            provenance: {
              evidenceType: 'accepted-prover-release' as const,
              sourceSha: 'a'.repeat(40),
              proverImageDigest: `sha256:${'b'.repeat(64)}`,
              candidateMetadataSha256: 'c'.repeat(64),
              releaseRecordSha256: 'd'.repeat(64),
              toolchainArtifactRecordSha256: 'e'.repeat(64),
            },
          },
          x86_64: {
            state: 'unconfirmed' as const,
            requiredEvidence: 'accepted-prover-release' as const,
          },
        },
        description: 'test mapping',
        features: [],
      },
    },
    metadata: {
      lastUpdated: '2026-07-26T00:00:00Z',
      purpose: 'test',
      notes: 'test',
    },
  };
  const loadImageIdMapping = vi.fn().mockResolvedValue(mapping);

  beforeEach(() => {
    const keys = ['EXPECTED_IMAGE_ID', 'EXPECTED_IMAGEID_POC', 'EXPECTED_IMAGE_ID_VARIANT'];
    for (const key of keys) {
      if (process.env[key] !== undefined) {
        delete process.env[key];
      }
    }
    vi.clearAllMocks();
    loadImageIdMapping.mockResolvedValue(mapping);
    vi.resetModules();

    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('prefers an explicit expected ImageID when provided', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    await expect(resolveExpectedImageId(undefined, { explicitImageId: '0xenv-image-id' })).resolves.toBe(
      '0xenv-image-id',
    );
    expect(verifier.getExpectedImageId).not.toHaveBeenCalled();
  });

  it('ignores legacy EXPECTED_IMAGEID_POC input and loads mapping instead', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    const result = await resolveExpectedImageId(undefined, {
      legacyExpectedImageIdPoc: '0xlegacy-image-id',
      loadImageIdMapping,
    });
    expect(result).toBe('0ximageid-from-mapping');
    expect(verifier.getExpectedImageId).toHaveBeenCalledTimes(1);
  });

  it('uses mapping when env vars are missing', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    const result = await resolveExpectedImageId(undefined, { loadImageIdMapping });
    expect(result).toBe('0ximageid-from-mapping');
    expect(verifier.getExpectedImageId).toHaveBeenCalledWith(mapping, undefined, 'default');
  });

  it('uses the requested methodVersion when provided', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    const result = await resolveExpectedImageId(CURRENT_METHOD_VERSION, { loadImageIdMapping });
    expect(result).toBe('0ximageid-from-mapping');
    expect(verifier.getExpectedImageId).toHaveBeenCalledWith(mapping, CURRENT_METHOD_VERSION, 'default');
  });

  it('uses the configured variant when provided', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    await expect(resolveExpectedImageId(undefined, { variant: 'x86_64', loadImageIdMapping })).resolves.toBe(
      '0ximageid-from-mapping',
    );
    expect(verifier.getExpectedImageId).toHaveBeenCalledWith(mapping, undefined, 'x86_64');
  });

  it('uses an explicit variant option', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');
    const verifier = await import('../image-id-verifier');

    await expect(resolveExpectedImageId(undefined, { variant: 'x86_64', loadImageIdMapping })).resolves.toBe(
      '0ximageid-from-mapping',
    );
    expect(verifier.getExpectedImageId).toHaveBeenCalledWith(mapping, undefined, 'x86_64');
  });

  it('rethrows unavailable variant errors without using a fallback', async () => {
    const verifier = await import('../image-id-verifier');
    const error = new verifier.ImageIdResolutionError('variant_unavailable', 'variant unavailable');
    vi.mocked(verifier.getExpectedImageId).mockRejectedValueOnce(error);

    const { resolveExpectedImageId } = await import('../expected-image-id');

    await expect(resolveExpectedImageId(undefined, { loadImageIdMapping })).rejects.toThrow('variant unavailable');
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

    await expect(resolveExpectedImageId(CURRENT_METHOD_VERSION, { loadImageIdMapping })).rejects.toThrow(
      'mapping failed',
    );
  });

  it('rejects unsupported ImageID variants from runtime input', async () => {
    const { resolveExpectedImageId } = await import('../expected-image-id');

    await expect(resolveExpectedImageId(undefined, { variant: 'auto' })).rejects.toThrow(
      'Unsupported ImageID variant: auto',
    );
  });
});

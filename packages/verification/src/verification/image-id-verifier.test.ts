/**
 * ImageID Verifier Tests
 *
 * Tests for ImageID trust-material resolution.
 * Cryptographic receipt verification is covered by verifier-service.
 */

import { describe, it, expect } from 'vitest';
import type { ImageIdMapping } from '@stark-ballot/validation/image-id-mapping';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

describe('ImageID Verifier', () => {
  const provenance = {
    evidenceType: 'accepted-prover-release' as const,
    sourceSha: 'a'.repeat(40),
    proverImageDigest: `sha256:${'b'.repeat(64)}`,
    candidateMetadataSha256: 'c'.repeat(64),
    releaseRecordSha256: 'd'.repeat(64),
    toolchainArtifactRecordSha256: 'e'.repeat(64),
  };
  const mapping: ImageIdMapping = {
    mappingType: 'image-id-mapping',
    current: String(CURRENT_METHOD_VERSION),
    deprecated: ['8'],
    mappings: {
      [String(CURRENT_METHOD_VERSION)]: {
        methodVersion: CURRENT_METHOD_VERSION,
        variants: {
          default: {
            state: 'confirmed',
            imageId: '0x417778745b43c82a20db33a55c2b1d6e0805e0fa7eec80c9654e7321121e97af',
            provenance,
          },
          x86_64: {
            state: 'confirmed',
            imageId: '0x08aa256ee9120045bbdbe2152723ff657cf1cd7329cba46715954d183caa84de',
            provenance,
          },
        },
        description: 'test current method',
        features: [],
      },
      '8': {
        methodVersion: 8,
        variants: {
          default: {
            state: 'confirmed',
            imageId: '0x1111111111111111111111111111111111111111111111111111111111111111',
            provenance,
          },
          x86_64: {
            state: 'unconfirmed',
            requiredEvidence: 'accepted-prover-release',
          },
        },
        description: 'test legacy method',
        features: [],
      },
    },
    metadata: {
      lastUpdated: '2026-07-26T00:00:00Z',
      purpose: 'test',
      notes: 'test',
    },
  };

  describe('Expected ImageID Retrieval', () => {
    it('should get expected ImageID for current version', async () => {
      const { getExpectedImageId } = await import('./image-id-verifier');

      const imageId = getExpectedImageId(mapping);

      expect(imageId).toBeDefined();
      expect(imageId).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('resolves the default variant unless an explicit variant is requested', async () => {
      const { getExpectedImageId } = await import('./image-id-verifier');
      const current = strictDefined(mapping.mappings[mapping.current]);
      const defaultVariant = current.variants.default;
      if (defaultVariant.state !== 'confirmed') {
        throw new Error('default ImageID is not confirmed for current mapping');
      }

      const imageId = getExpectedImageId(mapping);
      expect(imageId).toBe(defaultVariant.imageId);
    });

    it('resolves the x86_64 variant only when explicitly requested', async () => {
      const { getExpectedImageId } = await import('./image-id-verifier');
      const current = strictDefined(mapping.mappings[mapping.current]);
      const x86Variant = current.variants.x86_64;
      if (x86Variant.state !== 'confirmed') {
        throw new Error('x86_64 ImageID is not confirmed for current mapping');
      }

      const imageId = getExpectedImageId(mapping, undefined, 'x86_64');
      expect(imageId).toBe(x86Variant.imageId);
    });

    it('fails closed with an explicit reason when the requested variant is unconfirmed', async () => {
      const { getExpectedImageId } = await import('./image-id-verifier');
      const current = strictDefined(mapping.mappings[mapping.current]);
      const mappingWithUnconfirmedVariant: ImageIdMapping = {
        ...mapping,
        mappings: {
          [mapping.current]: {
            ...current,
            variants: {
              ...current.variants,
              x86_64: {
                state: 'unconfirmed',
                requiredEvidence: 'accepted-prover-release',
              },
            },
          },
        },
      };

      expect(() => getExpectedImageId(mappingWithUnconfirmedVariant, undefined, 'x86_64')).toThrow(
        expect.objectContaining({
          reason: 'variant_unconfirmed',
        }),
      );
    });

    it('should get expected ImageID for specific version', async () => {
      const { getExpectedImageId } = await import('./image-id-verifier');

      const imageId = getExpectedImageId(mapping, 8);

      expect(imageId).toBeDefined();
      expect(imageId).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('should throw for unknown version', async () => {
      const { getExpectedImageId } = await import('./image-id-verifier');

      expect(() => getExpectedImageId(mapping, 999)).toThrow('Unknown method version: 999');
    });
  });
});

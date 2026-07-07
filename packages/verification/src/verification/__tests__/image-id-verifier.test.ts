/**
 * ImageID Verifier Tests
 *
 * Tests for ImageID trust-material resolution and mapping consistency.
 * Cryptographic receipt verification is covered by verifier-service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ImageIdMapping } from '../image-id-types';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

describe('ImageID Verifier', () => {
  const mapping: ImageIdMapping = {
    current: String(CURRENT_METHOD_VERSION),
    deprecated: ['8'],
    mappings: {
      [String(CURRENT_METHOD_VERSION)]: {
        methodVersion: CURRENT_METHOD_VERSION,
        expectedImageID: '0x417778745b43c82a20db33a55c2b1d6e0805e0fa7eec80c9654e7321121e97af',
        expectedImageID_x86_64: '0x08aa256ee9120045bbdbe2152723ff657cf1cd7329cba46715954d183caa84de',
        description: 'test current method',
        compiledAt: 'test',
        rustVersion: 'test',
        risc0Version: 'test',
        features: [],
      },
      '8': {
        methodVersion: 8,
        expectedImageID: '0x1111111111111111111111111111111111111111111111111111111111111111',
        description: 'test legacy method',
        compiledAt: 'test',
        rustVersion: 'test',
        risc0Version: 'test',
        features: [],
      },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const verifierModule = await import('../image-id-verifier');
    verifierModule.resetImageIdVerifierState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Expected ImageID Retrieval', () => {
    it('should get expected ImageID for current version', async () => {
      const { getExpectedImageId } = await import('../image-id-verifier');

      const imageId = getExpectedImageId(mapping);

      expect(imageId).toBeDefined();
      expect(imageId).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('resolves the default variant unless an explicit variant is requested', async () => {
      const { getExpectedImageId } = await import('../image-id-verifier');
      const current = strictDefined(mapping.mappings[mapping.current]);

      if (!current.expectedImageID) {
        throw new Error('expectedImageID is not configured for current mapping');
      }

      const imageId = getExpectedImageId(mapping);
      expect(imageId).toBe(current.expectedImageID);
    });

    it('resolves the x86_64 variant only when explicitly requested', async () => {
      const { getExpectedImageId } = await import('../image-id-verifier');
      const current = strictDefined(mapping.mappings[mapping.current]);

      if (!current.expectedImageID_x86_64) {
        throw new Error('expectedImageID_x86_64 is not configured for current mapping');
      }

      const imageId = getExpectedImageId(mapping, undefined, 'x86_64');
      expect(imageId).toBe(current.expectedImageID_x86_64);
    });

    it('fails closed when the requested variant is unavailable', async () => {
      const { getExpectedImageId } = await import('../image-id-verifier');
      const { expectedImageID_x86_64, ...currentWithoutVariant } = strictDefined(mapping.mappings[mapping.current]);
      void expectedImageID_x86_64;
      const mappingWithoutVariant: ImageIdMapping = {
        ...mapping,
        mappings: {
          [mapping.current]: currentWithoutVariant,
        },
      };

      expect(() => getExpectedImageId(mappingWithoutVariant, undefined, 'x86_64')).toThrow(
        'Expected ImageID variant x86_64 is not available',
      );
    });

    it('fails closed when the requested variant is not active for the current method version', async () => {
      const { getExpectedImageId } = await import('../image-id-verifier');
      const current = strictDefined(mapping.mappings[mapping.current]);
      const x86OnlyMapping: ImageIdMapping = {
        ...mapping,
        mappings: {
          [mapping.current]: {
            ...current,
            supportedVariants: ['x86_64'],
          },
        },
      };

      expect(() => getExpectedImageId(x86OnlyMapping, CURRENT_METHOD_VERSION, 'default')).toThrow(
        'Expected ImageID variant default is not active',
      );
      expect(getExpectedImageId(x86OnlyMapping, CURRENT_METHOD_VERSION, 'x86_64')).toBe(current.expectedImageID_x86_64);
    });

    it('should get expected ImageID for specific version', async () => {
      const { getExpectedImageId } = await import('../image-id-verifier');

      const imageId = getExpectedImageId(mapping, 8);

      expect(imageId).toBeDefined();
      expect(imageId).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('should throw for unknown version', async () => {
      const { getExpectedImageId } = await import('../image-id-verifier');

      expect(() => getExpectedImageId(mapping, 999)).toThrow('Unknown method version: 999');
    });
  });

  describe('Multi-Source Verification', () => {
    it('should verify ImageID from multiple sources', async () => {
      const { verifyFromMultipleSources } = await import('../image-id-verifier');
      const sources: Array<{ id: string; load: () => ImageIdMapping | Promise<ImageIdMapping> }> = [
        { id: 'local', load: () => mapping },
        { id: 'cdn', load: () => mapping },
      ];

      const result = await verifyFromMultipleSources(sources);

      expect(result.verified).toBe(true);
      expect(result.sourcesChecked).toBeGreaterThanOrEqual(2);
      expect(result.consensus).toBe(true);
    });

    it('should detect discrepancies between sources', async () => {
      const { verifyFromMultipleSources } = await import('../image-id-verifier');

      const sources: Array<{ id: string; load: () => ImageIdMapping | Promise<ImageIdMapping> }> = [
        {
          id: 'source1',
          load: (): ImageIdMapping => ({
            ...mapping,
            mappings: {
              ...mapping.mappings,
              [mapping.current]: {
                ...strictDefined(mapping.mappings[mapping.current]),
                expectedImageID: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            },
          }),
        },
        {
          id: 'source2',
          load: (): ImageIdMapping => ({
            ...mapping,
            mappings: {
              ...mapping.mappings,
              [mapping.current]: {
                ...strictDefined(mapping.mappings[mapping.current]),
                expectedImageID: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            },
          }),
        },
      ];
      const result = await verifyFromMultipleSources(sources);

      expect(result.verified).toBe(false);
      expect(result.consensus).toBe(false);
      expect(result.error).toContain('Discrepancy detected');
    });
  });
});

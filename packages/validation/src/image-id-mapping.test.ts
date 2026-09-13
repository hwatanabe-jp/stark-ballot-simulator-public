import { describe, expect, it } from 'vitest';

import {
  ImageIdVariantResolutionError,
  parseImageIdMapping,
  resolveConfirmedImageIdVariant,
} from './image-id-mapping.js';
import { resolveConfiguredImageIdVariant } from './image-id-policy.js';

const X86_IMAGE_ID = `0x${'a'.repeat(64)}`;

function mappingFixture(): unknown {
  return {
    mappingType: 'image-id-mapping',
    mappings: {
      '14': {
        methodVersion: 14,
        variants: {
          default: {
            state: 'unconfirmed',
            requiredEvidence: 'accepted-prover-release',
          },
          x86_64: {
            state: 'confirmed',
            imageId: X86_IMAGE_ID,
            provenance: {
              evidenceType: 'local-guest-build',
              compiledAt: '2026-07-22T12:44:54Z',
              buildProfile: 'release+production',
              hostRustVersion: '1.97.1',
              hostRustCommit: '8bab26f4f68e0e26f0bb7960be334d5b520ea452',
              risc0Version: '3.0.6',
              risc0Commit: '1cc70cf05033a79ebc90f07c679cb4bd1cd301b9',
              guestToolchain: 'r0.1.97.0',
              guestToolchainCommit: 'e638c6cfea1eff5fbbb24a27e60538e3760d21b8',
              guestElfSha256: 'e0397a7d2b115b9fe5f7cfe850382dcfd4b6a49eb9c17a5d7baec30b0f421795',
              guestProgramBinarySha256: '22d929bfa5d4c6e8ebdb43f77d50b26ae82337f5e2333d99372372ebce548f34',
              hostBinarySha256: 'f0c722ecde71bce75452dde4b5135dfeeaa1a70f2d9c33d6f02ccde0822d6843',
              zkvmCargoLockSha256: 'c23441a52e950ce0cb7adfa48ae9920adc7490ce521fbba42d271e75bec52f10',
            },
          },
        },
        description: 'current method',
        features: ['ImageID binding'],
      },
    },
    current: '14',
    deprecated: [],
    metadata: {
      lastUpdated: '2026-07-26T00:00:00Z',
      purpose: 'ImageID trust material',
      notes: 'default awaits accepted Prover evidence',
    },
  };
}

describe('ImageID mapping semantic contract', () => {
  it('parses one unconfirmed and one confirmed variant without duplicate availability fields', () => {
    const mapping = parseImageIdMapping(mappingFixture());

    expect(mapping.mappingType).toBe('image-id-mapping');
    expect(mapping.mappings['14']?.variants.default).toEqual({
      state: 'unconfirmed',
      requiredEvidence: 'accepted-prover-release',
    });
    expect(resolveConfirmedImageIdVariant(mapping, 14, 'x86_64').imageId).toBe(X86_IMAGE_ID);
  });

  it('reports an explicit fail-closed reason for an unconfirmed variant', () => {
    const mapping = parseImageIdMapping(mappingFixture());

    expect(() => resolveConfirmedImageIdVariant(mapping, 14, 'default')).toThrow(ImageIdVariantResolutionError);
    try {
      resolveConfirmedImageIdVariant(mapping, 14, 'default');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'variant_unconfirmed' });
    }
  });

  it('rejects the predecessor flat mapping shape instead of adapting it', () => {
    const predecessor = mappingFixture() as Record<string, unknown>;
    const mappings = predecessor['mappings'] as Record<string, Record<string, unknown>>;
    const method = mappings['14'];
    if (!method) {
      throw new Error('test fixture is missing method 14');
    }
    delete method['variants'];
    method['expectedImageID'] = `0x${'b'.repeat(64)}`;
    method['expectedImageID_x86_64'] = X86_IMAGE_ID;
    method['supportedVariants'] = ['default', 'x86_64'];

    expect(() => parseImageIdMapping(predecessor)).toThrow(/semantic contract keys/u);
  });

  it('rejects contradictory unconfirmed variant data', () => {
    const contradictory = mappingFixture() as Record<string, unknown>;
    const mappings = contradictory['mappings'] as Record<string, Record<string, unknown>>;
    const method = mappings['14'];
    if (!method) {
      throw new Error('test fixture is missing method 14');
    }
    const variants = method['variants'] as Record<string, Record<string, unknown>>;
    const defaultVariant = variants['default'];
    if (!defaultVariant) {
      throw new Error('test fixture is missing default variant');
    }
    defaultVariant['imageId'] = `0x${'b'.repeat(64)}`;

    expect(() => parseImageIdMapping(contradictory)).toThrow(/unconfirmed variant.*semantic contract keys/u);
  });
});

describe('ImageID selection policy', () => {
  it('rejects non-string selector values instead of coercing them', () => {
    expect(() =>
      resolveConfiguredImageIdVariant({
        toString: () => 'default',
      }),
    ).toThrow('Unsupported ImageID variant value');
  });
});

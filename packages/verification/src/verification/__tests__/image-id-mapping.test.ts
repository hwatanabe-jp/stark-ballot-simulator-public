import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseImageIdMapping } from '@stark-ballot/validation/image-id-mapping';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

describe('ImageID mapping trust material', () => {
  const mappingPath = path.join(process.cwd(), 'public', 'imageId-mapping.json');

  async function readMapping() {
    return parseImageIdMapping(JSON.parse(await fs.readFile(mappingPath, 'utf8')));
  }

  it('uses the unversioned semantic mapping contract for the current method', async () => {
    const mapping = await readMapping();

    expect(mapping.mappingType).toBe('image-id-mapping');
    expect(mapping.current).toBe(String(CURRENT_METHOD_VERSION));
    expect(Object.keys(mapping.mappings)).toEqual([String(CURRENT_METHOD_VERSION)]);
    expect(mapping.mappings[mapping.current]?.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(mapping.deprecated).toEqual([]);
  });

  it('confirms default from the accepted managed Prover release', async () => {
    const mapping = await readMapping();

    expect(mapping.mappings[mapping.current]?.variants.default).toEqual({
      state: 'confirmed',
      imageId: '0xd8619329804e7f183fc66aed960a69ec1c5aa326ecd51ac6a9f79eae4e35f15c',
      provenance: {
        evidenceType: 'accepted-prover-release',
        sourceSha: '55a527a1c980750b81577f1a53d9e581e573516f',
        proverImageDigest: 'sha256:1894dcc2cdcb61a807617d933d48fae936d172630677267c1054584feb0558a3',
        candidateMetadataSha256: '4ea4cdfb92785df44af01a034347f92ca1f059e182d7fd0e154f2ace470e2a25',
        releaseRecordSha256: '99d1384e3866972e38e25dd5bff4c2ebb75c268935c8f7daa67e81ccb27935df',
        toolchainArtifactRecordSha256: 'c78fecd1ebfd9fec2dacff6b440172cdcc684d9729a291a91486949fe51fd31e',
      },
    });
  });

  it('retains the confirmed x86_64 ImageID and exact local build provenance', async () => {
    const mapping = await readMapping();
    const x86 = mapping.mappings[mapping.current]?.variants.x86_64;

    expect(x86).toMatchObject({
      state: 'confirmed',
      imageId: '0x634850d3fc881e5c534ad32a03a49e1ed2d8f6841707cfdba35660fc883e5002',
      provenance: {
        evidenceType: 'local-guest-build',
        hostRustVersion: '1.97.1',
        risc0Version: '3.0.6',
        guestToolchain: 'r0.1.97.0',
        risc0Commit: '1cc70cf05033a79ebc90f07c679cb4bd1cd301b9',
        guestToolchainCommit: 'e638c6cfea1eff5fbbb24a27e60538e3760d21b8',
        guestElfSha256: '8468f067a0f6f4353d392f332f7a40c46181a0be30076bfb5bb4ec98ccd7a550',
        guestProgramBinarySha256: '2505e8cc9c9a8b83a77bf37712a4300be81a1c498c6827f7f5253519e6e8fc2a',
      },
    });
  });

  it('resolves each confirmed variant only when selected', async () => {
    const mapping = await readMapping();
    const { getExpectedImageId } = await import('../image-id-verifier');

    expect(getExpectedImageId(mapping, CURRENT_METHOD_VERSION, 'default')).toBe(
      '0xd8619329804e7f183fc66aed960a69ec1c5aa326ecd51ac6a9f79eae4e35f15c',
    );
    expect(getExpectedImageId(mapping, CURRENT_METHOD_VERSION, 'x86_64')).toBe(
      '0x634850d3fc881e5c534ad32a03a49e1ed2d8f6841707cfdba35660fc883e5002',
    );
  });

  it('documents the verification features and has a stable body checksum', async () => {
    const content = await fs.readFile(mappingPath, 'utf8');
    const mapping = parseImageIdMapping(JSON.parse(content));
    const features = mapping.mappings[mapping.current]?.features;

    expect(features).toContain('STH digest binding');
    expect(features).toContain('CT leaf usage tags');
    expect(features).toContain('Input commitment sorting');
    expect(crypto.createHash('sha256').update(content).digest('hex')).toMatch(/^[0-9a-f]{64}$/u);
  });
});

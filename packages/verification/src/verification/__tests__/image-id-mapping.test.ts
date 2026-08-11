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

  it('binds the default variant to the accepted managed ARM64 Prover release', async () => {
    const mapping = await readMapping();

    expect(mapping.mappings[mapping.current]?.variants.default).toEqual({
      state: 'confirmed',
      imageId: '0x8dbbe2a82c110e06c77d58fc5f1f07b7d887595315a07a5d91b28275fb42bebc',
      provenance: {
        evidenceType: 'accepted-prover-release',
        sourceSha: '7896f53697ab76678dd8011738f2178d31429e5e',
        proverImageDigest: 'sha256:be1ee6b8a1f8f00741d3230c0026bbb215ef7c471f4e3678cd435bd1c7405703',
        candidateMetadataSha256: 'cbddbad282089aecf5b1e1b3fa0fa9c0c846a6c2444e455bef18185e0199d2fa',
        releaseRecordSha256: 'fd9b81208013a4c228a2a47018ffa6a3b1128b230cb8cdecdf5e633441d41a53',
        toolchainArtifactRecordSha256: 'aa5dcf3ddbd21b128b68c7946916b53e2c8ec8c45c760decdbeef0fcc92cec02',
      },
    });
  });

  it('retains the confirmed x86_64 ImageID and exact local build provenance', async () => {
    const mapping = await readMapping();
    const x86 = mapping.mappings[mapping.current]?.variants.x86_64;

    expect(x86).toMatchObject({
      state: 'confirmed',
      imageId: '0xf5ca2c76e5b0d28e0f35a4a9fdde64a52d858a8f5b14151f8649c5e61f56c12f',
      provenance: {
        evidenceType: 'local-guest-build',
        compiledAt: '2026-08-09T23:45:15Z',
        buildProfile: 'release+production',
        hostRustVersion: '1.97.1',
        hostRustCommit: '8bab26f4f68e0e26f0bb7960be334d5b520ea452',
        risc0Version: '3.0.6',
        guestToolchain: 'r0.1.97.0',
        risc0Commit: '1cc70cf05033a79ebc90f07c679cb4bd1cd301b9',
        guestToolchainCommit: 'e638c6cfea1eff5fbbb24a27e60538e3760d21b8',
        guestElfSha256: '2ad497fba97876c283420d9f94d883bfe2938e9919df1f18345bfa166f3d75f5',
        guestProgramBinarySha256: '36447f9483387363876b704afe238e76b113351725697b1423ae55734670dc2c',
        hostBinarySha256: '06ecb123560a351034e898415c2dd1022e4bcac466c153a59d9dd43cadbb0b29',
        zkvmCargoLockSha256: '68eb8dca78256ea4c4c7e6794de2799a8f37428d5eaa057dd47b210b8aa1346f',
      },
    });
  });

  it('resolves the accepted default and independently confirmed x86_64 variants', async () => {
    const mapping = await readMapping();
    const { getExpectedImageId } = await import('../image-id-verifier');

    expect(getExpectedImageId(mapping, CURRENT_METHOD_VERSION, 'default')).toBe(
      '0x8dbbe2a82c110e06c77d58fc5f1f07b7d887595315a07a5d91b28275fb42bebc',
    );
    expect(getExpectedImageId(mapping, CURRENT_METHOD_VERSION, 'x86_64')).toBe(
      '0xf5ca2c76e5b0d28e0f35a4a9fdde64a52d858a8f5b14151f8649c5e61f56c12f',
    );
  });
});

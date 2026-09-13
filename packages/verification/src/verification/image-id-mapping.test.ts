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

  it('requires an accepted managed ARM64 Prover release before confirming the default variant', async () => {
    const mapping = await readMapping();

    expect(mapping.mappings[mapping.current]?.variants.default).toEqual({
      state: 'confirmed',
      imageId: '0xa869ba5ae3fcd9a54b3f4b81466f4056f31d4d1a2eb93cc432e7dbecc9d290a6',
      provenance: {
        evidenceType: 'accepted-prover-release',
        sourceSha: '1049ab609a4508d8ed732e8218fbbb2223b601ed',
        proverImageDigest: 'sha256:0b42fff47daeec126fbff2acce684d3a6de116599e1ea696737d73f667cde2c1',
        candidateMetadataSha256: '8279cab7f3e056f10cbc98fda16beb7620c12217a0cf715f1a83c280919d71e2',
        releaseRecordSha256: 'ca2b43b4e0bc798e88edbed16711797d24d365ec5f9d95f72b9ed1fb9f549c5f',
        toolchainArtifactRecordSha256: '29fc48a9fb92b50eaa0dba3572e817a708e7e4ce350a16ad44f5d9fccca5c197',
      },
    });
  });

  it('retains the confirmed x86_64 ImageID and exact local build provenance', async () => {
    const mapping = await readMapping();
    const x86 = mapping.mappings[mapping.current]?.variants.x86_64;

    expect(x86).toMatchObject({
      state: 'confirmed',
      imageId: '0x3410888ad3f61652273a40c31556f4fc50cf9443ab5c6d1f7a162683779b243d',
      provenance: {
        evidenceType: 'local-guest-build',
        compiledAt: '2026-09-12T18:48:04Z',
        buildProfile: 'release+production',
        hostRustVersion: '1.97.1',
        hostRustCommit: '8bab26f4f68e0e26f0bb7960be334d5b520ea452',
        risc0Version: '3.0.6',
        guestToolchain: 'r0.1.97.0',
        risc0Commit: '1cc70cf05033a79ebc90f07c679cb4bd1cd301b9',
        guestToolchainCommit: 'e638c6cfea1eff5fbbb24a27e60538e3760d21b8',
        guestElfSha256: 'fe394c97dc2f2fb298b7d584982f43c461b36ebd8847a06363d0892cafc122b2',
        guestProgramBinarySha256: 'ddc6a877a45a76f6fa18273eead9f34905bfd32beca5feb55319313f02ad50e3',
        hostBinarySha256: 'b94374d8fd6f8365d9274a1c98b14374c3aad721474e6dfca9fdded4feee5825',
        zkvmCargoLockSha256: 'aefe71d744326c7125a9df34c564963c5b8d781979ffa45e0a2bb7e667c9ef9c',
      },
    });
  });

  it('resolves the independently confirmed ARM64 and x86_64 variants', async () => {
    const mapping = await readMapping();
    const { getExpectedImageId } = await import('./image-id-verifier');

    expect(getExpectedImageId(mapping, CURRENT_METHOD_VERSION, 'default')).toBe(
      '0xa869ba5ae3fcd9a54b3f4b81466f4056f31d4d1a2eb93cc432e7dbecc9d290a6',
    );
    expect(getExpectedImageId(mapping, CURRENT_METHOD_VERSION, 'x86_64')).toBe(
      '0x3410888ad3f61652273a40c31556f4fc50cf9443ab5c6d1f7a162683779b243d',
    );
  });
});

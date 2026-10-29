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

  it('binds the default variant to the accepted managed ARM64 release for the current dependencies', async () => {
    const mapping = await readMapping();
    expect(mapping.mappings[mapping.current]?.variants.default).toEqual({
      state: 'confirmed',
      imageId: '0xdde08e57c98144b1b57cb79e1d6726e82b702a15a469a690e6caf5c8c81c28e8',
      provenance: {
        evidenceType: 'accepted-prover-release',
        sourceSha: '3ebaee8211f12b5e813e6d399c601cb0064b3a42',
        proverImageDigest: 'sha256:76387d8bb354fa7437c36d92e642f642c3562007955128b58f6b5c145fca1324',
        candidateMetadataSha256: '3313c8438ecc1f6421176dac39f4db22c0c8113a4fc5bfa984c1fec8a4da8350',
        releaseRecordSha256: '1e1ab1017b219fdb1fe149799e6a724499282284ecd8dd9a8e8bfbf062be80b5',
        toolchainArtifactRecordSha256: 'daa45d521a750c0f409646882eafe8655fc5da8685cccf57390ef05b009a9cd9',
      },
    });
  });

  it('retains the confirmed x86_64 ImageID and exact local build provenance', async () => {
    const mapping = await readMapping();
    const x86 = mapping.mappings[mapping.current]?.variants.x86_64;

    expect(x86).toMatchObject({
      state: 'confirmed',
      imageId: '0xb545c4a95f560f6025c8cb9d66427e699da807efb34668a4dade1239cc2edcb5',
      provenance: {
        evidenceType: 'local-guest-build',
        compiledAt: '2026-10-23T20:25:33Z',
        buildProfile: 'release+production',
        hostRustVersion: '1.99.0',
        hostRustCommit: 'b940084d7eb6a299eb4bfeb8e34901bc051e7ac4',
        risc0Version: '3.0.6',
        guestToolchain: 'r0.1.97.0',
        risc0Commit: '1cc70cf05033a79ebc90f07c679cb4bd1cd301b9',
        guestToolchainCommit: 'e638c6cfea1eff5fbbb24a27e60538e3760d21b8',
        guestElfSha256: 'a608c5e4c042ce8112a99b282140415edc27087b373c81082de71af0475b996b',
        guestProgramBinarySha256: 'b78922a82340f5611b2e9bbc23c3b48a40d8d76476994c98682fda5992b2f560',
        hostBinarySha256: 'a9fe2328ec4f671530590f1015883f340128aca0619d6ed09103e222f5c79b3f',
        zkvmCargoLockSha256: '3119d380215eebf8a367c5470d60922f7afcb763ca69fc9e2c67a29400b31c89',
      },
    });
  });

  it('rejects the unconfirmed default without falling back to the confirmed x86_64 variant', async () => {
    const confirmed = await readMapping();
    const current = confirmed.mappings[confirmed.current];
    const mapping = parseImageIdMapping({
      ...confirmed,
      mappings: {
        [confirmed.current]: {
          ...current,
          variants: {
            ...current?.variants,
            default: { state: 'unconfirmed', requiredEvidence: 'accepted-prover-release' },
          },
        },
      },
    });
    const { getExpectedImageId } = await import('./image-id-verifier');

    expect(() => getExpectedImageId(mapping, CURRENT_METHOD_VERSION, 'default')).toThrow(/unconfirmed/u);
    expect(getExpectedImageId(mapping, CURRENT_METHOD_VERSION, 'x86_64')).toBe(
      '0xb545c4a95f560f6025c8cb9d66427e699da807efb34668a4dade1239cc2edcb5',
    );
  });
});

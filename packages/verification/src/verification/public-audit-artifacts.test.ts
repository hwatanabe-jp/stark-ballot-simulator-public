import { describe, expect, it } from 'vitest';
import { buildDefaultElectionConfig, hashElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { UINT32_MAX } from '@stark-ballot/zkvm-contract/zkvm/types';
import { getOpenApiEffectMetadata } from '@stark-ballot/validation/schema-openapi';
import {
  buildCloseStatement,
  buildElectionManifest,
  isCloseStatement,
  isElectionManifest,
  recomputeElectionManifestHash,
  resolveElectionConfigForManifest,
  electionManifestArtifactSchema,
} from './public-audit-artifacts';

const ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

function createElectionManifest() {
  return buildElectionManifest(ELECTION_ID, buildDefaultElectionConfig());
}

function createCloseStatement() {
  return buildCloseStatement({
    logId: '0x' + '1'.repeat(64),
    treeSize: 64,
    timestamp: 1_700_000_000_000,
    bulletinRoot: '0x' + '2'.repeat(64),
  });
}

describe('public-audit-artifacts', () => {
  it('documents the uppercase hex prefix admitted by runtime parsing', () => {
    const electionConfigHash = `0X${'a'.repeat(64)}`;
    const candidate = { ...createElectionManifest(), electionConfigHash };

    expect(electionManifestArtifactSchema.safeParse(candidate).success).toBe(true);
    const descriptor = electionManifestArtifactSchema.getStructuralDescriptor();
    if (descriptor.kind !== 'ObjectSchema') throw new Error('Election manifest must remain an object schema');
    const hashSchema = descriptor.shape['electionConfigHash'];
    if (!hashSchema) throw new Error('Election config hash schema is missing');
    const hashDescriptor = hashSchema.getStructuralDescriptor();
    if (hashDescriptor.kind !== 'EffectsSchema') throw new Error('Election config hash must remain documented');
    expect(getOpenApiEffectMetadata(hashSchema)).toMatchObject({
      overlay: { pattern: '^(?:0[xX])?[0-9A-Fa-f]{64}$' },
    });
  });

  it('builds an authoritative election manifest from repo defaults', () => {
    const manifest = createElectionManifest();

    expect(manifest).toEqual({
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      totalExpected: 64,
      choices: ['A', 'B', 'C', 'D', 'E'],
      version: 'v1.0',
      botCount: 63,
      merkleTreeDepth: 6,
      electionConfigHash: recomputeElectionManifestHash(manifest),
    });
    expect(isElectionManifest(manifest)).toBe(true);
  });

  it('builds a close statement with a recomputed STH digest', () => {
    const closeStatement = createCloseStatement();

    expect(closeStatement).toEqual({
      logId: '0x' + '1'.repeat(64),
      treeSize: 64,
      timestamp: 1_700_000_000_000,
      bulletinRoot: '0x' + '2'.repeat(64),
      sthDigest: '0xd65a089fd6504c4730c5977b80b13ef38a6fc95ad1d0e1e9ec63949dfd100650',
    });
    expect(isCloseStatement(closeStatement)).toBe(true);
  });

  it('builds an election manifest from an explicit authoritative config', () => {
    const electionConfig = {
      totalExpected: 64,
      choices: ['A', 'B', 'C'],
      version: 'legacy-v0',
      botCount: 63,
      merkleTreeDepth: 6,
    } as const;

    const manifest = buildElectionManifest('550e8400-e29b-41d4-a716-446655440000', electionConfig);

    expect(manifest).toEqual({
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      totalExpected: 64,
      choices: ['A', 'B', 'C'],
      version: 'legacy-v0',
      botCount: 63,
      merkleTreeDepth: 6,
      electionConfigHash: hashElectionConfig(electionConfig),
    });
  });

  it('fails safe when an authoritative manifest source is unavailable', () => {
    expect(() =>
      resolveElectionConfigForManifest({
        electionConfigHash: '0x' + '9'.repeat(64),
        totalExpected: 64,
      }),
    ).toThrow('Authoritative election config unavailable for manifest generation');
  });

  it('requires an explicit authoritative election config instead of inferring current defaults', () => {
    expect(() =>
      resolveElectionConfigForManifest({
        electionConfigHash: '0x9eaeb44bc6f5ca5db6c6ffd7ad5f00674588cea3038db8290aaf1750bef997ea',
        totalExpected: 64,
      }),
    ).toThrow('Authoritative election config unavailable for manifest generation');
  });

  it('rejects malformed audit artifacts', () => {
    expect(isElectionManifest({ electionId: 'not-a-manifest' })).toBe(false);
    expect(isCloseStatement({ logId: '0x1234' })).toBe(false);
  });

  it('admits election manifests only with the exact current keys', () => {
    const manifest = createElectionManifest();

    expect(isElectionManifest({ ...manifest, unexpected: true })).toBe(false);
    for (const key of Object.keys(manifest)) {
      const candidate: Record<string, unknown> = { ...manifest };
      delete candidate[key];
      expect(isElectionManifest(candidate), `missing ${key}`).toBe(false);
    }
  });

  it.each([
    ['electionId', 'not-a-uuid'],
    ['totalExpected', -1],
    ['totalExpected', 1.5],
    ['totalExpected', UINT32_MAX + 1],
    ['choices', []],
    ['choices', ['A', '']],
    ['version', ''],
    ['botCount', -1],
    ['botCount', 1.5],
    ['botCount', UINT32_MAX + 1],
    ['merkleTreeDepth', 0],
    ['merkleTreeDepth', 1.5],
    ['merkleTreeDepth', UINT32_MAX + 1],
    ['electionConfigHash', '0x1234'],
  ] as const)('rejects an election manifest with invalid %s', (field, invalidValue) => {
    expect(isElectionManifest({ ...createElectionManifest(), [field]: invalidValue })).toBe(false);
  });

  it('admits election manifest integer boundary values', () => {
    expect(
      isElectionManifest({
        ...createElectionManifest(),
        totalExpected: UINT32_MAX,
        botCount: 0,
        merkleTreeDepth: UINT32_MAX,
      }),
    ).toBe(true);
  });

  it('admits close statements only with the exact current keys', () => {
    const closeStatement = createCloseStatement();

    expect(isCloseStatement({ ...closeStatement, unexpected: true })).toBe(false);
    for (const key of Object.keys(closeStatement)) {
      const candidate: Record<string, unknown> = { ...closeStatement };
      delete candidate[key];
      expect(isCloseStatement(candidate), `missing ${key}`).toBe(false);
    }
  });

  it.each([
    ['logId', '0x1234'],
    ['treeSize', 0],
    ['treeSize', -1],
    ['treeSize', 1.5],
    ['treeSize', UINT32_MAX + 1],
    ['timestamp', -1],
    ['timestamp', 1.5],
    ['timestamp', Number.MAX_SAFE_INTEGER + 1],
    ['bulletinRoot', '0x1234'],
    ['sthDigest', '0x1234'],
  ] as const)('rejects a close statement with invalid %s', (field, invalidValue) => {
    expect(isCloseStatement({ ...createCloseStatement(), [field]: invalidValue })).toBe(false);
  });

  it('admits close statement integer boundary values', () => {
    expect(isCloseStatement({ ...createCloseStatement(), treeSize: UINT32_MAX, timestamp: 0 })).toBe(true);
  });
});

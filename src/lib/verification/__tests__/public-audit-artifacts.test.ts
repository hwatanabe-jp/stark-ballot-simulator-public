import { describe, expect, it } from 'vitest';
import { buildDefaultElectionConfig, hashElectionConfig } from '@/lib/zkvm/election-config';
import {
  buildCloseStatement,
  buildElectionManifest,
  isCloseStatement,
  isElectionManifest,
  recomputeElectionManifestHash,
  resolveElectionConfigForManifest,
} from '../public-audit-artifacts';

describe('public-audit-artifacts', () => {
  it('builds an authoritative election manifest from repo defaults', () => {
    const manifest = buildElectionManifest('550e8400-e29b-41d4-a716-446655440000', buildDefaultElectionConfig());

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
    const closeStatement = buildCloseStatement({
      logId: '0x' + '1'.repeat(64),
      treeSize: 64,
      timestamp: 1_700_000_000_000,
      bulletinRoot: '0x' + '2'.repeat(64),
    });

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
});

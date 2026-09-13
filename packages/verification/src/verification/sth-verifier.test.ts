import { describe, expect, it } from 'vitest';
import { verifySthConsensus, type AdmittedSthRecord } from './sth-verifier';

const baseJournal = {
  sthDigest: `0x${'a'.repeat(64)}`,
  bulletinRoot: `0x${'b'.repeat(64)}`,
  treeSize: 64,
};

function matchingRecord(source = 'https://auditor.example/sth'): AdmittedSthRecord {
  return {
    source,
    sthDigest: baseJournal.sthDigest,
    bulletinRoot: baseJournal.bulletinRoot,
    treeSize: baseJournal.treeSize,
  };
}

describe('verifySthConsensus', () => {
  it('passes when admitted records satisfy the configured minimum and consensus', () => {
    const result = verifySthConsensus(baseJournal, [matchingRecord('a'), matchingRecord('b')], {
      minMatchingSources: 2,
    });

    expect(result).toMatchObject({
      verified: true,
      consensus: true,
      sourcesChecked: 2,
      matchingSources: 2,
      errors: [],
    });
  });

  it('fails closed when matching records are below the configured minimum', () => {
    const result = verifySthConsensus(baseJournal, [matchingRecord()], {
      minMatchingSources: 2,
      sourcesChecked: 2,
    });

    expect(result.verified).toBe(false);
    expect(result.consensus).toBe(true);
    expect(result.sourcesChecked).toBe(2);
    expect(result.errors.join('\n')).toMatch(/Insufficient matching STH sources/);
  });

  it('fails closed on digest, root, or tree-size mismatch', () => {
    const result = verifySthConsensus(
      baseJournal,
      [
        matchingRecord('matching'),
        {
          ...matchingRecord('mismatch'),
          sthDigest: `0x${'c'.repeat(64)}`,
        },
      ],
      { minMatchingSources: 1 },
    );

    expect(result.verified).toBe(false);
    expect(result.consensus).toBe(false);
    expect(result.matchingSources).toBe(1);
    expect(result.errors.join('\n')).toMatch(/digest mismatch/);
  });

  it('includes runtime-owned provider errors in the fail-closed result', () => {
    const result = verifySthConsensus(baseJournal, [], {
      minMatchingSources: 1,
      sourcesChecked: 1,
      errors: ['Malformed STH response from https://auditor.example/sth'],
    });

    expect(result.verified).toBe(false);
    expect(result.sourcesChecked).toBe(1);
    expect(result.errors).toContain('Malformed STH response from https://auditor.example/sth');
  });
});

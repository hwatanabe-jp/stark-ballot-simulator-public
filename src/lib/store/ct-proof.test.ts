import { describe, expect, it } from 'vitest';
import { deriveExactCtProof } from '@/lib/store/ct-proof';

describe('deriveExactCtProof', () => {
  const createBulletin = (overrides?: { rootHash?: string; proofNodes?: string[] }) => ({
    getInclusionProof: (_voteId: string, treeSize: number) => ({
      leafIndex: 0,
      treeSize,
      proofNodes: overrides?.proofNodes ?? ['0x' + '2'.repeat(64)],
      rootHash: overrides?.rootHash ?? '0x' + '1'.repeat(64),
    }),
  });

  it('returns the exact proof when all persisted evidence is valid', () => {
    const result = deriveExactCtProof({
      bulletin: createBulletin(),
      voteId: 'vote-1',
      leafIndex: 0,
      rootAtCast: '0x' + '1'.repeat(64),
    });

    expect(result).toMatchObject({
      leafIndex: 0,
      treeSize: 1,
      bulletinRootAtCast: '0x' + '1'.repeat(64),
    });
    expect(result).not.toHaveProperty('proofMode');
    expect(result.merklePath).toEqual(['0x' + '2'.repeat(64)]);
  });

  it.each([
    {
      name: 'persisted rootAtCast is malformed',
      params: {
        bulletin: createBulletin(),
        voteId: 'vote-1',
        leafIndex: 0,
        rootAtCast: 'not-hex',
      },
    },
    {
      name: 'proof root hash is malformed',
      params: {
        bulletin: createBulletin({ rootHash: 'not-hex' }),
        voteId: 'vote-1',
        leafIndex: 0,
        rootAtCast: '0x' + '1'.repeat(64),
      },
    },
    {
      name: 'proof nodes contain malformed hex values',
      params: {
        bulletin: createBulletin({ proofNodes: ['not-hex'] }),
        voteId: 'vote-1',
        leafIndex: 0,
        rootAtCast: '0x' + '1'.repeat(64),
      },
    },
  ])('normalizes $name to CT_PROOF_UNAVAILABLE', ({ params }) => {
    expect(() => deriveExactCtProof(params)).toThrow('CT_PROOF_UNAVAILABLE');
  });
});

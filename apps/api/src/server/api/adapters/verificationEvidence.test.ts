import { describe, expect, it, vi } from 'vitest';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type { SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import { createMockVoteStore } from '../../__tests__/support/mockVoteStore';
import { evaluateChecks } from '@stark-ballot/verification/check-evaluator';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { acquireBitmapProofEvidence, acquireConsistencyProofEvidence } from './verificationEvidence';

const sessionId = 'session-evidence';
const finalizationId = 'finalization-evidence';

function buildBulletinSession(): SessionVotingRecord {
  const logId = `0x${'ab'.repeat(32)}`;
  const bulletin = new SimpleBulletinBoard(logId);
  const votes = [
    {
      voteId: '550e8400-e29b-41d4-a716-446655440000',
      commit: `0x${'11'.repeat(32)}`,
    },
    {
      voteId: '550e8400-e29b-41d4-a716-446655440001',
      commit: `0x${'22'.repeat(32)}`,
    },
  ] as const;
  for (const vote of votes) {
    bulletin.appendVote(vote.voteId, vote.commit.slice(2));
  }

  return {
    sessionId,
    votes: new Map(
      votes.map((vote, index) => [
        index,
        {
          ...vote,
          vote: 'A' as const,
          rand: `0x${'33'.repeat(32)}`,
          timestamp: index + 1,
          rootAtCast: bulletin.getRootAtSize(index + 1),
        },
      ]),
    ),
    bulletin,
    bulletinRootHistory: bulletin.getRootHistory(),
    botCount: 1,
    lastActivityMs: 2,
    userParticipation: { status: 'cast', voteIndex: 0 },
  };
}

describe('verification evidence acquisition', () => {
  it('projects and verifies a nontrivial prefixed consistency proof', async () => {
    const session = buildBulletinSession();
    const evidence = acquireConsistencyProofEvidence({
      session,
      fromTreeSize: 1,
      toTreeSize: 2,
      generatedAtMs: 3,
    });

    expect(evidence.kind).toBe('admitted');
    if (evidence.kind !== 'admitted') {
      throw new Error('expected admitted consistency evidence');
    }
    expect(evidence.value.proofNodes).not.toHaveLength(0);
    expect(evidence.value.proofNodes.every((node) => node.startsWith('0x'))).toBe(true);
    const checks = await evaluateChecks(
      {
        voteReceipt: {
          voteId: '550e8400-e29b-41d4-a716-446655440000',
          commitment: `0x${'11'.repeat(32)}`,
          bulletinIndex: 0,
          bulletinRootAtCast: evidence.value.rootAtFromTreeSize,
          timestamp: 1,
        },
        userVote: {
          commitment: `0x${'11'.repeat(32)}`,
          proof: {
            leafIndex: 0,
            treeSize: 1,
            merklePath: [],
            bulletinRootAtCast: evidence.value.rootAtFromTreeSize,
          },
        },
        bulletinRoot: evidence.value.rootAtToTreeSize,
        treeSize: 2,
        consistencyProof: evidence,
      },
      ['recorded_consistency_proof'],
    );
    expect(checks.get('recorded_consistency_proof')?.status).toBe('success');
  });

  it('reads bitmap data once and admits included and seen proofs', async () => {
    const includedBitmap = [true, false];
    const seenBitmap = [true, true];
    const includedBitmapRoot = computeIncludedBitmapRoot(includedBitmap);
    const seenBitmapRoot = computeIncludedBitmapRoot(seenBitmap);
    const getBitmapData = vi.fn().mockResolvedValue({
      includedBitmap,
      includedBitmapRoot,
      seenBitmap,
      seenBitmapRoot,
      treeSize: 2,
      finalizedAtMs: 3,
    });

    const evidence = await acquireBitmapProofEvidence({
      store: createMockVoteStore({ getBitmapData }),
      sessionId,
      finalizationId,
      voteIndex: 0,
      finalizationResult: {
        journal: {
          includedBitmapRoot,
          seenBitmapRoot,
          treeSize: 2,
        },
      },
    });

    expect(getBitmapData).toHaveBeenCalledTimes(1);
    expect(getBitmapData).toHaveBeenCalledWith(sessionId, finalizationId);
    expect(evidence.included.kind).toBe('admitted');
    expect(evidence.seen?.kind).toBe('admitted');
  });

  it.each([
    ['unavailable', vi.fn().mockResolvedValue(null)],
    ['transport_failed', vi.fn().mockRejectedValue(new Error('store unavailable'))],
  ] as const)('classifies %s bitmap acquisition', async (expectedKind, getBitmapData) => {
    const includedBitmapRoot = computeIncludedBitmapRoot([true]);
    const evidence = await acquireBitmapProofEvidence({
      store: createMockVoteStore({ getBitmapData }),
      sessionId,
      finalizationId,
      voteIndex: 0,
      finalizationResult: {
        journal: {
          includedBitmapRoot,
          treeSize: 1,
        },
      },
    });

    expect(evidence.included.kind).toBe(expectedKind);
  });
});

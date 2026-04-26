import { describe, expect, it } from 'vitest';
import { createTestInput } from '@/lib/testing/test-helpers';
import { executeMockZkVM } from '@/lib/zkvm/mock-executor';
import { verifyCastAsIntended, verifyRecordedAsCast, verifyCountedAsRecorded } from '@/lib/verification/three-stage';
import type { VoteReceipt } from '@/types/receipt';
import type { BulletinBoard } from '@/types/bulletin';
import { VOTE_CHOICES } from '@/shared/constants';

describe('Three-stage verification integration (mock data)', () => {
  it('passes Cast → Recorded → Counted for an honest scenario', async () => {
    const input = createTestInput({ voteCount: 5, totalExpected: 5, treeSize: 5 });
    const journal = await executeMockZkVM(input);
    const firstVote = input.votes[0];
    const userChoice = VOTE_CHOICES[firstVote.choice];

    const receipt: VoteReceipt = {
      voteId: 'test-vote-0',
      commitment: firstVote.commitment,
      bulletinIndex: firstVote.index,
      bulletinRootAtCast: input.bulletinRoot,
      inputCommitment: journal.inputCommitment,
      timestamp: Date.now(),
    };

    const bulletin: BulletinBoard = {
      commitments: input.votes.map((vote) => vote.commitment),
      bulletinRoot: input.bulletinRoot,
      treeSize: input.treeSize,
      timestamp: Date.now(),
      rootHistory: [
        {
          timestamp: Date.now(),
          bulletinRoot: input.bulletinRoot,
          treeSize: input.treeSize,
        },
      ],
    };

    const castResult = await verifyCastAsIntended(receipt, {
      electionId: input.electionId,
      choice: userChoice,
      random: firstVote.random,
    });
    expect(castResult.passed).toBe(true);

    const recordedResult = await verifyRecordedAsCast(receipt, bulletin);
    expect(recordedResult.passed).toBe(true);

    const countedResult = await verifyCountedAsRecorded(journal);
    expect(countedResult.passed).toBe(true);
  });

  it('fails Counted-as-Recorded when the journal reports missing indices', async () => {
    const input = createTestInput({ voteCount: 2, totalExpected: 4, treeSize: 4 });
    const journal = await executeMockZkVM(input);

    expect(journal.missingSlots).toBeGreaterThan(0);

    const countedResult = await verifyCountedAsRecorded(journal);
    expect(countedResult.passed).toBe(false);
    expect(countedResult.error).toMatch(/conservative exclusion signal detected/i);
    expect(countedResult.error).toContain('unpresented indices');
  });
});

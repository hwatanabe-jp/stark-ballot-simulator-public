import type { SessionVoteMutation } from './session-mutation-policy';

function inspectReplay(outcome: SessionVoteMutation): void {
  if (outcome.kind === 'user_vote_replayed') {
    void outcome.castResult;
    // @ts-expect-error A receipt replay carries no state to write.
    void outcome.nextVoting;
    // @ts-expect-error A receipt replay cannot install vote indexes.
    void outcome.indexIntents;
  }
}
void inspectReplay;

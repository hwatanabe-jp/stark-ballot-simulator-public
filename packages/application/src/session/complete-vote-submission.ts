import { BotVoter, type BotVotingStore } from '../bot/botVoter';
import type { ApplicationVoteStore, SessionVoteStoreError } from './session-vote-store';
import type { PreparedUserVoteSubmission } from './submit-vote';
import { resolveUserVoteReplay } from './user-vote-replay';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { VoteReceipt } from '@stark-ballot/domain/types/receipt';
import type { Result } from '@stark-ballot/application';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';

/** Complete required work within the invocation. Failed invocations can replay the same opening. */
export async function completeVoteSubmission(
  store: BotVotingStore & Pick<ApplicationVoteStore, 'addVote'>,
  sessionId: SessionId,
  submission: PreparedUserVoteSubmission,
): Promise<
  Result<
    Pick<VoteReceipt, 'voteId' | 'commitment' | 'bulletinIndex' | 'bulletinRootAtCast' | 'timestamp'>,
    SessionVoteStoreError
  >
> {
  const saved = await store.addVote(sessionId, submission.command);
  if (!saved.ok) return saved;
  await new BotVoter(store).startBotVoting(sessionId);
  const [identity, voting] = await Promise.all([store.getSessionIdentity(sessionId), store.getVotingRecord(sessionId)]);
  if (!identity || !voting) throw new Error('Saved vote authority unavailable');
  const replay = resolveUserVoteReplay({ identity, voting }, submission.command);
  if (replay.kind !== 'replay') throw new Error('Saved vote differs from submission');
  return {
    ok: true,
    value: {
      voteId: replay.vote.voteId,
      commitment: normalizeHex(replay.vote.commit),
      bulletinIndex: replay.index,
      bulletinRootAtCast: normalizeHex(replay.vote.rootAtCast),
      timestamp: replay.vote.timestamp,
    },
  };
}

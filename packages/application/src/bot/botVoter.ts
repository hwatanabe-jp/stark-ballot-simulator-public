import { generateBotVote } from '@stark-ballot/domain/bot/voteGenerator';
import type { BotVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import type { ApplicationVoteStore } from '@stark-ballot/application/session/session-vote-store';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import {
  assertCanonicalUserVoteIndexForBotVotes,
  deriveBotCountFromVotes,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { ApplicationErrorCode } from '@stark-ballot/application';

export interface BotVotingProgress {
  completed: number;
  total: number;
  percentage: number;
}

export type BotVotingStore = Pick<ApplicationVoteStore, 'getSessionIdentity' | 'getVotingRecord' | 'addBotVotes'> &
  Pick<FinalizationLifecycleStore, 'getCurrentFinalizationRecord'>;

export class BotVoter {
  private readonly store: BotVotingStore;

  constructor(store: BotVotingStore) {
    this.store = store;
  }

  /**
   * Start bot voting process for a session
   */
  async startBotVoting(sessionId: SessionId): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [identity, voting, currentFinalization] = await Promise.all([
        this.store.getSessionIdentity(sessionId),
        this.store.getVotingRecord(sessionId),
        this.store.getCurrentFinalizationRecord(sessionId),
      ]);
      if (!identity || !voting) throw new Error('SESSION_NOT_FOUND');
      const userVoteIndex = voting.userParticipation.status === 'cast' ? voting.userParticipation.voteIndex : undefined;
      assertCanonicalUserVoteIndexForBotVotes(voting.votes, userVoteIndex);
      const currentBotCount = deriveBotCountFromVotes(voting.votes, userVoteIndex);
      if (currentBotCount !== voting.botCount || currentBotCount > BOT_COUNT) throw new Error('Invalid bot vote count');
      if (currentBotCount === BOT_COUNT) return;
      if (currentFinalization !== null) throw new Error('SESSION_ALREADY_FINALIZED');
      const batch: BotVoteCommand[] = [];
      for (let i = currentBotCount; i < BOT_COUNT; i += 1) batch.push(await generateBotVote());
      const result = await this.store.addBotVotes(sessionId, batch);
      if (result.ok) return;
      switch (result.error.code) {
        case ApplicationErrorCode.ALREADY_VOTED:
        case ApplicationErrorCode.SESSION_FINALIZED:
          // A competing invocation may have completed the batch and started finalization.
          // Re-read only typed state conflicts; infrastructure errors remain failures.
          continue;
        case ApplicationErrorCode.SESSION_NOT_FOUND:
          throw new Error('SESSION_NOT_FOUND');
        case ApplicationErrorCode.USER_NOT_VOTED:
          throw new Error('USER_VOTE_REQUIRED_BEFORE_BOT_VOTES');
        case ApplicationErrorCode.DUPLICATE_VOTE:
          throw new Error('BOT_VOTE_CONFLICT');
      }
    }
    throw new Error('Bot voting contention limit exceeded');
  }

  /**
   * Get current bot voting progress
   */
  async getProgress(sessionId: SessionId): Promise<BotVotingProgress | null> {
    const voting = await this.store.getVotingRecord(sessionId);
    if (!voting) {
      return null;
    }

    const userVoteIndex = voting.userParticipation.status === 'cast' ? voting.userParticipation.voteIndex : undefined;
    const completed = deriveBotCountFromVotes(voting.votes, userVoteIndex);
    const total = BOT_COUNT;
    const percentage = Math.round((completed / total) * 100);

    return {
      completed,
      total,
      percentage,
    };
  }
}

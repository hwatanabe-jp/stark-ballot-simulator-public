import { generateBotVote, generateBotId } from '@stark-ballot/domain/bot/voteGenerator';
import type { VoteData } from '@stark-ballot/domain/types/sessionRecords';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationLifecycleStore } from '@stark-ballot/application/finalize/finalization-store';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import {
  assertCanonicalUserVoteIndexForBotVotes,
  deriveBotCountFromVotes,
} from '@stark-ballot/domain/bulletin/ctSessionState';

export interface BotVotingProgress {
  completed: number;
  total: number;
  percentage: number;
}

export class BotVoter {
  constructor(private readonly store: VoteStore & FinalizationLifecycleStore) {}

  /**
   * Start bot voting process for a session
   */
  async startBotVoting(sessionId: string): Promise<void> {
    const [identity, voting, currentFinalization] = await Promise.all([
      this.store.getSessionIdentity(sessionId),
      this.store.getVotingRecord(sessionId),
      this.store.getCurrentFinalizationRecord(sessionId),
    ]);
    if (!identity || !voting) {
      throw new Error('SESSION_NOT_FOUND');
    }
    if (currentFinalization?.state.status === 'succeeded') {
      throw new Error('SESSION_ALREADY_FINALIZED');
    }

    const userVoteIndex = voting.userParticipation.status === 'cast' ? voting.userParticipation.voteIndex : undefined;
    const currentBotCount = deriveBotCountFromVotes(voting.votes, userVoteIndex);
    assertCanonicalUserVoteIndexForBotVotes(voting.votes, userVoteIndex);
    if (currentBotCount >= BOT_COUNT) {
      throw new Error('ALL_BOTS_VOTED');
    }

    // Generate remaining bot votes
    const remainingBots = BOT_COUNT - currentBotCount;
    const startIndex = currentBotCount;
    const batch: VoteData[] = [];

    // Generate all remaining votes before a single write for speed
    for (let i = 0; i < remainingBots; i += 1) {
      const botIndex = startIndex + i;
      const botId = generateBotId(botIndex);
      const voteData = await generateBotVote(botId, identity.electionId);
      batch.push(voteData);
    }

    await this.store.addBotVotes(sessionId, batch);
  }

  /**
   * Get current bot voting progress
   */
  async getProgress(sessionId: string): Promise<BotVotingProgress | null> {
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

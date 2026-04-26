import { getGlobalStore } from '@/lib/store/storeInstance';
import { generateBotVote, generateBotId } from './voteGenerator';
import type { VoteData } from '@/types/server';
import { BOT_COUNT } from '@/shared/constants';
import { isRecoverableCurrentLiveSession } from '@/lib/contract';
import { assertCanonicalUserVoteIndexForBotVotes, deriveBotCountFromVotes } from '@/lib/store/ctSessionState';

export interface BotVotingProgress {
  completed: number;
  total: number;
  percentage: number;
}

export class BotVoter {
  private store = getGlobalStore();

  constructor() {
    // Store is now a singleton from getGlobalStore()
  }

  /**
   * Start bot voting process for a session
   */
  async startBotVoting(sessionId: string): Promise<void> {
    // Get current session state
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new Error('SESSION_NOT_FOUND');
    }
    if (session.finalized) {
      throw new Error('SESSION_ALREADY_FINALIZED');
    }
    if (!isRecoverableCurrentLiveSession(session)) {
      throw new Error('SESSION_NOT_FOUND');
    }

    const currentBotCount = deriveBotCountFromVotes(session.votes, session.userVoteIndex);
    const electionId = session.electionId;
    if (!electionId) {
      throw new Error('SESSION_MISSING_ELECTION_ID');
    }
    assertCanonicalUserVoteIndexForBotVotes(session.votes, session.userVoteIndex);
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
      const voteData = await generateBotVote(botId, electionId);
      batch.push(voteData);
    }

    await this.store.addBotVotes(sessionId, batch);
  }

  /**
   * Get current bot voting progress
   */
  async getProgress(sessionId: string): Promise<BotVotingProgress | null> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return null;
    }

    const completed = deriveBotCountFromVotes(session.votes, session.userVoteIndex);
    const total = BOT_COUNT;
    const percentage = Math.round((completed / total) * 100);

    return {
      completed,
      total,
      percentage,
    };
  }
}

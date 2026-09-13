import { describe, expect, it, vi } from 'vitest';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  buildSessionRecords,
  evaluateSessionVoteMutation,
  type SessionMutationDependencies,
  type SessionVoteMutation,
  type SessionVoteMutationResult,
  type SessionVoteAuthority,
} from './session-mutation-policy';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { BotVoteCommand, UserVoteCommand } from '@stark-ballot/domain/types/sessionRecords';
import { ApplicationErrorCode } from '@stark-ballot/application';

const SESSION_ID = asSessionId('00000000-0000-4000-8000-000000000010');
const FINALIZATION_ID = asFinalizationId('finalization-1');
const ELECTION_ID = '00000000-0000-4000-8000-000000000020';
const LOG_ID = `0x${'ab'.repeat(32)}`;
const USER_VOTE_ID = '00000000-0000-4000-8000-000000000030';
const BOT_VOTE_ID = '00000000-0000-4000-8000-000000000040';
const SECOND_BOT_VOTE_ID = '00000000-0000-4000-8000-000000000050';

function buildSession(): SessionVoteAuthority {
  const records = buildSessionRecords({
    sessionId: SESSION_ID,
    electionId: ELECTION_ID,
    electionConfigHash: getDefaultElectionConfigHash(),
    electionConfig: buildDefaultElectionConfig(),
    logId: LOG_ID,
    createdAtMs: 100,
    lastActivityMs: 101,
  });
  return { ...records, finalization: null };
}

function withVoting(authority: SessionVoteAuthority, voting: SessionVoteAuthority['voting']): SessionVoteAuthority {
  return { ...authority, voting };
}

function buildDependencies(ids: string[], times: number[]): SessionMutationDependencies {
  let idIndex = 0;
  let timeIndex = 0;
  return {
    generateVoteId: vi.fn(() => ids[idIndex++] ?? '00000000-0000-4000-8000-000000000099'),
    nowMs: vi.fn(() => times[timeIndex++] ?? 999),
  };
}

function requireSuccessfulMutation(
  result: SessionVoteMutationResult,
): Exclude<SessionVoteMutation, { kind: 'user_vote_replayed' }> {
  if (!result.ok) {
    throw new Error(`Expected successful mutation, received ${result.error.code}`);
  }
  if (result.value.kind === 'user_vote_replayed') throw new Error('Expected an append mutation');
  return result.value;
}

function userVote(voteId: string, choice: 'A' | 'B' | 'C', randomNibble: string): UserVoteCommand {
  return {
    voteId,
    vote: choice,
    rand: randomNibble.repeat(64),
    timestamp: 50,
  };
}

function botVote(choice: 'A' | 'B' | 'C', randomNibble: string): BotVoteCommand {
  return {
    vote: choice,
    rand: randomNibble.repeat(64),
  };
}

describe('session mutation policy', () => {
  it('builds complete identity and empty voting records from injected values', () => {
    const authority = buildSession();

    expect(authority.identity).toEqual({
      sessionId: SESSION_ID,
      electionId: ELECTION_ID,
      electionConfigHash: getDefaultElectionConfigHash(),
      electionConfig: buildDefaultElectionConfig(),
      logId: LOG_ID,
      createdAtMs: 100,
    });
    expect(authority.voting).toMatchObject({
      sessionId: SESSION_ID,
      votes: new Map(),
      bulletinRootHistory: [],
      botCount: 0,
      userParticipation: { status: 'not_cast' },
      lastActivityMs: 101,
    });
    expect(authority.voting.bulletin.getLogId()).toBe(LOG_ID);
  });

  it('prepares a user vote, exact commitment, CT proof, and index intent without mutating current records', () => {
    const authority = buildSession();
    const mutation = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        authority,
        { kind: 'append_user_vote', vote: userVote(USER_VOTE_ID, 'B', 'a') },
        buildDependencies([], [500]),
      ),
    );

    expect(mutation.kind).toBe('user_vote_appended');
    if (mutation.kind !== 'user_vote_appended') {
      throw new Error('Expected user vote mutation');
    }
    expect(mutation.castResult).toMatchObject({
      leafIndex: 0,
      bulletinRootAtCast: `0x${mutation.nextVoting.bulletinRootHistory[0]?.root}`,
    });
    expect(mutation.castResult.merklePath).toEqual([]);
    expect(mutation.indexIntents).toEqual([{ voteId: USER_VOTE_ID, index: 0 }]);
    expect(mutation.nextVoting.userParticipation).toEqual({ status: 'cast', voteIndex: 0 });
    expect(mutation.nextVoting.lastActivityMs).toBe(500);
    expect(mutation.nextVoting.votes.get(0)).toMatchObject({
      voteId: USER_VOTE_ID,
      vote: 'B',
      rand: `0x${'a'.repeat(64)}`,
      commit: computeCommitment(ELECTION_ID, 1, `0x${'a'.repeat(64)}`),
    });
    expect(authority.voting.votes.size).toBe(0);
    expect(authority.voting.bulletin.getSize()).toBe(0);
    expect(authority.voting.bulletinRootHistory).toEqual([]);
  });

  it('rejects a second user vote before staging any CT mutation', () => {
    const authority = buildSession();
    const first = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        authority,
        { kind: 'append_user_vote', vote: userVote(USER_VOTE_ID, 'A', '1') },
        buildDependencies([], [200]),
      ),
    );
    const current = withVoting(authority, first.nextVoting);

    expect(
      evaluateSessionVoteMutation(
        current,
        { kind: 'append_user_vote', vote: userVote(BOT_VOTE_ID, 'B', '2') },
        buildDependencies([], [300]),
      ),
    ).toEqual({ ok: false, error: { code: ApplicationErrorCode.ALREADY_VOTED } });
    expect(current.voting.votes.size).toBe(1);
    expect(current.voting.bulletin.getSize()).toBe(1);
    expect(current.voting.userParticipation).toEqual({ status: 'cast', voteIndex: 0 });
  });

  it('returns an expected conflict result for a racing second user vote', () => {
    const authority = buildSession();
    const first = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        authority,
        { kind: 'append_user_vote', vote: userVote(USER_VOTE_ID, 'A', '1') },
        buildDependencies([], [200]),
      ),
    );
    const current = withVoting(authority, first.nextVoting);

    const second = evaluateSessionVoteMutation(
      current,
      { kind: 'append_user_vote', vote: userVote(BOT_VOTE_ID, 'B', '2') },
      buildDependencies([], [300]),
    );

    expect(second).toEqual({ ok: false, error: { code: ApplicationErrorCode.ALREADY_VOTED } });
    expect(current.voting.votes.size).toBe(1);
  });

  it('stages a canonical bot batch atomically', () => {
    const authority = buildSession();
    const userMutation = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        authority,
        { kind: 'append_user_vote', vote: userVote(USER_VOTE_ID, 'A', '1') },
        buildDependencies([], [200]),
      ),
    );
    const current = withVoting(authority, userMutation.nextVoting);

    const mutation = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        current,
        {
          kind: 'append_bot_votes',
          votes: [botVote('B', '2'), botVote('C', '3')],
        },
        buildDependencies([BOT_VOTE_ID, SECOND_BOT_VOTE_ID], [250, 251, 300]),
      ),
    );

    expect(mutation.kind).toBe('bot_votes_appended');
    if (mutation.kind !== 'bot_votes_appended') {
      throw new Error('Expected bot vote mutation');
    }
    expect(mutation.indexIntents).toEqual([
      { voteId: BOT_VOTE_ID, index: 1 },
      { voteId: SECOND_BOT_VOTE_ID, index: 2 },
    ]);
    expect(mutation.nextVoting.votes.size).toBe(3);
    expect(mutation.nextVoting.botCount).toBe(2);
    expect(mutation.nextVoting.userParticipation).toEqual({ status: 'cast', voteIndex: 0 });
    expect(mutation.nextVoting.bulletin.getSize()).toBe(3);
    expect(mutation.nextVoting.lastActivityMs).toBe(300);

    expect(current.voting.votes.size).toBe(1);
    expect(current.voting.botCount).toBe(0);
    expect(current.voting.userParticipation).toEqual({ status: 'cast', voteIndex: 0 });
    expect(current.voting.bulletin.getSize()).toBe(1);
  });

  it('assigns bot identity inside the mutation even for an unchecked value with caller-owned extras', () => {
    const authority = buildSession();
    const userMutation = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        authority,
        { kind: 'append_user_vote', vote: userVote(USER_VOTE_ID, 'A', '1') },
        buildDependencies([], [200]),
      ),
    );
    const current = withVoting(authority, userMutation.nextVoting);
    const uncheckedBot = {
      ...botVote('B', '2'),
      voteId: SECOND_BOT_VOTE_ID,
      timestamp: 1,
      commit: `0x${'f'.repeat(64)}`,
    } as unknown as BotVoteCommand;

    const mutation = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        current,
        { kind: 'append_bot_votes', votes: [uncheckedBot] },
        buildDependencies([BOT_VOTE_ID], [250, 300]),
      ),
    );

    expect(mutation.indexIntents).toEqual([{ voteId: BOT_VOTE_ID, index: 1 }]);
    expect(mutation.nextVoting.votes.get(1)).toMatchObject({
      voteId: BOT_VOTE_ID,
      commit: computeCommitment(ELECTION_ID, 1, `0x${'2'.repeat(64)}`),
    });
  });

  it('rejects inconsistent bot metadata instead of repairing current records', () => {
    const authority = buildSession();
    const userMutation = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        authority,
        { kind: 'append_user_vote', vote: userVote(USER_VOTE_ID, 'A', '1') },
        buildDependencies([], [200]),
      ),
    );
    const current = withVoting(authority, {
      ...userMutation.nextVoting,
      botCount: 9,
    });
    const sourceRoot = current.voting.bulletin.getCurrentRoot();

    expect(() =>
      evaluateSessionVoteMutation(
        current,
        {
          kind: 'append_bot_votes',
          votes: [botVote('B', '2')],
        },
        buildDependencies([BOT_VOTE_ID], [250, 300]),
      ),
    ).toThrow('Session voting record bot count is inconsistent');
    expect(current.voting.votes.size).toBe(1);
    expect(current.voting.botCount).toBe(9);
    expect(current.voting.bulletin.getCurrentRoot()).toBe(sourceRoot);
  });

  it('keeps failed batches atomic and rejects voting after a finalization record exists', () => {
    const empty = buildSession();
    expect(
      evaluateSessionVoteMutation(
        empty,
        { kind: 'append_bot_votes', votes: [botVote('B', '2')] },
        buildDependencies([BOT_VOTE_ID], [250, 300]),
      ),
    ).toEqual({ ok: false, error: { code: ApplicationErrorCode.USER_NOT_VOTED } });
    expect(empty.voting.votes.size).toBe(0);

    const userMutation = requireSuccessfulMutation(
      evaluateSessionVoteMutation(
        empty,
        { kind: 'append_user_vote', vote: userVote(USER_VOTE_ID, 'A', '1') },
        buildDependencies([], [200]),
      ),
    );
    const current = withVoting(empty, userMutation.nextVoting);
    const sourceRoot = current.voting.bulletin.getCurrentRoot();

    expect(() =>
      evaluateSessionVoteMutation(
        current,
        {
          kind: 'append_bot_votes',
          votes: [botVote('B', '2'), botVote('C', '3')],
        },
        buildDependencies([BOT_VOTE_ID, 'not-a-uuid'], [250, 251, 300]),
      ),
    ).toThrow('Invalid vote ID format');
    expect(current.voting.votes.size).toBe(1);
    expect(current.voting.botCount).toBe(0);
    expect(current.voting.bulletin.getCurrentRoot()).toBe(sourceRoot);

    expect(
      evaluateSessionVoteMutation(
        {
          ...current,
          finalization: {
            sessionId: SESSION_ID,
            finalizationId: FINALIZATION_ID,
            scenarioContext: {
              scenarios: [],
              tamperMode: 'none',
              claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
              claimedTotalVotes: 1,
              summary: { ignoredCount: 0, recountedCount: 0, userRecountChoice: null },
            },
            state: { status: 'pending', finalizationId: FINALIZATION_ID, queuedAtMs: 300 },
          },
        },
        { kind: 'append_user_vote', vote: userVote(BOT_VOTE_ID, 'B', '2') },
        buildDependencies([], [300]),
      ),
    ).toEqual({ ok: false, error: { code: ApplicationErrorCode.SESSION_FINALIZED } });
  });
});

import { resolveUserVoteReplay } from './user-vote-replay';
import { BOT_COUNT } from '@stark-ballot/domain/shared/constants';
import {
  assertCanonicalUserVoteIndexForBotVotes,
  buildCanonicalCtSessionProjection,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { stageCtVoteWrites, type StagedVoteWrite } from '@stark-ballot/domain/bulletin/stagedCtVoteWrite';
import type {
  AddVoteResult,
  BotVoteCommand,
  PreparedVote,
  SessionIdentityRecord,
  SessionVotingRecord,
  UserVoteCommand,
} from '@stark-ballot/domain/types/sessionRecords';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { ApplicationErrorCode, type ApplicationExpectedErrorOf, type Result } from '@stark-ballot/application';

export interface SessionCreationInput extends Omit<SessionIdentityRecord, 'createdAtMs'> {
  createdAtMs: number;
  lastActivityMs: number;
}

export interface SessionRecords {
  identity: SessionIdentityRecord;
  voting: SessionVotingRecord;
}

export interface SessionVoteAuthority extends SessionRecords {
  finalization: FinalizationRecord | null;
}

export type SessionVoteCommand =
  | {
      kind: 'append_user_vote';
      vote: UserVoteCommand;
    }
  | {
      kind: 'append_bot_votes';
      votes: readonly BotVoteCommand[];
    };

export interface SessionMutationDependencies {
  generateVoteId(): string;
  nowMs(): number;
}

interface VoteIndexIntent {
  voteId: string;
  index: number;
}

type SessionVoteMutationBase = {
  nextVoting: SessionVotingRecord;
  indexIntents: VoteIndexIntent[];
};

export type SessionVoteMutation =
  | (SessionVoteMutationBase & {
      kind: 'user_vote_appended';
      castResult: AddVoteResult;
    })
  | { kind: 'user_vote_replayed'; castResult: AddVoteResult }
  | (SessionVoteMutationBase & {
      kind: 'bot_votes_appended';
    });

export type SessionVoteMutationError = ApplicationExpectedErrorOf<
  | typeof ApplicationErrorCode.ALREADY_VOTED
  | typeof ApplicationErrorCode.SESSION_FINALIZED
  | typeof ApplicationErrorCode.DUPLICATE_VOTE
  | typeof ApplicationErrorCode.USER_NOT_VOTED
>;

export type SessionVoteMutationResult = Result<SessionVoteMutation, SessionVoteMutationError>;

function assertNever(value: never): never {
  throw new Error(`Unsupported session vote command: ${JSON.stringify(value)}`);
}

function currentUserVoteIndex(voting: SessionVotingRecord): number | undefined {
  return voting.userParticipation.status === 'cast' ? voting.userParticipation.voteIndex : undefined;
}

function prepareVote(
  identity: SessionIdentityRecord,
  vote: BotVoteCommand,
  mutationIdentity: Pick<UserVoteCommand, 'voteId' | 'timestamp'>,
): PreparedVote {
  const normalizedRandom = normalizeHex(vote.rand, { allowEmpty: true });
  const choiceNumber = vote.vote.charCodeAt(0) - 'A'.charCodeAt(0);

  return {
    ...mutationIdentity,
    vote: vote.vote,
    rand: normalizedRandom,
    commit: computeCommitment(identity.electionId, choiceNumber, normalizedRandom),
  };
}

function buildNextVoting(
  voting: SessionVotingRecord,
  stagedVotes: readonly StagedVoteWrite[],
  next: {
    bulletin: SimpleBulletinBoard;
    bulletinRootHistory: SessionVotingRecord['bulletinRootHistory'];
    botCount: number;
    userVoteIndex: number | undefined;
    lastActivityMs: number;
  },
): SessionVotingRecord {
  const votes = new Map(voting.votes);
  for (const stagedVote of stagedVotes) {
    votes.set(stagedVote.index, stagedVote.storedVote);
  }

  return {
    sessionId: voting.sessionId,
    votes,
    bulletin: next.bulletin,
    bulletinRootHistory: next.bulletinRootHistory,
    botCount: next.botCount,
    userParticipation:
      next.userVoteIndex === undefined
        ? {
            status: 'not_cast',
          }
        : {
            status: 'cast',
            voteIndex: next.userVoteIndex,
          },
    lastActivityMs: next.lastActivityMs,
  };
}

function toIndexIntents(stagedVotes: readonly StagedVoteWrite[]): VoteIndexIntent[] {
  return stagedVotes.map(({ voteId, index }) => ({ voteId, index }));
}

function evaluateUserVoteMutation(
  authority: SessionVoteAuthority,
  vote: UserVoteCommand,
  dependencies: SessionMutationDependencies,
): SessionVoteMutation {
  const preparedVote = prepareVote(authority.identity, vote, vote);
  const voteId = preparedVote.voteId;
  const index = authority.voting.votes.size;
  const staged = stageCtVoteWrites(
    {
      sessionId: authority.identity.sessionId,
      votes: authority.voting.votes,
      bulletin: authority.voting.bulletin,
      bulletinRootHistory: authority.voting.bulletinRootHistory,
    },
    [{ index, vote: preparedVote }],
  );
  const stagedVote = staged.votes[0];
  if (!stagedVote) {
    throw new Error('Finalization state invariant violated');
  }

  let inclusionProof;
  try {
    inclusionProof = staged.bulletin.getInclusionProof(voteId, index + 1);
  } catch {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }
  if (!inclusionProof) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }

  const bulletinRootAtCast = stagedVote.storedVote.rootAtCast;
  if (!bulletinRootAtCast) {
    throw new Error('CT_PROOF_UNAVAILABLE');
  }

  return {
    kind: 'user_vote_appended',
    nextVoting: buildNextVoting(authority.voting, staged.votes, {
      bulletin: staged.bulletin,
      bulletinRootHistory: staged.bulletinRootHistory,
      botCount: authority.voting.botCount,
      userVoteIndex: index,
      lastActivityMs: dependencies.nowMs(),
    }),
    indexIntents: toIndexIntents(staged.votes),
    castResult: {
      leafIndex: index,
      merklePath: inclusionProof.proofNodes.map((node) => normalizeHex(node, { allowEmpty: true })),
      bulletinRootAtCast,
    },
  };
}

function evaluateBotVoteMutation(
  authority: SessionVoteAuthority,
  votes: readonly BotVoteCommand[],
  dependencies: SessionMutationDependencies,
): SessionVoteMutation {
  const userVoteIndex = currentUserVoteIndex(authority.voting);
  assertCanonicalUserVoteIndexForBotVotes(authority.voting.votes, userVoteIndex);
  const projection = buildCanonicalCtSessionProjection({
    sessionId: authority.identity.sessionId,
    votes: authority.voting.votes,
    bulletin: authority.voting.bulletin,
    bulletinRootHistory: authority.voting.bulletinRootHistory,
    userParticipation: authority.voting.userParticipation,
  });
  if (projection.botCount !== authority.voting.botCount) {
    throw new Error('Session voting record bot count is inconsistent');
  }
  const projectedUserVoteIndex =
    projection.userParticipation.status === 'cast' ? projection.userParticipation.voteIndex : undefined;
  assertCanonicalUserVoteIndexForBotVotes(authority.voting.votes, projectedUserVoteIndex);

  const staged = stageCtVoteWrites(
    {
      sessionId: authority.identity.sessionId,
      votes: authority.voting.votes,
      bulletin: projection.bulletin,
      bulletinRootHistory: projection.bulletinRootHistory,
    },
    votes.map((vote, offset) => ({
      index: projection.nextIndex + offset,
      vote: prepareVote(authority.identity, vote, {
        voteId: dependencies.generateVoteId(),
        timestamp: dependencies.nowMs(),
      }),
    })),
  );

  return {
    kind: 'bot_votes_appended',
    nextVoting: buildNextVoting(authority.voting, staged.votes, {
      bulletin: staged.bulletin,
      bulletinRootHistory: staged.bulletinRootHistory,
      botCount: projection.botCount + staged.votes.length,
      userVoteIndex: projectedUserVoteIndex,
      lastActivityMs: dependencies.nowMs(),
    }),
    indexIntents: toIndexIntents(staged.votes),
  };
}

export function buildSessionRecords(input: SessionCreationInput): SessionRecords {
  return {
    identity: {
      sessionId: input.sessionId,
      electionId: input.electionId,
      electionConfigHash: input.electionConfigHash,
      electionConfig: input.electionConfig,
      logId: input.logId,
      createdAtMs: input.createdAtMs,
    },
    voting: {
      sessionId: input.sessionId,
      votes: new Map(),
      bulletin: new SimpleBulletinBoard(input.logId),
      bulletinRootHistory: [],
      botCount: 0,
      userParticipation: { status: 'not_cast' },
      lastActivityMs: input.lastActivityMs,
    },
  };
}

export function evaluateSessionVoteMutation(
  authority: SessionVoteAuthority,
  command: SessionVoteCommand,
  dependencies: SessionMutationDependencies,
): SessionVoteMutationResult {
  if (command.kind === 'append_user_vote') {
    const replay = resolveUserVoteReplay(authority, command.vote);

    if (replay.kind === 'replay') {
      const proof = authority.voting.bulletin.getInclusionProof(replay.vote.voteId, replay.index + 1);
      if (!proof) throw new Error('CT_PROOF_UNAVAILABLE');
      return {
        ok: true,
        value: {
          kind: 'user_vote_replayed',
          castResult: {
            leafIndex: replay.index,
            merklePath: proof.proofNodes.map((node) => normalizeHex(node)),
            bulletinRootAtCast: replay.vote.rootAtCast,
          },
        },
      };
    }
  }
  if (authority.finalization !== null) {
    return { ok: false, error: { code: ApplicationErrorCode.SESSION_FINALIZED } };
  }

  switch (command.kind) {
    case 'append_user_vote':
      return admitNewUserVote(authority, command.vote, dependencies);
    case 'append_bot_votes':
      if (authority.voting.userParticipation.status === 'not_cast') {
        return { ok: false, error: { code: ApplicationErrorCode.USER_NOT_VOTED } };
      }
      if (authority.voting.botCount + command.votes.length > BOT_COUNT) {
        return { ok: false, error: { code: ApplicationErrorCode.ALREADY_VOTED } };
      }
      return { ok: true, value: evaluateBotVoteMutation(authority, command.votes, dependencies) };
    default:
      return assertNever(command);
  }
}

function admitNewUserVote(
  authority: SessionVoteAuthority,
  vote: UserVoteCommand,
  dependencies: SessionMutationDependencies,
): SessionVoteMutationResult {
  const duplicateVoteId = Array.from(authority.voting.votes.values()).some(
    (storedVote) => storedVote.voteId === vote.voteId,
  );
  if (duplicateVoteId) {
    return {
      ok: false,
      error: {
        code: ApplicationErrorCode.DUPLICATE_VOTE,
        details: { duplicateKind: 'voteId' },
      },
    };
  }
  if (authority.voting.userParticipation.status === 'cast' || authority.voting.votes.size > 0) {
    return { ok: false, error: { code: ApplicationErrorCode.ALREADY_VOTED } };
  }
  return { ok: true, value: evaluateUserVoteMutation(authority, vote, dependencies) };
}

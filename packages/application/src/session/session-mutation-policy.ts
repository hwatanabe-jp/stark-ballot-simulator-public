import {
  assertCanonicalUserVoteIndexForBotVotes,
  buildCanonicalCtSessionProjection,
} from '@stark-ballot/domain/bulletin/ctSessionState';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { stageCtVoteWrites, type StagedVoteWrite } from '@stark-ballot/domain/bulletin/stagedCtVoteWrite';
import type {
  AddVoteResult,
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
  VoteData,
} from '@stark-ballot/domain/types/sessionRecords';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';

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
      vote: VoteData;
    }
  | {
      kind: 'append_bot_votes';
      votes: readonly VoteData[];
    };

export interface SessionMutationDependencies {
  generateVoteId(): string;
  nowMs(): number;
}

export interface VoteIndexIntent {
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
  | (SessionVoteMutationBase & {
      kind: 'bot_votes_appended';
    });

function assertNever(value: never): never {
  throw new Error(`Unsupported session vote command: ${JSON.stringify(value)}`);
}

function currentUserVoteIndex(voting: SessionVotingRecord): number | undefined {
  return voting.userParticipation.status === 'cast' ? voting.userParticipation.voteIndex : undefined;
}

function requireWritableVoteAuthority(authority: SessionVoteAuthority): void {
  if (authority.finalization !== null) {
    throw new Error('Session already finalized');
  }
}

function formatVoteData(
  identity: SessionIdentityRecord,
  vote: VoteData,
  dependencies: SessionMutationDependencies,
): VoteData {
  const normalizedRandom = normalizeHex(vote.rand, { allowEmpty: true });
  const choiceNumber = vote.vote.charCodeAt(0) - 'A'.charCodeAt(0);

  return {
    ...vote,
    voteId: vote.voteId ?? dependencies.generateVoteId(),
    rand: normalizedRandom,
    commit: computeCommitment(identity.electionId, choiceNumber, normalizedRandom),
    timestamp: vote.timestamp ?? dependencies.nowMs(),
  };
}

function requireStoredVote(stagedVote: StagedVoteWrite): StoredVoteRecord {
  const vote = stagedVote.storedVote;
  const requiredFields = vote as Partial<Pick<StoredVoteRecord, 'voteId' | 'timestamp' | 'rootAtCast'>>;
  if (!requiredFields.voteId || requiredFields.timestamp === undefined || !requiredFields.rootAtCast) {
    throw new Error('Stored vote invariant violated');
  }
  return {
    voteId: vote.voteId,
    vote: vote.vote,
    rand: vote.rand,
    commit: vote.commit,
    timestamp: vote.timestamp,
    rootAtCast: vote.rootAtCast,
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
    votes.set(stagedVote.index, requireStoredVote(stagedVote));
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
  vote: VoteData,
  dependencies: SessionMutationDependencies,
): SessionVoteMutation {
  const formattedVote = formatVoteData(authority.identity, { ...vote }, dependencies);
  const voteId = formattedVote.voteId;
  if (!voteId) {
    throw new Error('Vote ID missing after formatting');
  }
  if (Array.from(authority.voting.votes.values()).some((storedVote) => storedVote.voteId === voteId)) {
    throw new Error('Vote ID already exists');
  }
  if (authority.voting.userParticipation.status === 'cast' || authority.voting.votes.size > 0) {
    throw new Error('User vote already exists');
  }

  const index = authority.voting.votes.size;
  const staged = stageCtVoteWrites(
    {
      sessionId: authority.identity.sessionId,
      votes: authority.voting.votes,
      bulletin: authority.voting.bulletin,
      bulletinRootHistory: authority.voting.bulletinRootHistory,
    },
    [{ index, vote: formattedVote }],
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
  votes: readonly VoteData[],
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
      vote: formatVoteData(authority.identity, { ...vote }, dependencies),
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
): SessionVoteMutation {
  requireWritableVoteAuthority(authority);

  switch (command.kind) {
    case 'append_user_vote':
      return evaluateUserVoteMutation(authority, command.vote, dependencies);
    case 'append_bot_votes':
      return evaluateBotVoteMutation(authority, command.votes, dependencies);
    default:
      return assertNever(command);
  }
}

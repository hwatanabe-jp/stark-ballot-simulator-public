import {
  evaluateSessionVoteMutation,
  type SessionVoteMutation,
  type SessionVoteCommand,
} from '@stark-ballot/application/session/session-mutation-policy';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  AddVoteResult,
  SessionIdentityRecord,
  SessionVotingRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import { generateVoteId } from '@stark-ballot/domain/vote/voteId';

export interface PreparedVoteWrite<T> {
  value: T;
  mutation: Exclude<SessionVoteMutation, { kind: 'user_vote_replayed' }> | undefined;
}

export function prepareUserVoteWrite(mutation: SessionVoteMutation): PreparedVoteWrite<AddVoteResult> {
  if (mutation.kind === 'user_vote_replayed') return { value: mutation.castResult, mutation: undefined };
  if (mutation.kind !== 'user_vote_appended') throw new Error('Session vote mutation invariant violated');
  return { value: mutation.castResult, mutation };
}

export function prepareBotVoteWrite(mutation: SessionVoteMutation): PreparedVoteWrite<void> {
  if (mutation.kind !== 'bot_votes_appended') throw new Error('Session vote mutation invariant violated');
  return { value: undefined, mutation };
}

export function evaluateStoredVoteCommand(
  identity: SessionIdentityRecord,
  voting: SessionVotingRecord,
  finalization: FinalizationRecord | null,
  command: SessionVoteCommand,
) {
  return evaluateSessionVoteMutation({ identity, voting, finalization }, command, { generateVoteId, nowMs: Date.now });
}

import {
  evaluateFinalizationTransition,
  type FinalizationTransitionCommand,
} from '@stark-ballot/application/finalize/finalization-transition-policy';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import { type VerificationResultRecord } from '@stark-ballot/application/finalize/finalization-result-store';
import {
  parseVerificationObservation,
  parseVerificationObservationWrite,
  type VerificationObservation,
  type VerificationObservationWrite,
} from '@stark-ballot/domain/types/verificationObservation';
import {
  finalizationRecordCodec,
  type FinalizationRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import type { SessionVoteMutation } from '@stark-ballot/application/session/session-mutation-policy';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';

type AppendedVoteMutation = Exclude<SessionVoteMutation, { kind: 'user_vote_replayed' }>;

export function readMappedFinalization(
  sessionId: SessionId,
  currentFinalizationIds: ReadonlyMap<string, string>,
  finalizations: ReadonlyMap<string, unknown>,
): FinalizationRecord | null {
  const finalizationId = currentFinalizationIds.get(sessionId);
  if (!finalizationId) return null;
  const record = finalizationRecordCodec.admit(finalizations.get(`${sessionId}\u0000${finalizationId}`));
  if (!record || record.sessionId !== sessionId || record.finalizationId !== finalizationId) {
    throw new Error('Current finalization record is missing or invalid');
  }
  return record;
}

export function installMappedVoteMutation(
  sessionId: SessionId,
  mutation: AppendedVoteMutation,
  votingRecords: Map<string, SessionVotingRecord>,
  voteIdIndex: Map<string, { sessionId: SessionId; index: number }>,
): void {
  votingRecords.set(sessionId, mutation.nextVoting);
  for (const intent of mutation.indexIntents) voteIdIndex.set(intent.voteId, { sessionId, index: intent.index });
}

export function describeBotVoteAddition(mutation: Extract<SessionVoteMutation, { kind: 'bot_votes_appended' }>) {
  return {
    addedCount: mutation.indexIntents.length,
    totalBotCount: mutation.nextVoting.botCount,
    firstBotIndex: mutation.indexIntents[0]?.index,
    lastBotIndex: mutation.indexIntents.at(-1)?.index,
    bulletinSize: mutation.nextVoting.bulletin.getSize(),
  };
}

export function admitMappedObservation(
  finalizationId: string,
  input: VerificationObservationWrite,
): VerificationObservation {
  const observationWrite = parseVerificationObservationWrite(input);
  if (!observationWrite) throw new Error('Invalid verification observation');
  const requested = parseVerificationObservation({ finalizationId, ...observationWrite });
  if (!requested) throw new Error('Invalid verification observation');
  return requested;
}

export function restoreMappedVerificationSnapshot(
  key: string,
  snapshots: Map<string, VerificationResultRecord | null>,
  records: Map<string, VerificationResultRecord>,
): void {
  const snapshot = snapshots.get(key);
  snapshots.delete(key);
  if (snapshot) records.set(key, snapshot);
  else records.delete(key);
}

export function requireMappedSucceededFinalization(
  record: FinalizationRecord | null,
  finalizationId: FinalizationId,
): FinalizationRecord {
  if (!record || record.finalizationId !== finalizationId || record.state.status !== 'succeeded') {
    throw new Error('Finalization is unavailable for verification');
  }
  return record;
}

function evaluateMappedFinalizationTransition(
  before: FinalizationRecord | null,
  command: FinalizationTransitionCommand,
  evaluatedAtMs: number,
) {
  const outcome = evaluateFinalizationTransition({ authority: { currentRecord: before }, command, evaluatedAtMs });
  if (outcome.kind === 'invalid') throw new Error(`Invalid finalization transition: ${outcome.reason}`);
  return outcome;
}

/** Resolve and admit the semantic command before adapters publish its mapped records. */
export function prepareMappedFinalizationCommand(
  command: FinalizationTransitionCommand,
  currentFinalizationIds: ReadonlyMap<string, string>,
  finalizations: ReadonlyMap<string, unknown>,
) {
  const before = readMappedFinalization(command.sessionId, currentFinalizationIds, finalizations);
  const outcome = evaluateMappedFinalizationTransition(before, command, Date.now());
  let record = before;
  const mutated = outcome.kind === 'applied';
  if (outcome.kind === 'applied') {
    record = finalizationRecordCodec.admit(outcome.mutations.nextRecord) ?? null;
    if (!record) throw new Error('Finalization transition produced an invalid record');
  }
  if (!record) throw new Error(`Finalization transition was not applied: ${outcome.reason}`);
  return { record, mutated, outcome, before };
}

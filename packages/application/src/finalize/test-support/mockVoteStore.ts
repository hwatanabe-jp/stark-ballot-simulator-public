import {
  finalizationRecordCodec,
  type FinalizationRecord,
} from '@stark-ballot/application/finalize/finalization-record';
import {
  parseVerificationResultRecord,
  type VerificationResultRecord,
  type VerificationResultStore,
} from '@stark-ballot/application/finalize/finalization-result-store';
import type {
  FinalizationBitmapRecord,
  FinalizationStore,
} from '@stark-ballot/application/finalize/finalization-store';
import {
  evaluateFinalizationTransition,
  type FinalizationTransitionCommand,
} from '@stark-ballot/application/finalize/finalization-transition-policy';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import type { AddVoteResult } from '@stark-ballot/domain/types/sessionRecords';
import type { ApplicationVoteStore } from '@stark-ballot/application/session/session-vote-store';
import {
  parseVerificationObservationWrite,
  resolveVerificationObservationRecord,
  type VerificationObservation,
} from '@stark-ballot/domain/types/verificationObservation';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export type MockVoteStore = ApplicationVoteStore & FinalizationStore & VerificationResultStore;

const defaultAddVoteResult: AddVoteResult = {
  leafIndex: 0,
  merklePath: [],
  bulletinRootAtCast: `0x${'0'.repeat(64)}`,
};

function buildScopedKey(sessionId: SessionId, finalizationId: string): string {
  return `${sessionId}\u0000${finalizationId}`;
}

/**
 * Creates an in-process test double with exact lifecycle-owned ports.
 *
 * Defaults remain deliberately lightweight; tests can replace any individual
 * capability without inheriting a retired aggregate-session shape.
 */
export function createMockVoteStore(overrides: Partial<MockVoteStore> = {}): MockVoteStore {
  const finalizationRecords = new Map<string, FinalizationRecord>();
  const currentFinalizationIds = new Map<string, FinalizationId>();
  const verificationRecords = new Map<string, VerificationResultRecord>();
  const verificationSnapshots = new Map<string, VerificationResultRecord | null>();
  const observations = new Map<string, VerificationObservation>();
  const bitmapRecords = new Map<string, FinalizationBitmapRecord>();

  function currentFinalization(sessionId: SessionId): FinalizationRecord | null {
    const finalizationId = currentFinalizationIds.get(sessionId);
    if (!finalizationId) {
      return null;
    }
    return finalizationRecordCodec.admit(finalizationRecords.get(buildScopedKey(sessionId, finalizationId))) ?? null;
  }

  function applyFinalizationCommand(command: FinalizationTransitionCommand): FinalizationRecord {
    const current = currentFinalization(command.sessionId);
    const outcome = evaluateFinalizationTransition({
      authority: { currentRecord: current },
      command,
      evaluatedAtMs: Date.now(),
    });
    if (outcome.kind === 'invalid') {
      throw new Error(`Invalid finalization transition: ${outcome.reason}`);
    }
    if (outcome.kind === 'applied') {
      const record = finalizationRecordCodec.admit(outcome.mutations.nextRecord);
      if (!record) {
        throw new Error('Finalization transition produced an invalid record');
      }
      finalizationRecords.set(buildScopedKey(command.sessionId, command.finalizationId), record);
      currentFinalizationIds.set(command.sessionId, command.finalizationId);
      return record;
    }
    if (!current) {
      throw new Error(`Finalization transition was not applied: ${outcome.reason}`);
    }
    return current;
  }

  function requireVerificationRecord(
    sessionId: SessionId,
    finalizationId: FinalizationId,
    verificationResult: VerificationResult,
  ): VerificationResultRecord {
    const record = parseVerificationResultRecord({
      sessionId,
      finalizationId,
      verificationResult,
    });
    if (!record) {
      throw new Error('Invalid verification result record');
    }
    return record;
  }

  const baseStore: MockVoteStore = {
    createSession: () => Promise.reject(new Error('createSession not implemented in mock')),
    getSessionIdentity: () => Promise.resolve(null),
    getVotingRecord: () => Promise.resolve(null),
    getSessionVotingSummary: () => Promise.resolve(null),
    addVote: () => Promise.resolve({ ok: true, value: defaultAddVoteResult }),
    addBotVotes: () => Promise.resolve({ ok: true, value: undefined }),
    touchSession: () => Promise.resolve(),
    getActiveSessionCount: () => Promise.resolve(0),
    getVoteById: () => Promise.resolve(null),
    getVoteByIdWithProof: () => Promise.resolve(null),
    getVoteProof: () => Promise.resolve(null),

    getCurrentFinalizationRecord: (sessionId) => Promise.resolve(currentFinalization(sessionId)),
    getFinalizationRecord: (sessionId, finalizationId) =>
      Promise.resolve(
        finalizationRecordCodec.admit(finalizationRecords.get(buildScopedKey(sessionId, finalizationId))) ?? null,
      ),
    commitSuccessfulFinalization: (input) => {
      const admitted = finalizationRecordCodec.admit(input.record);
      if (!admitted || admitted.state.status !== 'succeeded' || !admitted.finalizationResult) {
        return Promise.reject(new Error('Invalid succeeded finalization record'));
      }
      const publication = input.receipt
        ? {
            receiptHash: `0x${'1'.repeat(64)}`,
            boardIndex: 0,
            timestamp: input.receipt.timestamp,
          }
        : undefined;
      const { finalizationId: _finalizationId, ...authority } = admitted.finalizationResult;
      void _finalizationId;
      const committed = applyFinalizationCommand({
        kind: 'succeed',
        sessionId: admitted.sessionId,
        finalizationId: admitted.finalizationId,
        queuedAtMs: admitted.state.queuedAtMs,
        startedAtMs: admitted.state.startedAtMs,
        completedAtMs: admitted.state.completedAtMs,
        scenarioContext: admitted.scenarioContext,
        finalizationResult: {
          ...authority,
          artifacts: {
            ...authority.artifacts,
            ...(publication ? { receiptPublication: { availability: 'available' as const, publication } } : {}),
          },
        },
      });
      if (committed.state.status !== 'succeeded') {
        return Promise.reject(new Error('Successful finalization commit was not applied'));
      }
      const successful = committed as Extract<FinalizationRecord, { state: { status: 'succeeded' } }>;
      if (input.verificationResult) {
        verificationRecords.set(
          buildScopedKey(admitted.sessionId, admitted.finalizationId),
          requireVerificationRecord(admitted.sessionId, admitted.finalizationId, input.verificationResult),
        );
      }
      if (input.bitmap.availability === 'available') {
        bitmapRecords.set(buildScopedKey(admitted.sessionId, admitted.finalizationId), {
          sessionId: admitted.sessionId,
          finalizationId: admitted.finalizationId,
          ...input.bitmap.data,
        });
      }
      return Promise.resolve({
        record: successful,
        bitmap: input.bitmap,
        ...(publication ? { receiptPublication: publication } : {}),
      });
    },
    markFinalizationQueued: (sessionId, payload) =>
      Promise.resolve(
        applyFinalizationCommand({
          kind: 'queue',
          sessionId,
          finalizationId: payload.finalizationId,
          queuedAtMs: payload.queuedAtMs,
          scenarioContext: payload.scenarioContext,
          ...(payload.observability?.reason ? { reason: payload.observability.reason } : {}),
        }),
      ),
    markFinalizationRunning: (sessionId, payload) =>
      Promise.resolve(
        applyFinalizationCommand({
          kind: 'start',
          sessionId,
          finalizationId: payload.finalizationId,
          queuedAtMs: payload.queuedAtMs,
          startedAtMs: payload.startedAtMs,
          ...(payload.scenarioContext ? { scenarioContext: payload.scenarioContext } : {}),
          ...(payload.observability?.reason ? { reason: payload.observability.reason } : {}),
        }),
      ),
    markFinalizationSucceeded: (sessionId, payload) =>
      Promise.resolve(
        applyFinalizationCommand({
          kind: 'succeed',
          sessionId,
          finalizationId: payload.finalizationId,
          queuedAtMs: payload.queuedAtMs,
          startedAtMs: payload.startedAtMs,
          completedAtMs: payload.completedAtMs,
          finalizationResult: payload.finalizationResult,
          ...(payload.scenarioContext ? { scenarioContext: payload.scenarioContext } : {}),
          ...(payload.observability?.reason ? { reason: payload.observability.reason } : {}),
        }),
      ),
    markFinalizationFailed: (sessionId, payload) =>
      Promise.resolve(
        applyFinalizationCommand(
          payload.error.code === 'USER_CANCELLED'
            ? {
                kind: 'cancel',
                sessionId,
                finalizationId: payload.finalizationId,
                queuedAtMs: payload.queuedAtMs,
                ...(payload.startedAtMs === undefined ? {} : { startedAtMs: payload.startedAtMs }),
                failedAtMs: payload.failedAtMs,
                message: payload.error.message,
                ...(payload.scenarioContext ? { scenarioContext: payload.scenarioContext } : {}),
              }
            : {
                kind: 'fail',
                sessionId,
                finalizationId: payload.finalizationId,
                queuedAtMs: payload.queuedAtMs,
                ...(payload.startedAtMs === undefined ? {} : { startedAtMs: payload.startedAtMs }),
                failedAtMs: payload.failedAtMs,
                error: payload.error,
                ...(payload.scenarioContext ? { scenarioContext: payload.scenarioContext } : {}),
              },
        ),
      ),
    markFinalizationTimedOut: (sessionId, payload) =>
      Promise.resolve(
        applyFinalizationCommand({
          kind: 'time_out',
          sessionId,
          finalizationId: payload.finalizationId,
          queuedAtMs: payload.queuedAtMs,
          ...(payload.startedAtMs === undefined ? {} : { startedAtMs: payload.startedAtMs }),
          timeoutAtMs: payload.timeoutAtMs,
          ...(payload.scenarioContext ? { scenarioContext: payload.scenarioContext } : {}),
        }),
      ),

    getVerificationResultRecord: (sessionId, finalizationId) =>
      Promise.resolve(
        parseVerificationResultRecord(verificationRecords.get(buildScopedKey(sessionId, finalizationId))) ?? null,
      ),
    markVerificationRunning: async (sessionId: SessionId, finalizationId: FinalizationId) => {
      const key = buildScopedKey(sessionId, finalizationId);
      const current = await store.getVerificationResultRecord(sessionId, finalizationId);
      verificationSnapshots.set(key, current);
      const record = requireVerificationRecord(sessionId, finalizationId, {
        status: 'running',
      });
      verificationRecords.set(key, record);
      return record;
    },
    rollbackVerificationResult: (sessionId, finalizationId) => {
      const key = buildScopedKey(sessionId, finalizationId);
      const snapshot = verificationSnapshots.get(key);
      verificationSnapshots.delete(key);
      if (snapshot) {
        verificationRecords.set(key, snapshot);
      } else {
        verificationRecords.delete(key);
      }
      return Promise.resolve();
    },
    completeVerificationResult: (sessionId, finalizationId, verificationResult) => {
      const record = requireVerificationRecord(sessionId, finalizationId, verificationResult);
      verificationRecords.set(buildScopedKey(sessionId, finalizationId), record);
      return Promise.resolve(record);
    },

    recordVerificationObservation: (sessionId, finalizationId, input) => {
      const observationWrite = parseVerificationObservationWrite(input);
      if (!observationWrite) {
        return Promise.reject(new Error('Invalid verification observation'));
      }
      const key = buildScopedKey(sessionId, finalizationId);
      const requested: VerificationObservation = {
        finalizationId,
        ...observationWrite,
      };
      const resolution = resolveVerificationObservationRecord(
        currentFinalizationIds.get(sessionId),
        observations.get(key),
        requested,
      );
      if (resolution.status === 'recorded') {
        observations.set(key, requested);
      }
      return Promise.resolve(resolution);
    },

    getBitmapData: (sessionId, finalizationId) =>
      Promise.resolve(bitmapRecords.get(buildScopedKey(sessionId, finalizationId)) ?? null),
  };

  const store: MockVoteStore = {
    ...baseStore,
    ...overrides,
  };
  return store;
}

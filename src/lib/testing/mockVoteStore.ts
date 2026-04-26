import type { VoteStore } from '@/types/voteStore';
import type { AddVoteResult, FinalizationState, SessionData } from '@/types/server';
const defaultAddVoteResult: AddVoteResult = {
  leafIndex: 0,
  merklePath: [],
  bulletinRootAtCast: `0x${'0'.repeat(64)}`,
};

function buildPendingState(executionId: string, queuedAt: number): FinalizationState {
  return { status: 'pending', executionId, queuedAt };
}

function buildRunningState(executionId: string, queuedAt: number, startedAt: number): FinalizationState {
  return { status: 'running', executionId, queuedAt, startedAt };
}

function buildSucceededState(
  executionId: string,
  queuedAt: number,
  startedAt: number,
  completedAt: number,
  bundleMetadata?: Extract<FinalizationState, { status: 'succeeded' }>['bundleMetadata'],
  stepFunctionsArn?: string,
): FinalizationState {
  return {
    status: 'succeeded',
    executionId,
    queuedAt,
    startedAt,
    completedAt,
    bundleMetadata,
    stepFunctionsArn,
  };
}

function buildFailedState(
  executionId: string,
  queuedAt: number,
  failedAt: number,
  error: Extract<FinalizationState, { status: 'failed' }>['error'],
  startedAt?: number,
  stepFunctionsArn?: string,
): FinalizationState {
  return {
    status: 'failed',
    executionId,
    queuedAt,
    failedAt,
    error,
    startedAt,
    stepFunctionsArn,
  };
}

function buildTimedOutState(
  executionId: string,
  queuedAt: number,
  timeoutAt: number,
  startedAt?: number,
  stepFunctionsArn?: string,
): FinalizationState {
  return {
    status: 'timeout',
    executionId,
    queuedAt,
    timeoutAt,
    startedAt,
    stepFunctionsArn,
  };
}

function normalizeSession(session: SessionData | null): SessionData | null {
  return session;
}

/**
 * Create a VoteStore mock with safe defaults that can be overridden per test.
 */
export function createMockVoteStore(overrides: Partial<VoteStore> = {}): VoteStore {
  const baseStore: VoteStore = {
    createSession: () => Promise.reject(new Error('createSession not implemented in mock')),
    getSession: () => Promise.resolve(null),
    addVote: (sessionId, voteData) => {
      void sessionId;
      void voteData;
      return Promise.resolve(defaultAddVoteResult);
    },
    addBotVotes: (sessionId, votes) => {
      void sessionId;
      void votes;
      return Promise.resolve();
    },
    updateSession: (sessionId, data) => {
      void sessionId;
      void data;
      return Promise.resolve(undefined);
    },
    getActiveSessionCount: () => Promise.resolve(0),
    finalizeSession: (sessionId, result, contractGeneration) => {
      void sessionId;
      void result;
      void contractGeneration;
      return Promise.resolve();
    },
    markFinalizationQueued: (sessionId, payload) => {
      void sessionId;
      void payload.contractGeneration;
      void payload.scenarioContext;
      return Promise.resolve(buildPendingState(payload.executionId, payload.queuedAt));
    },
    markFinalizationRunning: (sessionId, payload) => {
      void sessionId;
      void payload.contractGeneration;
      void payload.scenarioContext;
      return Promise.resolve(buildRunningState(payload.executionId, payload.queuedAt, payload.startedAt));
    },
    markFinalizationSucceeded: (sessionId, payload) => {
      void sessionId;
      void payload.contractGeneration;
      void payload.finalizationResult;
      return Promise.resolve(
        buildSucceededState(
          payload.executionId,
          payload.queuedAt,
          payload.startedAt,
          payload.completedAt,
          payload.bundleMetadata,
          payload.stepFunctionsArn,
        ),
      );
    },
    markFinalizationFailed: (sessionId, payload) => {
      void sessionId;
      void payload.contractGeneration;
      return Promise.resolve(
        buildFailedState(
          payload.executionId,
          payload.queuedAt,
          payload.failedAt,
          payload.error,
          payload.startedAt,
          payload.stepFunctionsArn,
        ),
      );
    },
    markFinalizationTimedOut: (sessionId, payload) => {
      void sessionId;
      void payload.contractGeneration;
      return Promise.resolve(
        buildTimedOutState(
          payload.executionId,
          payload.queuedAt,
          payload.timeoutAt,
          payload.startedAt,
          payload.stepFunctionsArn,
        ),
      );
    },
    getVoteById: () => Promise.resolve(null),
    getVoteByIdWithProof: () => Promise.resolve(null),
    getVoteProof: () => Promise.resolve(null),
  };

  return {
    ...baseStore,
    ...overrides,
    createSession: async () =>
      normalizeSession(
        await (overrides.createSession ? overrides.createSession() : baseStore.createSession()),
      ) as SessionData,
    getSession: async (sessionId) =>
      normalizeSession(
        await (overrides.getSession ? overrides.getSession(sessionId) : baseStore.getSession(sessionId)),
      ),
  };
}

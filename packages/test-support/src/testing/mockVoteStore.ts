import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { AddVoteResult, SessionData } from '@stark-ballot/domain/types/server';
import {
  resolveVerificationObservationRecord,
  type VerificationObservation,
} from '@stark-ballot/domain/types/verificationObservation';
import type { TestFinalizationState as FinalizationState } from '@stark-ballot/test-support/testing/finalization-state';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

type FinalizationQueuedPayload = {
  executionId: string;
  queuedAt: number;
  contractGeneration: string;
};
type FinalizationRunningPayload = FinalizationQueuedPayload & {
  startedAt: number;
};
type FinalizationSucceededPayload = FinalizationRunningPayload & {
  completedAt: number;
  finalizationResult: unknown;
};
type FinalizationFailedPayload = FinalizationQueuedPayload & {
  startedAt?: number;
  failedAt: number;
  error: Extract<FinalizationState, { status: 'failed' }>['error'];
};
type FinalizationTimedOutPayload = FinalizationQueuedPayload & {
  startedAt?: number;
  timeoutAt: number;
};
type RuntimeTransitionMetadata = {
  stepFunctionsArn?: string;
};
type SucceededTransitionMetadata = RuntimeTransitionMetadata & {
  bundleMetadata?: Extract<FinalizationState, { status: 'succeeded' }>['bundleMetadata'];
};
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
    ...omitUndefinedProperties({ startedAt: startedAt }),
    completedAt,
    ...omitUndefinedProperties({ bundleMetadata, stepFunctionsArn: stepFunctionsArn }),
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
    ...omitUndefinedProperties({ startedAt: startedAt }),
    ...omitUndefinedProperties({ stepFunctionsArn: stepFunctionsArn }),
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
    ...omitUndefinedProperties({ startedAt: startedAt }),
    ...omitUndefinedProperties({ stepFunctionsArn: stepFunctionsArn }),
  };
}

function normalizeSession(session: SessionData | null): SessionData | null {
  return session;
}

/**
 * Create a VoteStore mock with safe defaults that can be overridden per test.
 */
type MockFinalizationStore = {
  finalizeSession(sessionId: string, result: unknown, contractGeneration: string, executionId: string): Promise<void>;
  finalizeSessionWithReceiptPublication?(
    sessionId: string,
    result: unknown,
    contractGeneration: string,
    receipt: { receipt: string; timestamp: number },
    executionId: string,
  ): Promise<{ receiptHash: string; boardIndex: number }>;
  updateFinalizationArtifactMetadata(
    sessionId: string,
    metadata: {
      finalizationContractGeneration?: string;
      hasPersistedFinalizationBranch?: boolean;
      finalizationArtifactState?: SessionData['finalizationArtifactState'];
    },
  ): Promise<SessionData | void>;
  markFinalizationQueued(
    sessionId: string,
    payload: FinalizationQueuedPayload & { scenarioContext?: SessionData['finalizationScenarioContext'] | null },
  ): Promise<FinalizationState>;
  markFinalizationRunning(
    sessionId: string,
    payload: FinalizationRunningPayload & { scenarioContext?: SessionData['finalizationScenarioContext'] | null },
  ): Promise<FinalizationState>;
  markFinalizationSucceeded(sessionId: string, payload: FinalizationSucceededPayload): Promise<FinalizationState>;
  markFinalizationFailed(sessionId: string, payload: FinalizationFailedPayload): Promise<FinalizationState>;
  markFinalizationTimedOut(sessionId: string, payload: FinalizationTimedOutPayload): Promise<FinalizationState>;
  markAwsFinalizationRunning(
    sessionId: string,
    payload: FinalizationRunningPayload &
      RuntimeTransitionMetadata & { scenarioContext?: SessionData['finalizationScenarioContext'] | null },
  ): Promise<FinalizationState>;
  markAwsFinalizationSucceeded(
    sessionId: string,
    payload: FinalizationSucceededPayload & SucceededTransitionMetadata,
  ): Promise<FinalizationState>;
  markAwsFinalizationFailed(
    sessionId: string,
    payload: FinalizationFailedPayload & RuntimeTransitionMetadata,
  ): Promise<FinalizationState>;
  markAwsFinalizationTimedOut(
    sessionId: string,
    payload: FinalizationTimedOutPayload & RuntimeTransitionMetadata,
  ): Promise<FinalizationState>;
  saveBitmapData?(
    sessionId: string,
    bitmapData: {
      includedBitmap: boolean[];
      includedBitmapRoot: string;
      seenBitmap?: boolean[];
      seenBitmapRoot?: string;
      treeSize: number;
      finalizedAt: number;
    },
  ): Promise<void>;
  getBitmapData?(sessionId: string): Promise<{
    sessionId: string;
    includedBitmap: boolean[];
    includedBitmapRoot: string;
    seenBitmap?: boolean[];
    seenBitmapRoot?: string;
    treeSize: number;
    finalizedAt: number;
  } | null>;
  repairFinalizationResult(sessionId: string): Promise<void>;
  markVerificationRunning(
    sessionId: string,
    payload: {
      executionId: string;
      report?: unknown;
      verificationWorkQueuedAt?: string;
    },
  ): Promise<void>;
  rollbackVerificationResult(
    sessionId: string,
    payload: {
      executionId: string;
    },
  ): Promise<void>;
  completeVerificationResult(
    sessionId: string,
    payload: {
      executionId: string;
      verificationResult: unknown;
    },
  ): Promise<void>;
  recordAwsProofBundlePublication(
    sessionId: string,
    executionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  recordAwsVerificationDeliveryMetadata(
    sessionId: string,
    executionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
};

export type MockVoteStore = VoteStore & MockFinalizationStore;

export function createMockVoteStore(overrides: Partial<MockVoteStore> = {}): MockVoteStore {
  const observations = new Map<string, VerificationObservation>();
  const baseStore: MockVoteStore = {
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
    recordVerificationObservation: async (sessionId, observation) => {
      const session = await store.getSession(sessionId);
      const finalizationResult = session?.finalizationResult as unknown;
      const currentExecutionId =
        finalizationResult &&
        typeof finalizationResult === 'object' &&
        typeof (finalizationResult as { verificationExecutionId?: unknown }).verificationExecutionId === 'string'
          ? (finalizationResult as { verificationExecutionId: string }).verificationExecutionId
          : undefined;
      const resolution = resolveVerificationObservationRecord(
        currentExecutionId,
        observations.get(sessionId),
        observation,
      );
      if (resolution.status === 'recorded') {
        observations.set(sessionId, structuredClone(observation));
      }
      return resolution;
    },
    repairFinalizationResult: (sessionId) => {
      void sessionId;
      return Promise.resolve();
    },
    markVerificationRunning: (sessionId, payload) => {
      void sessionId;
      void payload;
      return Promise.resolve();
    },
    rollbackVerificationResult: (sessionId, payload) => {
      void sessionId;
      void payload;
      return Promise.resolve();
    },
    completeVerificationResult: (sessionId, payload) => {
      void sessionId;
      void payload;
      return Promise.resolve();
    },
    recordAwsProofBundlePublication: (sessionId, executionId, metadata) => {
      void sessionId;
      void executionId;
      void metadata;
      return Promise.resolve();
    },
    recordAwsVerificationDeliveryMetadata: (sessionId, executionId, metadata) => {
      void sessionId;
      void executionId;
      void metadata;
      return Promise.resolve();
    },
    getActiveSessionCount: () => Promise.resolve(0),
    finalizeSession: (sessionId, result, contractGeneration, executionId) => {
      void sessionId;
      void result;
      void contractGeneration;
      void executionId;
      return Promise.resolve();
    },
    updateFinalizationArtifactMetadata: (sessionId, metadata) => {
      void sessionId;
      void metadata;
      return Promise.resolve(undefined);
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
        buildSucceededState(payload.executionId, payload.queuedAt, payload.startedAt, payload.completedAt),
      );
    },
    markFinalizationFailed: (sessionId, payload) => {
      void sessionId;
      void payload.contractGeneration;
      return Promise.resolve(
        buildFailedState(payload.executionId, payload.queuedAt, payload.failedAt, payload.error, payload.startedAt),
      );
    },
    markFinalizationTimedOut: (sessionId, payload) => {
      void sessionId;
      void payload.contractGeneration;
      return Promise.resolve(
        buildTimedOutState(payload.executionId, payload.queuedAt, payload.timeoutAt, payload.startedAt),
      );
    },
    markAwsFinalizationRunning: (sessionId, payload) => {
      void sessionId;
      void payload.contractGeneration;
      void payload.scenarioContext;
      return Promise.resolve(buildRunningState(payload.executionId, payload.queuedAt, payload.startedAt));
    },
    markAwsFinalizationSucceeded: (sessionId, payload) => {
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
    markAwsFinalizationFailed: (sessionId, payload) => {
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
    markAwsFinalizationTimedOut: (sessionId, payload) => {
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

  const store: MockVoteStore = {
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
  return store;
}

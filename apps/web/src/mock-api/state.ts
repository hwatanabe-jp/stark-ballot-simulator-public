import type { VoteChoice } from '@stark-ballot/web/session/types';
import type { VerificationStatus } from '@stark-ballot/verification/shared/types';
import type { ScenarioId } from './types';

export interface MockState {
  sessionId: string;
  capabilityToken: string;
  electionId: string;
  electionConfigHash: string;
  logId: string;
  animationSeed: string;
  voteChoice?: VoteChoice;
  random?: string;
  commitment?: string;
  voteId?: string;
  bulletinIndex?: number;
  bulletinRootAtCast?: string;
  voteTimestamp?: number;
  botVotingStartedAt?: number;
  scenarioId: ScenarioId;
  finalizationId?: string;
  finalizationQueuedAtMs?: number;
  finalizationStartedAtMs?: number;
  finalizationCompletedAtMs?: number;
  finalizationFailedAtMs?: number;
  finalizationError?: {
    code: string;
    message: string;
  };
  verificationStatus?: VerificationStatus;
  verificationReport?: {
    status: VerificationStatus;
    duration_ms?: number;
    errors?: string[];
  };
  verificationObservation?: {
    finalizationId: string;
    fingerprint: string;
  };
}

const DEFAULT_SESSION_ID = '2b9efb8c-7fb1-41e5-9fc9-0026054eeda6';
const DEFAULT_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

const generateUuid = (fallback: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return fallback;
};

const createHex = (char: string) => `0x${char.repeat(64)}`;

const createInitialState = (): MockState => ({
  sessionId: generateUuid(DEFAULT_SESSION_ID),
  capabilityToken: generateUuid('mock-capability-token'),
  electionId: generateUuid(DEFAULT_ELECTION_ID),
  electionConfigHash: createHex('a'),
  logId: createHex('b'),
  animationSeed: createHex('c').slice(0, 18),
  scenarioId: 'S0',
});

let currentState: MockState | null = null;

export function getMockState(): MockState {
  if (!currentState) {
    currentState = createInitialState();
  }
  return currentState;
}

export function updateMockState(updater: (state: MockState) => void): MockState {
  const state = getMockState();
  updater(state);
  return state;
}

export function resetMockState(): MockState {
  currentState = createInitialState();
  return currentState;
}

export const MOCK_FINALIZATION_DURATION_MS = 20000;

type MockFinalizationStatus = 'pending' | 'running' | 'succeeded' | 'failed';

function resolveMockFinalizationStatus(
  state: MockState,
  now: number,
  startedAtMs: number,
  completedAtMs: number,
): MockFinalizationStatus {
  if (typeof state.finalizationFailedAtMs === 'number') return 'failed';
  if (now < startedAtMs) return 'pending';
  if (now < completedAtMs) return 'running';
  return 'succeeded';
}

export function resolveMockFinalizationTiming(state: MockState, now: number) {
  const queuedAtMs = state.finalizationQueuedAtMs ?? now;
  const startedAtMs = state.finalizationStartedAtMs ?? queuedAtMs + 2000;
  const completedAtMs = state.finalizationCompletedAtMs ?? startedAtMs + MOCK_FINALIZATION_DURATION_MS;
  return {
    queuedAtMs,
    startedAtMs,
    completedAtMs,
    status: resolveMockFinalizationStatus(state, now, startedAtMs, completedAtMs),
  };
}

/** Verification requires an explicitly completed finalization, not an estimated deadline. */
export function hasCompletedMockFinalization(state: MockState, now: number): boolean {
  return (
    typeof state.finalizationCompletedAtMs === 'number' &&
    now >= state.finalizationCompletedAtMs &&
    typeof state.finalizationFailedAtMs !== 'number'
  );
}

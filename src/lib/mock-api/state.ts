import type { VoteChoice } from '@/lib/session/types';
import type { VerificationStatus } from '@/types/server';
import type { ScenarioId } from './types';
import { resolveCurrentContractGeneration } from '@/lib/contract';

export interface MockState {
  sessionId: string;
  capabilityToken: string;
  contractGeneration: string;
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
  finalizationQueuedAt?: number;
  finalizationStartedAt?: number;
  finalizationCompletedAt?: number;
  finalizationFailedAt?: number;
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
  contractGeneration: resolveCurrentContractGeneration(),
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

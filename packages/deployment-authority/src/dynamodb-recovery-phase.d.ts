import type { ImmutableObjectReference } from './index.js';

export const DYNAMODB_RECOVERY_PHASES: readonly [
  'primary_active',
  'primary_quiesced',
  'replacement_quiesced',
  'replacement_active',
];

export type DynamoDbRecoveryPhase = (typeof DYNAMODB_RECOVERY_PHASES)[number];

export interface DynamoDbRecoverySelection {
  readonly phase: DynamoDbRecoveryPhase;
  readonly manifest: ImmutableObjectReference | null;
}

export interface DynamoDbRecoveryPhaseTransitionInput {
  readonly current: DynamoDbRecoverySelection | null;
  readonly requested: DynamoDbRecoverySelection;
}

export interface DynamoDbRecoveryPhaseTransition {
  readonly current: DynamoDbRecoverySelection | null;
  readonly requested: DynamoDbRecoverySelection;
  readonly disposition: 'initial' | 'idempotent' | 'forward' | 'reverse';
  readonly allowedNextPhases: readonly DynamoDbRecoveryPhase[];
}

export function parseDynamoDbRecoveryPhase(value: unknown): DynamoDbRecoveryPhase;
export function validateDynamoDbRecoverySelection(value: unknown): DynamoDbRecoverySelection;
export function evaluateDynamoDbRecoveryPhaseTransition(value: unknown): DynamoDbRecoveryPhaseTransition;

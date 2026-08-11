import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import {
  parseFinalizationResultAuthority,
  parseFinalizationScenarioContext,
  parseFinalizationState,
} from '@stark-ballot/application/finalize/finalization-storage';
import type {
  FinalizationId,
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';

export type FinalizationResultRecord = {
  finalizationId: FinalizationId;
} & FinalizationResultAuthority;

type FinalizationRecordBase = {
  sessionId: string;
  finalizationId: FinalizationId;
  scenarioContext: FinalizationScenarioContext;
};

export type FinalizationRecord =
  | (FinalizationRecordBase & {
      state: Exclude<FinalizationState, { status: 'succeeded' }>;
      finalizationResult?: never;
    })
  | (FinalizationRecordBase & {
      state: Extract<FinalizationState, { status: 'succeeded' }>;
      finalizationResult: FinalizationResultRecord;
    });

const FINALIZATION_RECORD_KEYS = new Set(['sessionId', 'finalizationId', 'scenarioContext', 'state']);
const SUCCEEDED_FINALIZATION_RECORD_KEYS = new Set([
  'sessionId',
  'finalizationId',
  'scenarioContext',
  'state',
  'finalizationResult',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function parseFinalizationResultRecord(value: unknown): FinalizationResultRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const finalizationId = value['finalizationId'];
  if (typeof finalizationId !== 'string' || !isSafeVerifierSegment(finalizationId)) {
    return undefined;
  }
  const authorityValue = { ...value };
  delete authorityValue['finalizationId'];
  const authority = parseFinalizationResultAuthority(authorityValue);
  return authority ? { finalizationId, ...authority } : undefined;
}

/**
 * Admits one current finalization record and binds all nested lifecycle
 * authority to its single finalization identifier.
 */
export function parseFinalizationRecord(value: unknown): FinalizationRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const finalizationId = value['finalizationId'];
  const state = parseFinalizationState(value['state']);
  const scenarioContext = parseFinalizationScenarioContext(value['scenarioContext']);
  if (
    typeof sessionId !== 'string' ||
    !isSafeVerifierSegment(sessionId) ||
    typeof finalizationId !== 'string' ||
    !isSafeVerifierSegment(finalizationId) ||
    !state ||
    state.finalizationId !== finalizationId ||
    !scenarioContext
  ) {
    return undefined;
  }

  if (state.status === 'succeeded') {
    if (!hasExactKeys(value, SUCCEEDED_FINALIZATION_RECORD_KEYS)) {
      return undefined;
    }
    const finalizationResult = parseFinalizationResultRecord(value['finalizationResult']);
    if (!finalizationResult || finalizationResult.finalizationId !== finalizationId) {
      return undefined;
    }
    return {
      sessionId,
      finalizationId,
      scenarioContext,
      state,
      finalizationResult,
    };
  }

  if (!hasExactKeys(value, FINALIZATION_RECORD_KEYS)) {
    return undefined;
  }
  return {
    sessionId,
    finalizationId,
    scenarioContext,
    state,
  };
}

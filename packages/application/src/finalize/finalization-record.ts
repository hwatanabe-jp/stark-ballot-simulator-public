import {
  isNonArrayObject as isRecord,
  hasExactOwnKeys as hasExactKeys,
} from '@stark-ballot/validation/unknown-value-guards';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import {
  admitFinalizationResultAuthority,
  encodeFinalizationResultAuthority,
  parseFinalizationResultAuthority,
  parseFinalizationScenarioContext,
  parseFinalizationState,
  type PersistedFinalizationResultAuthority,
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
  sessionId: SessionId;
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

function parseResultRecordWith(
  value: unknown,
  parseAuthority: (value: unknown) => FinalizationResultAuthority | undefined,
): FinalizationResultRecord | undefined {
  if (!isRecord(value)) return undefined;
  const finalizationId = parseFinalizationId(value['finalizationId']);
  if (!finalizationId) return undefined;
  const authorityValue = { ...value };
  delete authorityValue['finalizationId'];
  const authority = parseAuthority(authorityValue);
  return authority ? { finalizationId, ...authority } : undefined;
}

function parseFinalizationResultRecord(value: unknown): FinalizationResultRecord | undefined {
  return parseResultRecordWith(value, parseFinalizationResultAuthority);
}

function admitFinalizationResultRecord(value: unknown): FinalizationResultRecord | undefined {
  return parseResultRecordWith(value, admitFinalizationResultAuthority);
}

function parseFinalizationRecordIdentity(value: Record<string, unknown>) {
  const rawSessionId = value['sessionId'];
  const sessionId = typeof rawSessionId === 'string' ? asSessionIdOrUndefined(rawSessionId) : undefined;
  const finalizationId = parseFinalizationId(value['finalizationId']);
  const state = parseFinalizationState(value['state']);
  const scenarioContext = parseFinalizationScenarioContext(value['scenarioContext']);
  if (!sessionId || !finalizationId || !state || state.finalizationId !== finalizationId || !scenarioContext)
    return undefined;
  return { sessionId, finalizationId, state, scenarioContext };
}

/**
 * Admits one current finalization record and binds all nested lifecycle
 * authority to its single finalization identifier.
 */
function parseRecordWith(
  value: unknown,
  parseResult: (candidate: unknown) => FinalizationResultRecord | undefined,
): FinalizationRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const identity = parseFinalizationRecordIdentity(value);
  if (!identity) return undefined;
  const { sessionId, finalizationId, state, scenarioContext } = identity;

  if (state.status === 'succeeded') {
    if (!hasExactKeys(value, SUCCEEDED_FINALIZATION_RECORD_KEYS)) {
      return undefined;
    }
    const finalizationResult = parseResult(value['finalizationResult']);
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

function decodeFinalizationRecord(value: unknown): FinalizationRecord | undefined {
  return parseRecordWith(value, parseFinalizationResultRecord);
}

function admitFinalizationRecord(value: unknown): FinalizationRecord | undefined {
  return parseRecordWith(value, admitFinalizationResultRecord);
}

export type PersistedFinalizationResultRecord = {
  finalizationId: FinalizationId;
} & PersistedFinalizationResultAuthority;

export type PersistedFinalizationRecord =
  | (FinalizationRecordBase & {
      state: Exclude<FinalizationState, { status: 'succeeded' }>;
      finalizationResult?: never;
    })
  | (FinalizationRecordBase & {
      state: Extract<FinalizationState, { status: 'succeeded' }>;
      finalizationResult: PersistedFinalizationResultRecord;
    });

function encodeFinalizationRecord(record: FinalizationRecord): PersistedFinalizationRecord {
  if (record.state.status !== 'succeeded') {
    return {
      sessionId: record.sessionId,
      finalizationId: record.finalizationId,
      scenarioContext: record.scenarioContext,
      state: record.state,
    };
  }
  if (!record.finalizationResult) {
    throw new TypeError('Succeeded finalization record is missing its result authority');
  }
  const { finalizationId, ...authority } = record.finalizationResult;
  return {
    ...record,
    finalizationResult: {
      finalizationId,
      ...encodeFinalizationResultAuthority(authority),
    },
  };
}

export const finalizationRecordCodec = {
  decode: decodeFinalizationRecord,
  encode: encodeFinalizationRecord,
  admit: admitFinalizationRecord,
} as const;

export function parseFinalizationRecord(value: unknown): FinalizationRecord | undefined {
  return finalizationRecordCodec.decode(value);
}

function asSessionIdOrUndefined(value: string): SessionId | undefined {
  try {
    return asSessionId(value);
  } catch {
    return undefined;
  }
}

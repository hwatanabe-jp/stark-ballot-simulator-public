import { parseFinalizationRecord, type FinalizationRecord } from './finalization-record';
import type { FinalizationSucceededPayload } from './finalization-store';

export type SuccessfulFinalizationRecord = Extract<FinalizationRecord, { state: { status: 'succeeded' } }>;
export type SuccessfulFinalizationReceipt = { receipt: string; timestamp: number };

export function cloneSuccessfulFinalizationRecord(record: SuccessfulFinalizationRecord): SuccessfulFinalizationRecord {
  return structuredClone(record);
}

export function isSuccessfulFinalizationRecord(
  record: FinalizationRecord | null,
): record is SuccessfulFinalizationRecord {
  return record?.state.status === 'succeeded' && record.finalizationResult !== undefined;
}

export function admitSuccessfulFinalizationReceipt(value: unknown): SuccessfulFinalizationReceipt | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid succeeded finalization receipt publication');
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 2 ||
    !keys.every((key) => key === 'receipt' || key === 'timestamp') ||
    typeof candidate['receipt'] !== 'string' ||
    typeof candidate['timestamp'] !== 'number' ||
    !Number.isSafeInteger(candidate['timestamp']) ||
    candidate['timestamp'] < 0
  ) {
    throw new Error('Invalid succeeded finalization receipt publication');
  }
  return { receipt: candidate['receipt'], timestamp: candidate['timestamp'] };
}

export function admitSuccessfulFinalizationCommitRecord(value: unknown): SuccessfulFinalizationRecord {
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch {
    throw new Error('Invalid succeeded finalization record');
  }
  const record = parseFinalizationRecord(cloned);
  if (!record || record.state.status !== 'succeeded' || !record.finalizationResult) {
    throw new Error('Invalid succeeded finalization record');
  }
  if (record.finalizationResult.receiptPublication !== undefined) {
    throw new Error('Successful finalization commit does not accept pre-populated receipt publication');
  }
  if (record.state.startedAtMs < record.state.queuedAtMs || record.state.completedAtMs < record.state.startedAtMs) {
    throw new Error('Invalid successful finalization lifecycle chronology');
  }
  return record;
}

export function assertDirectSuccessfulFinalizationPayload(payload: FinalizationSucceededPayload): void {
  if (payload.finalizationResult.bitmapData !== undefined) {
    throw new Error('Direct finalization success does not accept embedded bitmap evidence');
  }
  if (payload.finalizationResult.receiptPublication !== undefined) {
    throw new Error('Direct finalization success does not accept embedded receipt publication');
  }
}

export function buildDirectSuccessfulFinalizationCommitRecord(
  sessionId: string,
  payload: FinalizationSucceededPayload,
  current: FinalizationRecord | null,
): SuccessfulFinalizationRecord {
  assertDirectSuccessfulFinalizationPayload(payload);
  return admitSuccessfulFinalizationCommitRecord({
    sessionId,
    finalizationId: payload.finalizationId,
    scenarioContext: payload.scenarioContext ?? current?.scenarioContext,
    state: {
      status: 'succeeded',
      finalizationId: payload.finalizationId,
      queuedAtMs: payload.queuedAtMs,
      startedAtMs: payload.startedAtMs,
      completedAtMs: payload.completedAtMs,
    },
    finalizationResult: {
      ...payload.finalizationResult,
      finalizationId: payload.finalizationId,
    },
  });
}

export function assertSuccessfulFinalizationLifecycleAdmission(
  requested: SuccessfulFinalizationRecord,
  current: FinalizationRecord | null,
): void {
  if (!current) {
    return;
  }
  if (
    current.finalizationId !== requested.finalizationId ||
    (current.state.status !== 'pending' && current.state.status !== 'running' && current.state.status !== 'succeeded')
  ) {
    throw new Error('Stale successful finalization commit');
  }
  if (current.state.status === 'succeeded') {
    return;
  }
  if (
    current.state.queuedAtMs !== requested.state.queuedAtMs ||
    JSON.stringify(current.scenarioContext) !== JSON.stringify(requested.scenarioContext) ||
    (current.state.status === 'running' && current.state.startedAtMs !== requested.state.startedAtMs)
  ) {
    throw new Error('Successful finalization commit does not match current lifecycle authority');
  }
}

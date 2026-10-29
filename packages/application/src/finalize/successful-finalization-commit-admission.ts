import { admitFinalizationBitmapDisposition } from './finalization-bitmap-admission';
import { parseVerificationResultRecord } from './finalization-result-store';
import type { SuccessfulFinalizationCommitInput, SuccessfulFinalizationCommitResult } from './finalization-store';
import { finalizationRecordCodec, type FinalizationRecord } from './finalization-record';
import { buildFinalizationCommand, type FinalizationSucceededPayload } from './finalization-store';
import { evaluateFinalizationTransition } from './finalization-transition-policy';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import { admitFinalizationResultAuthority } from './finalization-storage';

export type SuccessfulFinalizationRecord = Extract<FinalizationRecord, { state: { status: 'succeeded' } }>;
export type SuccessfulFinalizationReceipt = { receipt: string; timestamp: number };

export function cloneSuccessfulFinalizationRecord(record: SuccessfulFinalizationRecord): SuccessfulFinalizationRecord {
  return structuredClone(record);
}

export function isSuccessfulFinalizationRecord(
  record: FinalizationRecord | null | undefined,
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
  const record = finalizationRecordCodec.admit(cloned);
  if (!record || record.state.status !== 'succeeded' || !record.finalizationResult) {
    throw new Error('Invalid succeeded finalization record');
  }
  if (record.finalizationResult.artifacts.receiptPublication.availability === 'available') {
    throw new Error('Successful finalization commit does not accept pre-populated receipt publication');
  }
  if (record.state.startedAtMs < record.state.queuedAtMs || record.state.completedAtMs < record.state.startedAtMs) {
    throw new Error('Invalid successful finalization lifecycle chronology');
  }
  return record;
}

export function assertDirectSuccessfulFinalizationPayload(payload: FinalizationSucceededPayload): void {
  const result = admitFinalizationResultAuthority(payload.finalizationResult);
  if (!result) {
    return;
  }
  if (result.artifacts.bitmap.availability === 'available') {
    throw new Error('Direct finalization success does not accept embedded bitmap evidence');
  }
  if (result.artifacts.receiptPublication.availability === 'available') {
    throw new Error('Direct finalization success does not accept embedded receipt publication');
  }
}

function buildDirectSuccessfulFinalizationCommitRecord(
  sessionId: SessionId,
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

/** Select the same direct-success path for all stores before adapter persistence. */
export function prepareDirectSuccessfulFinalization(
  sessionId: SessionId,
  payload: FinalizationSucceededPayload,
  current: FinalizationRecord | null,
  evaluatedAtMs: number,
) {
  const command = buildFinalizationCommand(sessionId, 'succeed', payload);
  const admission = evaluateFinalizationTransition({
    authority: { currentRecord: current },
    command,
    evaluatedAtMs,
  });
  if (admission.kind === 'invalid') throw new Error(`Invalid finalization transition: ${admission.reason}`);
  if (
    current &&
    (current.finalizationId !== payload.finalizationId ||
      current.state.status === 'failed' ||
      current.state.status === 'timeout')
  ) {
    return { kind: 'transition' as const, command };
  }
  return {
    kind: 'commit' as const,
    record: buildDirectSuccessfulFinalizationCommitRecord(sessionId, payload, current),
  };
}

/** Admit evidence in lifecycle order, before any adapter writes. */
export function admitSuccessfulFinalizationEvidence(
  requested: SuccessfulFinalizationRecord,
  input: SuccessfulFinalizationCommitInput,
) {
  const bitmap = admitFinalizationBitmapDisposition(requested, input.bitmap);
  const receipt = admitSuccessfulFinalizationReceipt(input.receipt);
  const verification = input.verificationResult
    ? parseVerificationResultRecord({
        sessionId: requested.sessionId,
        finalizationId: requested.finalizationId,
        verificationResult: input.verificationResult,
      })
    : undefined;
  if (input.verificationResult && !verification) {
    throw new Error('Invalid verification result record');
  }
  return { bitmap, receipt, verification };
}

export function buildPublishedSuccessfulFinalization(
  requested: SuccessfulFinalizationRecord,
  receiptPublication: SuccessfulFinalizationCommitResult['receiptPublication'],
): SuccessfulFinalizationRecord {
  const committed = finalizationRecordCodec.admit({
    ...requested,
    finalizationResult: {
      ...requested.finalizationResult,
      artifacts: {
        ...requested.finalizationResult.artifacts,
        ...(receiptPublication
          ? { receiptPublication: { availability: 'available' as const, publication: receiptPublication } }
          : {}),
      },
    },
  });
  if (!isSuccessfulFinalizationRecord(committed)) {
    throw new Error('Invalid successful finalization commit');
  }
  return committed;
}

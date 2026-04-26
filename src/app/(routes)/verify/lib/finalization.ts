import type { FinalizationState } from '@/types/server';
import { getStringProperty, isRecord } from '@/lib/utils/guards';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const isFinalizationState = (value: unknown): value is FinalizationState => {
  if (!isRecord(value)) {
    return false;
  }

  const status = value.status;
  if (typeof status !== 'string') {
    return false;
  }

  if (!isFiniteNumber(value.queuedAt) || typeof value.executionId !== 'string') {
    return false;
  }

  if (typeof value.stepFunctionsArn !== 'undefined' && typeof value.stepFunctionsArn !== 'string') {
    return false;
  }

  if (status === 'pending') {
    return true;
  }

  if (status === 'running') {
    return isFiniteNumber(value.startedAt);
  }

  if (status === 'succeeded') {
    return isFiniteNumber(value.startedAt) && isFiniteNumber(value.completedAt);
  }

  if (status === 'failed') {
    if (!isFiniteNumber(value.failedAt)) {
      return false;
    }
    if (!isRecord(value.error)) {
      return false;
    }
    return Boolean(getStringProperty(value.error, 'code') && getStringProperty(value.error, 'message'));
  }

  if (status === 'timeout') {
    return isFiniteNumber(value.timeoutAt);
  }

  return false;
};

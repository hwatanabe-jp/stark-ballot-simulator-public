import { describe, expect, it } from 'vitest';
import { parseFinalizationStateUpdatePayload } from './finalizationStateUpdateAdmission';

const basePayload = {
  sessionId: 'session-running-admission',
  executionId: 'exec-running-admission',
  contractGeneration: '2026-04-zkvm-current-v1',
  queuedAt: 1_700_000_000_000,
};

describe('parseFinalizationStateUpdatePayload', () => {
  it('accepts RUNNING updates with required lifecycle fields and Step Functions runtime metadata', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'RUNNING',
        startedAt: 1_700_000_001_000,
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-running-admission',
      }),
    ).toEqual({
      ...basePayload,
      status: 'RUNNING',
      startedAt: 1_700_000_001_000,
      runtimeMetadata: {
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-running-admission',
      },
    });
  });

  it('rejects RUNNING updates without startedAt', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'RUNNING',
      }),
    ).toBeUndefined();
  });

  it('rejects RUNNING updates whose startedAt is before queuedAt', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'RUNNING',
        startedAt: basePayload.queuedAt - 1,
      }),
    ).toBeUndefined();
  });

  it('continues to reject SUCCEEDED updates without a canonical finalizationResult', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'SUCCEEDED',
        startedAt: 1_700_000_001_000,
        completedAt: 1_700_000_002_000,
      }),
    ).toBeUndefined();
  });
});

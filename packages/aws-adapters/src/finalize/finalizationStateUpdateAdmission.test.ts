import { describe, expect, it } from 'vitest';
import { parseFinalizationStateUpdatePayload } from './finalizationStateUpdateAdmission';

const basePayload = {
  sessionId: 'session-running-admission',
  finalizationId: 'exec-running-admission',
  queuedAtMs: 1_700_000_000_000,
};

describe('parseFinalizationStateUpdatePayload', () => {
  it('accepts RUNNING updates with required lifecycle fields and Step Functions runtime metadata', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'RUNNING',
        startedAtMs: 1_700_000_001_000,
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-running-admission',
      }),
    ).toEqual({
      ...basePayload,
      status: 'RUNNING',
      startedAtMs: 1_700_000_001_000,
      runtimeMetadata: {
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-running-admission',
      },
    });
  });

  it('rejects RUNNING updates without startedAtMs', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'RUNNING',
      }),
    ).toBeUndefined();
  });

  it('rejects RUNNING updates whose startedAtMs is before queuedAtMs', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'RUNNING',
        startedAtMs: basePayload.queuedAtMs - 1,
      }),
    ).toBeUndefined();
  });

  it('continues to reject SUCCEEDED updates without a canonical finalizationResult', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'SUCCEEDED',
        startedAtMs: 1_700_000_001_000,
        completedAtMs: 1_700_000_002_000,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['PROVER_TASK_FAILED', 'Target prover task failed', 'prover_execution'],
    ['PROVER_IMAGE_SIGNATURE_FAILED', 'Target prover image signature verification failed', 'image_signature'],
    ['PROVER_CAPACITY_WAIT_TIMEOUT', 'Timed out waiting for target prover capacity', 'capacity'],
    ['FINALIZATION_BUNDLE_KEY_MISSING', 'Target finalization succeeded without a durable bundle key', 'artifact'],
    ['FINALIZATION_BUNDLE_RESTORE_FAILED', 'Target finalization bundle could not be restored', 'artifact'],
  ])('maps %s to a fixed bounded failure tuple', (code, message, category) => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'FAILED',
        failedAtMs: 1_700_000_002_000,
        error: {
          code,
          message: 'untrusted callback message with internal data',
          category: 'untrusted-category',
          details: {
            Error: 'States.TaskFailed',
            Cause: 'private raw AWS cause',
          },
        },
      }),
    ).toEqual({
      ...basePayload,
      status: 'FAILED',
      failedAtMs: 1_700_000_002_000,
      error: {
        code,
        message,
        category,
      },
    });
  });

  it('rejects unknown FAILED codes instead of silently changing their meaning', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'FAILED',
        failedAtMs: 1_700_000_002_000,
        error: {
          code: 'States.TaskFailed',
          message: 'untrusted callback message with internal data',
          details: {
            Cause: 'private raw AWS cause',
          },
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    'configuration',
    'input',
    'prover_execution',
    'infrastructure_interruption',
    'artifact',
    'upload',
    'timeout',
    'unknown',
  ] as const)('surfaces the admitted prover failure marker category %s without carrying marker details', (category) => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'FAILED',
        failedAtMs: 1_700_000_002_000,
        error: {
          code: 'PROVER_TASK_FAILED',
          message: 'Target prover task failed',
          category,
          details: { stderr: 'private verifier output', path: '/tmp/private-input.json' },
        },
      }),
    ).toEqual({
      ...basePayload,
      status: 'FAILED',
      failedAtMs: 1_700_000_002_000,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        category,
      },
    });
  });

  it('rejects a failed update that omits its required error tuple', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'FAILED',
        failedAtMs: 1_700_000_002_000,
      }),
    ).toBeUndefined();
  });

  it.each([
    ['RUNNING', { startedAtMs: 1_700_000_001_000, failedAtMs: 1_700_000_002_000 }],
    [
      'FAILED',
      {
        failedAtMs: 1_700_000_002_000,
        completedAtMs: 1_700_000_002_000,
        error: { code: 'FINALIZATION_FAILED', message: 'Finalization failed' },
      },
    ],
    ['TIMED_OUT', { timeoutAtMs: 1_700_000_002_000, error: { code: 'FINALIZATION_FAILED', message: 'failed' } }],
  ] as const)('rejects %s updates carrying fields owned by another status', (status, fields) => {
    expect(parseFinalizationStateUpdatePayload({ ...basePayload, status, ...fields })).toBeUndefined();
  });

  it('rejects the retired repository generation marker', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        contractGeneration: 'retired-generation',
        status: 'RUNNING',
        startedAtMs: 1_700_000_001_000,
      }),
    ).toBeUndefined();
  });
});

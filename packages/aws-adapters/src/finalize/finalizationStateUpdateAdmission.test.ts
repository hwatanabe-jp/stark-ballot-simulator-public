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
        failedAt: 1_700_000_002_000,
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
      failedAt: 1_700_000_002_000,
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
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        category,
      },
    });
  });

  it('supplies the fixed generic tuple when a failed update omits error input', () => {
    expect(
      parseFinalizationStateUpdatePayload({
        ...basePayload,
        status: 'FAILED',
      }),
    ).toEqual({
      ...basePayload,
      status: 'FAILED',
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'Finalization failed',
        category: 'unknown',
      },
    });
  });
});

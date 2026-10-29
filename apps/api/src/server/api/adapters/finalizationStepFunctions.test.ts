import { StopExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localRuntimeProfile,
  targetRuntimeProfile,
} from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { _setStepFunctionsClient, stopFinalizationExecution } from './finalizationStepFunctions';

describe('finalizationStepFunctions adapter', () => {
  const profile = targetRuntimeProfile();

  afterEach(() => {
    _setStepFunctionsClient(null);
  });

  it('stops the supplied execution ARN with StopExecutionCommand', async () => {
    const executionArn =
      'arn:aws:states:ap-northeast-1:123456789012:execution:stark-ballot-simulator-test-finalization:exec-1';
    const send = vi.fn((command: unknown) => {
      expect(command).toBeInstanceOf(StopExecutionCommand);
      expect(command).toMatchObject({
        input: { executionArn, cause: 'Cancelled' },
      });
      return Promise.resolve({
        status: 'RUNNING',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      });
    });
    _setStepFunctionsClient({ send } as unknown as SFNClient);

    await expect(stopFinalizationExecution(profile, executionArn, 'Cancelled')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates ExecutionDoesNotExist from StopExecution', async () => {
    const executionArn =
      'arn:aws:states:ap-northeast-1:123456789012:execution:stark-ballot-simulator-test-finalization:missing';
    const error = new Error('Execution Does Not Exist');
    error.name = 'ExecutionDoesNotExist';
    const send = vi.fn((command: unknown) => {
      expect(command).toBeInstanceOf(StopExecutionCommand);
      return Promise.reject(error);
    });
    _setStepFunctionsClient({ send } as unknown as SFNClient);

    await expect(stopFinalizationExecution(profile, executionArn, 'Cancelled')).rejects.toMatchObject({
      name: 'ExecutionDoesNotExist',
      message: 'Execution Does Not Exist',
    });
  });

  it('rejects Step Functions construction for a local runtime profile', async () => {
    await expect(stopFinalizationExecution(localRuntimeProfile(), 'local-execution', 'Cancelled')).rejects.toThrow(
      'Step Functions requires a target AWS runtime profile',
    );
  });
});

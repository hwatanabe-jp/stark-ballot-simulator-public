import { DescribeExecutionCommand, type SFNClient } from '@aws-sdk/client-sfn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setStepFunctionsClient, describeFinalizationExecution } from './finalizationStepFunctions';

describe('finalizationStepFunctions adapter', () => {
  afterEach(() => {
    _setStepFunctionsClient(null);
  });

  it('describes the supplied execution ARN with DescribeExecutionCommand', async () => {
    const executionArn =
      'arn:aws:states:ap-northeast-1:123456789012:execution:stark-ballot-simulator-test-finalization:exec-1';
    const send = vi.fn((command: unknown) => {
      expect(command).toBeInstanceOf(DescribeExecutionCommand);
      expect(command).toMatchObject({
        input: { executionArn },
      });
      return Promise.resolve({
        status: 'RUNNING',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      });
    });
    _setStepFunctionsClient({ send } as unknown as SFNClient);

    await expect(describeFinalizationExecution(executionArn)).resolves.toEqual({
      status: 'RUNNING',
      startTime: Date.parse('2026-01-01T00:00:00.000Z'),
      stopTime: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates ExecutionDoesNotExist from DescribeExecution', async () => {
    const executionArn =
      'arn:aws:states:ap-northeast-1:123456789012:execution:stark-ballot-simulator-test-finalization:missing';
    const error = new Error('Execution Does Not Exist');
    error.name = 'ExecutionDoesNotExist';
    const send = vi.fn((command: unknown) => {
      expect(command).toBeInstanceOf(DescribeExecutionCommand);
      return Promise.reject(error);
    });
    _setStepFunctionsClient({ send } as unknown as SFNClient);

    await expect(describeFinalizationExecution(executionArn)).rejects.toMatchObject({
      name: 'ExecutionDoesNotExist',
      message: 'Execution Does Not Exist',
    });
  });
});

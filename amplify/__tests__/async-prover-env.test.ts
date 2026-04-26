/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { resolveRequiredAsyncProverArns } from '../lib/async-prover-env';

describe('resolveRequiredAsyncProverArns', () => {
  it('returns the explicit async prover ARNs', () => {
    expect(
      resolveRequiredAsyncProverArns({
        PROVER_STATE_MACHINE_ARN:
          ' arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-prover-dispatcher-develop ',
        PROVER_WORK_QUEUE_ARN: ' arn:aws:sqs:ap-northeast-1:123456789012:stark-ballot-simulator-prover-work-develop ',
      }),
    ).toEqual({
      stateMachineArn:
        'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-prover-dispatcher-develop',
      queueArn: 'arn:aws:sqs:ap-northeast-1:123456789012:stark-ballot-simulator-prover-work-develop',
    });
  });

  it('throws when the state machine ARN is missing', () => {
    expect(() =>
      resolveRequiredAsyncProverArns({
        PROVER_WORK_QUEUE_ARN: 'arn:aws:sqs:ap-northeast-1:123456789012:stark-ballot-simulator-prover-work-develop',
      }),
    ).toThrow('Missing required async prover environment variables: PROVER_STATE_MACHINE_ARN');
  });

  it('throws when the queue ARN is blank', () => {
    expect(() =>
      resolveRequiredAsyncProverArns({
        PROVER_STATE_MACHINE_ARN:
          'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-prover-dispatcher-develop',
        PROVER_WORK_QUEUE_ARN: '   ',
      }),
    ).toThrow('Missing required async prover environment variables: PROVER_WORK_QUEUE_ARN');
  });

  it('throws when both async prover ARNs are missing', () => {
    expect(() => resolveRequiredAsyncProverArns({})).toThrow(
      'Missing required async prover environment variables: PROVER_STATE_MACHINE_ARN, PROVER_WORK_QUEUE_ARN',
    );
  });
});

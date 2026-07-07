import { describe, expect, it } from 'vitest';
import type { AwsFinalizationRuntimeState } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { projectFinalizationStateForPublicResponse } from './finalizationStateProjection';

describe('projectFinalizationStateForPublicResponse', () => {
  it('removes private provider and callback details from public failed states', () => {
    const state: AwsFinalizationRuntimeState = {
      status: 'failed',
      executionId: 'exec-123',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      failedAt: 1730000005000,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-123',
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'Finalization failed',
        details: {
          bundleKey: 'private/proofs/input.json',
          reportKey: 'private/reports/verification.json',
          capabilityToken: 'capability-token-must-not-leak',
          stack: 'Error: private failure\n    at run (/var/task/index.js:1:1)',
        },
      },
    };

    expect(projectFinalizationStateForPublicResponse(state)).toEqual({
      status: 'failed',
      executionId: 'exec-123',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      failedAt: 1730000005000,
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'Finalization failed',
      },
    });
  });

  it('removes private bundle metadata from public succeeded states', () => {
    const state: AwsFinalizationRuntimeState = {
      status: 'succeeded',
      executionId: 'exec-123',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      completedAt: 1730000005000,
      bundleMetadata: {
        s3BundleKey: 'private/proofs/bundle.zip',
        s3UploadedAt: '2026-01-01T00:00:00.000Z',
      },
    };

    expect(projectFinalizationStateForPublicResponse(state)).toEqual({
      status: 'succeeded',
      executionId: 'exec-123',
      queuedAt: 1730000000000,
      startedAt: 1730000001000,
      completedAt: 1730000005000,
    });
  });
});

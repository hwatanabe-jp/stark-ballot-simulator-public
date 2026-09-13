import { describe, expect, it } from 'vitest';
import type { AwsFinalizationRuntimeState } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { projectFinalizationResultForPublicResponse } from './finalizationResultProjection';
import { projectFinalizationResourceForPublicResponse } from './finalizationStateProjection';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';

const FINALIZATION_ID = asFinalizationId('exec-123');

describe('projectFinalizationResourceForPublicResponse', () => {
  it('removes private provider and callback details from public failed states', () => {
    const state: AwsFinalizationRuntimeState = {
      status: 'failed',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: 1730000000000,
      startedAtMs: 1730000001000,
      failedAtMs: 1730000005000,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-123',
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'Finalization failed',
        category: 'unknown',
        details: {
          bundleKey: 'private/proofs/input.json',
          reportKey: 'private/reports/verification.json',
          capabilityToken: 'capability-token-must-not-leak',
          stack: 'Error: private failure\n    at run (/var/task/index.js:1:1)',
        },
      },
    };

    expect(
      projectFinalizationResourceForPublicResponse({
        state,
        runtimeDiagnostics: { asyncMode: 'enabled' },
      }),
    ).toEqual({
      status: 'failed',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: 1730000000000,
      runtimeDiagnostics: { asyncMode: 'enabled' },
      startedAtMs: 1730000001000,
      failedAtMs: 1730000005000,
      error: {
        code: 'FINALIZATION_FAILED',
        message: 'Finalization failed',
      },
    });
  });

  it('removes private bundle metadata from public succeeded states', () => {
    const state: AwsFinalizationRuntimeState = {
      status: 'succeeded',
      finalizationId: FINALIZATION_ID,
      queuedAtMs: 1730000000000,
      startedAtMs: 1730000001000,
      completedAtMs: 1730000005000,
      bundleMetadata: {
        s3BundleKey: 'private/proofs/bundle.zip',
        s3UploadedAtMs: 1767225600000,
      },
    };
    const result = projectFinalizationResultForPublicResponse(
      buildFinalizationResultFromJournal({
        journal: createTestJournal(),
        imageId: `0x${'12'.repeat(32)}`,
      }),
    );

    expect(
      projectFinalizationResourceForPublicResponse({
        state,
        runtimeDiagnostics: { asyncMode: 'enabled' },
        result,
      }),
    ).toEqual({
      status: 'succeeded',
      finalizationId: 'exec-123',
      queuedAtMs: 1730000000000,
      runtimeDiagnostics: { asyncMode: 'enabled' },
      startedAtMs: 1730000001000,
      completedAtMs: 1730000005000,
      result,
    });
  });
});

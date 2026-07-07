import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver', () => ({
  ensureAwsRuntimeConfigReferencesLoaded: vi.fn(async () => await Promise.resolve(undefined)),
}));

vi.mock('@stark-ballot/runtime-config/env/validate', () => ({
  validateEnv: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(() => ({ kind: 'mock-store' })),
}));

vi.mock('@stark-ballot/aws-adapters/finalize/applyFinalizationStateUpdate', () => ({
  applyAwsFinalizationStateUpdatePayload: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission', () => ({
  parseFinalizationStateUpdatePayload: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/finalize/async-prover-artifacts', () => ({
  buildAsyncProverArtifactKeys: vi.fn((sessionId: string, executionId: string) => ({
    inputS3Key: `sessions/${sessionId}/${executionId}/input.json`,
    outputS3Prefix: `sessions/${sessionId}/${executionId}/`,
    bundleS3Key: `sessions/${sessionId}/${executionId}/bundle.zip`,
  })),
  buildFinalizationResultFromS3Bundle: vi.fn(),
  validateAsyncProverBundleKey: vi.fn((sessionId: string, executionId: string, bundleS3Key: string) => {
    const expected = `sessions/${sessionId}/${executionId}/bundle.zip`;
    if (bundleS3Key !== expected) {
      throw new Error('Async prover bundle key must match the canonical session/execution S3 layout');
    }
    return expected;
  }),
}));

const callbackModule = await import('@stark-ballot/aws-adapters/finalize/applyFinalizationStateUpdate');
const admissionModule = await import('@stark-ballot/aws-adapters/finalize/finalizationStateUpdateAdmission');
const artifactsModule = await import('@stark-ballot/aws-adapters/finalize/async-prover-artifacts');
const envModule = await import('@stark-ballot/runtime-config/env/validate');
const { handler } = await import('./handler');

describe('target finalization-writer handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invalid direct callback payloads so Step Functions observes failure', async () => {
    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockReturnValue(undefined);

    await expect(handler({ malformed: true })).rejects.toThrow('Invalid direct finalize callback event');
  });

  it('validates target env before restoring a successful S3 bundle', async () => {
    const envError = new Error('ALLOW_INSECURE_ZKVM is not allowed when TARGET_AWS_RUNTIME=1');

    vi.mocked(envModule.validateEnv).mockImplementationOnce(() => {
      throw envError;
    });

    await expect(
      handler({
        status: 'SUCCEEDED',
        executionArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
        payload: {
          sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
          executionId: '01HVN5WA1CEH94868G90QGJ7HX',
          contractGeneration: '2026-04-zkvm-current-v1',
          queuedAt: 1_700_000_000_000,
        },
      }),
    ).rejects.toThrow(envError);

    expect(artifactsModule.buildFinalizationResultFromS3Bundle).not.toHaveBeenCalled();
    expect(admissionModule.parseFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    expect(callbackModule.applyAwsFinalizationStateUpdatePayload).not.toHaveBeenCalled();
  });

  it('marks successful prover callbacks failed when durable bundle restoration fails', async () => {
    const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
    const executionId = '01HVN5WA1CEH94868G90QGJ7HX';
    const queuedAt = 1_700_000_000_000;
    const failedPayload = {
      sessionId,
      executionId,
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'FAILED' as const,
      queuedAt,
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
      error: {
        code: 'FINALIZATION_BUNDLE_RESTORE_FAILED',
        message: 'Target finalization bundle could not be restored',
      },
    };
    const failedState = { status: 'failed' } as Awaited<
      ReturnType<typeof callbackModule.applyAwsFinalizationStateUpdatePayload>
    >['state'];
    const expectedRestoreError: unknown = expect.objectContaining({
      code: 'FINALIZATION_BUNDLE_RESTORE_FAILED',
      message: 'Target finalization bundle could not be restored',
    });

    vi.mocked(artifactsModule.buildFinalizationResultFromS3Bundle).mockRejectedValue(new Error('bundle missing'));
    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockImplementation((payload) => {
      expect(payload).toEqual(
        expect.objectContaining({
          sessionId,
          executionId,
          queuedAt,
          status: 'FAILED',
          error: expectedRestoreError,
        }),
      );
      return failedPayload;
    });
    vi.mocked(callbackModule.applyAwsFinalizationStateUpdatePayload).mockResolvedValue({
      sessionId,
      state: failedState,
    });

    await expect(
      handler({
        status: 'SUCCEEDED',
        executionArn: failedPayload.stepFunctionsArn,
        payload: {
          sessionId,
          executionId,
          contractGeneration: failedPayload.contractGeneration,
          queuedAt,
        },
      }),
    ).resolves.toEqual({
      status: 'success',
      sessionId,
      state: failedState,
    });
  });

  it('rejects store update failures instead of returning an error payload', async () => {
    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockReturnValue({
      sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'FAILED',
      queuedAt: 1_700_000_000_000,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
      },
    });
    vi.mocked(callbackModule.applyAwsFinalizationStateUpdatePayload).mockRejectedValue(new Error('update failed'));

    await expect(handler({ status: 'FAILED', payload: { sessionId: 'ignored' } })).rejects.toThrow('update failed');
  });

  it('rejects callback-supplied foreign bundle keys before restoring artifacts', async () => {
    const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
    const executionId = '01HVN5WA1CEH94868G90QGJ7HX';

    await expect(
      handler({
        status: 'SUCCEEDED',
        executionArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
        payload: {
          sessionId,
          executionId,
          contractGeneration: '2026-04-zkvm-current-v1',
          queuedAt: 1_700_000_000_000,
          bundleS3Key: `sessions/9f61dd4f-3194-4a79-a00f-9025062c8e83/${executionId}/bundle.zip`,
        },
      }),
    ).rejects.toThrow('Async prover bundle key must match the canonical session/execution S3 layout');

    expect(artifactsModule.buildFinalizationResultFromS3Bundle).not.toHaveBeenCalled();
    expect(admissionModule.parseFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    expect(callbackModule.applyAwsFinalizationStateUpdatePayload).not.toHaveBeenCalled();
  });

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe execution id %s before deriving default bundle keys',
    async (executionId) => {
      await expect(
        handler({
          status: 'SUCCEEDED',
          executionArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
          payload: {
            sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
            executionId,
            contractGeneration: '2026-04-zkvm-current-v1',
            queuedAt: 1_700_000_000_000,
          },
        }),
      ).rejects.toThrow(/safe single path segment/);

      expect(artifactsModule.buildAsyncProverArtifactKeys).not.toHaveBeenCalled();
      expect(artifactsModule.buildFinalizationResultFromS3Bundle).not.toHaveBeenCalled();
      expect(admissionModule.parseFinalizationStateUpdatePayload).not.toHaveBeenCalled();
      expect(callbackModule.applyAwsFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    },
  );

  it('preserves Step Functions timeout identity for timed-out callbacks', async () => {
    const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
    const executionId = '01HVN5WA1CEH94868G90QGJ7HX';
    const timeoutAt = '2026-06-12T00:00:00.000Z';
    const timeoutPayload = {
      sessionId,
      executionId,
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'TIMED_OUT' as const,
      queuedAt: 1_700_000_000_000,
      timeoutAt: Date.parse(timeoutAt),
      stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
    };
    const timeoutState = { status: 'timeout' } as Awaited<
      ReturnType<typeof callbackModule.applyAwsFinalizationStateUpdatePayload>
    >['state'];

    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockImplementation((payload) => {
      expect(payload).toEqual(expect.objectContaining({ timeoutAt: Date.parse(timeoutAt) }));
      return timeoutPayload;
    });
    vi.mocked(callbackModule.applyAwsFinalizationStateUpdatePayload).mockResolvedValue({
      sessionId,
      state: timeoutState,
    });

    await expect(
      handler({
        status: 'TIMED_OUT',
        executionArn: timeoutPayload.stepFunctionsArn,
        timeoutAt,
        payload: {
          sessionId,
          executionId,
          contractGeneration: timeoutPayload.contractGeneration,
          queuedAt: timeoutPayload.queuedAt,
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'success',
        sessionId,
      }),
    );
  });
});

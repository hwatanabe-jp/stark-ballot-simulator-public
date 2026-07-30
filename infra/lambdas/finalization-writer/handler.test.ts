import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConfigValidationError } from '@stark-ballot/runtime-config/env/configValidationError';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { TransientBundleRestoreError } from '@stark-ballot/aws-adapters/aws/bundle-restore';

const emitCanonicalEventMock = vi.hoisted(() => vi.fn());

vi.mock('@stark-ballot/diagnostics/canonicalEvents', () => ({
  emitCanonicalEvent: emitCanonicalEventMock,
}));

vi.mock('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver', () => ({
  ensureAwsRuntimeConfigReferencesLoaded: vi.fn(async () => await Promise.resolve(undefined)),
}));

vi.mock('@stark-ballot/runtime-config/env/validate', () => ({
  validateEnv: vi.fn(),
}));

vi.mock('@stark-ballot/runtime-config/env/observability', () => ({
  collectInvalidTargetObservabilityEnvNames: vi.fn(() => []),
  validateTargetObservabilityEnv: vi.fn(),
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
  readAsyncProverFailureCategory: vi.fn(),
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
const resolverModule = await import('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver');
const envModule = await import('@stark-ballot/runtime-config/env/validate');
const { logger } = await import('@stark-ballot/diagnostics/logger');
const { handler } = await import('./handler');

describe('target finalization-writer handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_MOCK_STORE'] = 'false';
    process.env['USE_S3'] = 'true';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['AWS_REGION'] = 'ap-northeast-1';
    process.env['DYNAMODB_SESSIONS_TABLE'] = 'sessions';
    process.env['DYNAMODB_VOTES_TABLE'] = 'votes';
    process.env['S3_PROOF_BUCKET'] = 'proofs';
    process.env['S3_PROOF_PREFIX'] = 'sessions';
  });

  it('rejects invalid direct callback payloads so Step Functions observes failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockReturnValue(undefined);

    await expect(handler({ malformed: true })).rejects.toThrow('Invalid direct finalize callback event');
    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'step_functions',
      reason: 'payload_invalid',
    });
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'direct_writer',
      auth_result: 'not_applicable',
      outcome_code: 'payload_invalid',
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('malformed');
    warnSpy.mockRestore();
  });

  it('emits names only when runtime reference resolution fails before validation', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const secretValue = 'do-not-log-resolved-secret';
    const resolutionError = new Error(`failed to resolve ${secretValue}`);
    vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mockImplementationOnce(
      async (_entrypoint, options) => {
        if (!options) throw new Error('Expected runtime-reference resolver options');
        options.invalidNameCollector?.add('VOTE_SECRET_ENCRYPTION_KEY_REF');
        await Promise.reject(resolutionError);
      },
    );

    await expect(handler({ malformed: true })).rejects.toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['VOTE_SECRET_ENCRYPTION_KEY_REF'],
    });

    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['VOTE_SECRET_ENCRYPTION_KEY_REF'],
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secretValue);
    expect(envModule.validateEnv).not.toHaveBeenCalled();
    expect(admissionModule.parseFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('reports only the invalid finalization-writer config name', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    delete process.env['S3_PROOF_BUCKET'];

    await expect(handler({ malformed: true })).rejects.toThrow('Runtime configuration validation failed');

    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['S3_PROOF_BUCKET'],
    });
    expect(envModule.validateEnv).not.toHaveBeenCalled();
    expect(admissionModule.parseFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not expose parser exception text when a Step Functions payload is rejected', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const privateUri = 's3://private-bucket/sessions/raw-session/input.json';
    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockImplementationOnce(() => {
      throw new Error(`invalid payload at ${privateUri}`);
    });

    await expect(handler({ payload: privateUri })).rejects.toThrow('Invalid direct finalize callback event');

    expect(warnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'step_functions',
      reason: 'payload_invalid',
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateUri);
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'direct_writer',
      auth_result: 'not_applicable',
      outcome_code: 'payload_invalid',
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(privateUri);
    warnSpy.mockRestore();
  });

  it('validates target env before restoring a successful S3 bundle', async () => {
    const envError = new RuntimeConfigValidationError(
      ['ALLOW_INSECURE_ZKVM'],
      undefined,
      'ALLOW_INSECURE_ZKVM is not allowed when TARGET_AWS_RUNTIME=1',
    );
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

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
    ).rejects.toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['ALLOW_INSECURE_ZKVM'],
    });

    expect(artifactsModule.buildFinalizationResultFromS3Bundle).not.toHaveBeenCalled();
    expect(admissionModule.parseFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    expect(callbackModule.applyAwsFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['ALLOW_INSECURE_ZKVM'],
    });
    errorSpy.mockRestore();
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
        category: 'artifact',
      } as const,
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
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'direct_writer',
      auth_result: 'not_applicable',
      outcome_code: 'applied',
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: executionId,
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(sessionId);
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('bundle.zip');
  });

  it('rethrows transient bundle restoration failures for the Step Functions retry path', async () => {
    const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
    const executionId = '01HVN5WA1CEH94868G90QGJ7HX';
    const privateDetail = 's3://private-bucket/sessions/private-session/bundle.zip';
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.mocked(artifactsModule.buildFinalizationResultFromS3Bundle).mockRejectedValue(new TransientBundleRestoreError());

    await expect(
      handler({
        status: 'SUCCEEDED',
        executionArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:machine:exec-1',
        payload: {
          sessionId,
          executionId,
          contractGeneration: '2026-04-zkvm-current-v1',
          queuedAt: 1_700_000_000_000,
          proverResult: {
            privateDetail,
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'TransientBundleRestoreError',
      message: 'Receipt restoration temporarily unavailable',
    });

    expect(admissionModule.parseFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    expect(callbackModule.applyAwsFinalizationStateUpdatePayload).not.toHaveBeenCalled();
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'direct_writer',
      auth_result: 'not_applicable',
      outcome_code: 'application_failed',
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: executionId,
    });
    expect(emitCanonicalEventMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('Finalization bundle restoration is temporarily unavailable', {
      event: 'finalization_bundle_restore_deferred',
      source_kind: 'step_functions',
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      'Invocation payload is invalid',
      expect.objectContaining({ reason: 'payload_invalid' }),
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateDetail);
  });

  it('rejects store update failures instead of returning an error payload', async () => {
    const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
    const executionId = '01HVN5WA1CEH94868G90QGJ7HX';
    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockReturnValue({
      sessionId,
      executionId,
      contractGeneration: '2026-04-zkvm-current-v1',
      status: 'FAILED',
      queuedAt: 1_700_000_000_000,
      error: {
        code: 'PROVER_TASK_FAILED',
        message: 'Target prover task failed',
        category: 'prover_execution',
      },
    });
    vi.mocked(callbackModule.applyAwsFinalizationStateUpdatePayload).mockRejectedValue(new Error('update failed'));

    await expect(handler({ status: 'FAILED', payload: { sessionId: 'ignored' } })).rejects.toThrow('update failed');
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'direct_writer',
      auth_result: 'not_applicable',
      outcome_code: 'application_failed',
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: executionId,
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(sessionId);
  });

  it('surfaces only the closed private prover marker category on failed direct updates', async () => {
    const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
    const executionId = '01HVN5WA1CEH94868G90QGJ7HX';
    const privateCause = 's3://private-bucket/raw-session/input.json';
    vi.mocked(artifactsModule.readAsyncProverFailureCategory).mockResolvedValue('upload');
    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockImplementation((payload) => {
      expect(payload).toEqual({
        sessionId,
        executionId,
        contractGeneration: '2026-04-zkvm-current-v1',
        status: 'FAILED',
        queuedAt: 1_700_000_000_000,
        error: {
          code: 'PROVER_TASK_FAILED',
          message: 'Target prover task failed',
          category: 'upload',
        },
      });
      expect(JSON.stringify(payload)).not.toContain(privateCause);
      return undefined;
    });

    await expect(
      handler({
        status: 'FAILED',
        payload: {
          sessionId,
          executionId,
          contractGeneration: '2026-04-zkvm-current-v1',
          queuedAt: 1_700_000_000_000,
        },
        error: {
          code: 'PROVER_TASK_FAILED',
          Cause: privateCause,
        },
      }),
    ).rejects.toThrow('Invalid direct finalize callback event');

    expect(artifactsModule.readAsyncProverFailureCategory).toHaveBeenCalledWith(sessionId, executionId);
  });

  it.each(['PROVER_IMAGE_SIGNATURE_FAILED', 'PROVER_CAPACITY_WAIT_TIMEOUT'] as const)(
    'does not consult prover failure markers for %s',
    async (failureCode) => {
      const sessionId = '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b';
      const executionId = '01HVN5WA1CEH94868G90QGJ7HX';
      vi.mocked(artifactsModule.readAsyncProverFailureCategory).mockResolvedValue('upload');
      vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockImplementation((payload) => {
        expect(payload).toEqual({
          sessionId,
          executionId,
          contractGeneration: '2026-04-zkvm-current-v1',
          status: 'FAILED',
          queuedAt: 1_700_000_000_000,
          error: {
            code: failureCode,
            message: 'Finalization failed',
          },
        });
        return undefined;
      });

      await expect(
        handler({
          status: 'FAILED',
          payload: {
            sessionId,
            executionId,
            contractGeneration: '2026-04-zkvm-current-v1',
            queuedAt: 1_700_000_000_000,
          },
          error: {
            code: failureCode,
            message: 'private error detail',
          },
        }),
      ).rejects.toThrow('Invalid direct finalize callback event');

      expect(artifactsModule.readAsyncProverFailureCategory).not.toHaveBeenCalled();
    },
  );

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
    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'direct_writer',
      auth_result: 'not_applicable',
      outcome_code: 'payload_invalid',
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: executionId,
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain('bundle.zip');
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
      expect(emitCanonicalEventMock).toHaveBeenCalledWith({
        event: 'finalization_update_received',
        transport: 'direct_writer',
        auth_result: 'not_applicable',
        outcome_code: 'payload_invalid',
      });
      expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(executionId);
    },
  );

  it('retains the outcome event but omits a 129-character execution correlation', async () => {
    const overlengthExecutionId = 'e'.repeat(129);
    vi.mocked(admissionModule.parseFinalizationStateUpdatePayload).mockReturnValue(undefined);

    await expect(
      handler({
        status: 'RUNNING',
        payload: {
          sessionId: '2d8a4d02-1a56-4e8a-98f1-e8eb7a482a4b',
          executionId: overlengthExecutionId,
          contractGeneration: '2026-04-zkvm-current-v1',
          queuedAt: 1_700_000_000_000,
          startedAt: 1_700_000_001_000,
        },
      }),
    ).rejects.toThrow('Invalid direct finalize callback event');

    expect(emitCanonicalEventMock).toHaveBeenCalledWith({
      event: 'finalization_update_received',
      transport: 'direct_writer',
      auth_result: 'not_applicable',
      outcome_code: 'payload_invalid',
    });
    expect(JSON.stringify(emitCanonicalEventMock.mock.calls)).not.toContain(overlengthExecutionId);
  });

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

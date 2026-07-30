/**
 * @vitest-environment node
 */

import { Buffer } from 'node:buffer';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@stark-ballot/diagnostics/logger';
import { _setLambdaClient, invokeVerificationWorker } from './verificationWorkerClient';

describe('verificationWorkerClient', () => {
  afterEach(() => {
    _setLambdaClient(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('logs only closed metadata when Lambda returns an opaque FunctionError payload', async () => {
    const rawSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const leakedS3Uri = `s3://private-bucket/sessions/${rawSessionId}/execution-canary/bundle.zip`;
    const decodedPayload = JSON.stringify({
      errorMessage: `worker failed while reading ${leakedS3Uri}`,
      sessionId: rawSessionId,
    });
    const send = vi.fn(() =>
      Promise.resolve({
        FunctionError: 'Unhandled',
        Payload: Buffer.from(decodedPayload),
      }),
    );
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.stubEnv('VERIFICATION_WORKER_FUNCTION_NAME', 'verification-worker-canary');
    _setLambdaClient({ send } as unknown as LambdaClient);

    await expect(
      invokeVerificationWorker({
        mode: 's3_bundle',
        sessionId: rawSessionId,
        executionId: 'execution-canary',
        bundleKey: `sessions/${rawSessionId}/execution-canary/bundle.zip`,
        expectedImageId: `0x${'ab'.repeat(32)}`,
      }),
    ).rejects.toThrow('verification-worker invocation failed');

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[VerificationWorkerClient] verification-worker returned FunctionError',
      {
        function_error: 'unhandled',
        response_payload_present: true,
      },
    );
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(rawSessionId);
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(leakedS3Uri);
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(decodedPayload);
  });
});

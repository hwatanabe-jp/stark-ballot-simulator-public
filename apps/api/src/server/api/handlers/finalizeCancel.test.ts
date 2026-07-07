import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@stark-ballot/domain/types/server';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getNumberProperty, getStringProperty } from '@stark-ballot/domain/utils/guards';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { admitAwsPersistedFinalizationStateBranch } from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { cancelFinalizationHandler } from './finalizeCancel';

const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';

function buildSession(sessionId: string): SessionData {
  const now = Date.now();
  return {
    sessionId,
    contractGeneration: resolveCurrentContractGeneration(),
    finalizationContractGeneration: resolveCurrentContractGeneration(),
    hasPersistedFinalizationBranch: true,
    votes: new Map(),
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    finalizationState: admitAwsPersistedFinalizationStateBranch({
      status: 'succeeded',
      executionId: 'exec-123456',
      queuedAt: now - 2000,
      startedAt: now - 1000,
      completedAt: now,
    }),
  };
}

async function expectStandardErrorResponse(
  response: Response,
  expected: { status: number; error: string },
): Promise<Record<string, unknown>> {
  const payload = await readJsonRecord(response, 'finalize cancel error response');
  expect(StandardErrorResponseSchema.safeParse(payload).success).toBe(true);
  expect(response.status).toBe(expected.status);
  expect(getStringProperty(payload, 'error')).toBe(expected.error);
  expect(getNumberProperty(payload, 'statusCode')).toBe(expected.status);
  return payload;
}

describe('cancelFinalizationHandler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a standard error envelope when async finalization is disabled', async () => {
    vi.stubEnv('FINALIZE_ASYNC_MODE', 'false');
    const store = createMockVoteStore();

    const response = await cancelFinalizationHandler({
      request: new Request('http://localhost/api/finalize/cancel', { method: 'POST' }),
      store,
    });

    await expectStandardErrorResponse(response, {
      status: 404,
      error: 'ASYNC_FINALIZATION_DISABLED',
    });
  });

  it('returns a standard error envelope when the finalization state is not cancellable', async () => {
    vi.stubEnv('FINALIZE_ASYNC_MODE', 'true');
    vi.stubEnv('SESSION_CAPABILITY_SECRET', capabilitySecret);
    const sessionId = 'session-1';
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildSession(sessionId)),
    });

    const response = await cancelFinalizationHandler({
      request: new Request('http://localhost/api/finalize/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SESSION_ID_HEADER]: sessionId,
          [SESSION_CAPABILITY_HEADER]: token,
        },
        body: JSON.stringify({ executionId: 'exec-123456' }),
      }),
      store,
      clientIp: '127.0.0.1',
    });

    await expectStandardErrorResponse(response, {
      status: 409,
      error: 'FINALIZATION_NOT_CANCELLABLE',
    });
  });
});

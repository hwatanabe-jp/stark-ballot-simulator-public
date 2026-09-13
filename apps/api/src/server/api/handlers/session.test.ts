import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { MockSessionStore } from '@stark-ballot/aws-adapters/store/mockSessionStore';
import { localRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { createSessionHandler } from './session';

describe('createSessionHandler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('projects the application-owned capacity outcome without creating another session', async () => {
    vi.stubEnv('MAX_SESSIONS', '1');
    const store = new MockSessionStore();
    await store.createSession();
    const createSession = vi.spyOn(store, 'createSession');

    const response = await createSessionHandler({
      input: { body: {} },
      context: {
        store,
        runtimeProfile: localRuntimeProfile(),
        requestId: 'session-capacity-request-id',
        requestOrigin: 'http://localhost',
        operatorGatedDevelop: false,
        rateLimitClientIp: '127.0.0.1',
      },
    });

    expect(response.status).toBe(503);
    expect(getApiErrorCode(await readJsonRecord(response, 'session capacity'))).toBe(ErrorCode.SESSION_LIMIT_EXCEEDED);
    expect(createSession).not.toHaveBeenCalled();
  });
});

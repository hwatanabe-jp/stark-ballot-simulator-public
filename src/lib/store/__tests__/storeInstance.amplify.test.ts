import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_SESSION_CAPABILITY_SECRET = 'prod-session-capability-secret-0123456789abcdef';
const VALID_VOTE_SECRET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('storeInstance - Amplify session store selection', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function configureNonMockAmplifyEnv(): void {
    process.env.USE_MOCK_STORE = 'false';
    process.env.USE_AMPLIFY_DATA = 'true';
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql';
    process.env.AMPLIFY_DATA_API_ID = 'example-api-id';
    process.env.AWS_REGION = 'ap-northeast-1';
    process.env.RATE_LIMIT_STORE = 'memory';
    process.env.SESSION_CAPABILITY_SECRET = VALID_SESSION_CAPABILITY_SECRET;
    process.env.VOTE_SECRET_ENCRYPTION_KEY = VALID_VOTE_SECRET_ENCRYPTION_KEY;
  }

  it('returns AmplifySessionStore when USE_AMPLIFY_DATA is true', async () => {
    configureNonMockAmplifyEnv();

    const { getGlobalStore, resetGlobalStore } = await import('../storeInstance');
    resetGlobalStore();

    const store = getGlobalStore();
    const { AmplifySessionStore } = await import('../amplifySessionStore');

    expect(store).to.be.instanceOf(AmplifySessionStore);
  });

  it('returns MockSessionStore only when USE_MOCK_STORE is explicitly true', async () => {
    process.env.USE_MOCK_STORE = 'true';
    process.env.USE_AMPLIFY_DATA = 'false';

    const { getGlobalStore, resetGlobalStore } = await import('../storeInstance');
    resetGlobalStore();

    const store = getGlobalStore();
    const { MockSessionStore } = await import('../mockSessionStore');

    expect(store).to.be.instanceOf(MockSessionStore);
  });

  it('rejects USE_AMPLIFY_DATA=false when mock store is disabled', async () => {
    configureNonMockAmplifyEnv();
    process.env.USE_AMPLIFY_DATA = 'false';

    const { getGlobalStore, resetGlobalStore } = await import('../storeInstance');
    resetGlobalStore();

    expect(() => getGlobalStore()).toThrow('USE_AMPLIFY_DATA=false is incompatible with USE_MOCK_STORE=false');
  });

  it('does not fall back to MockSessionStore when AmplifySessionStore initialization fails', async () => {
    configureNonMockAmplifyEnv();
    process.env.AMPLIFY_DATA_ENDPOINT = 'not-a-valid-url';

    const { getGlobalStore, resetGlobalStore } = await import('../storeInstance');
    resetGlobalStore();

    expect(() => getGlobalStore()).toThrow('Failed to initialize AmplifySessionStore');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('storeInstance - Amplify session store selection', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns AmplifySessionStore when USE_AMPLIFY_DATA is true', async () => {
    process.env.USE_MOCK_STORE = 'false';
    process.env.USE_AMPLIFY_DATA = 'true';
    process.env.AMPLIFY_DATA_ENDPOINT = 'https://example.com/graphql';
    process.env.AWS_REGION = 'ap-northeast-1';

    const { getGlobalStore, resetGlobalStore } = await import('../storeInstance');
    resetGlobalStore();

    const store = getGlobalStore();
    const { AmplifySessionStore } = await import('../amplifySessionStore');

    expect(store).to.be.instanceOf(AmplifySessionStore);
  });
});

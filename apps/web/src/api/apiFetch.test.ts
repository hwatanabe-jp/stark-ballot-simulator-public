import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBrowserPublicEnvForTests,
  setBrowserPublicEnvForTests,
} from '@stark-ballot/runtime-config/env/browserPublic';
import { apiFetch } from './apiFetch';
import { handleLocalApiRequest } from '@stark-ballot/web/mock-api/fetcher';

vi.mock('@stark-ballot/web/mock-api/fetcher', () => ({
  handleLocalApiRequest: vi.fn(),
}));

const mockFetch = vi.fn<typeof fetch>();

describe('apiFetch browser runtime profile', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.mocked(handleLocalApiRequest).mockReset();
  });

  afterEach(() => {
    clearBrowserPublicEnvForTests();
    vi.unstubAllGlobals();
  });

  it('routes local-demo requests to the in-browser mock API', async () => {
    setBrowserPublicEnvForTests('VITE_RUNTIME_PROFILE', 'local-demo');
    const response = new Response(null, { status: 204 });
    vi.mocked(handleLocalApiRequest).mockResolvedValue(response);

    await expect(apiFetch('/api/sessions')).resolves.toBe(response);
    expect(handleLocalApiRequest).toHaveBeenCalledWith('/api/sessions', undefined);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each(['static-mock-e2e', 'local-proof-development', 'local-proof-production'] as const)(
    'routes %s requests to the same-origin API',
    async (profile) => {
      setBrowserPublicEnvForTests('VITE_RUNTIME_PROFILE', profile);
      const response = new Response(null, { status: 204 });
      mockFetch.mockResolvedValue(response);

      await expect(apiFetch('/api/sessions')).resolves.toBe(response);
      expect(mockFetch).toHaveBeenCalledWith('/api/sessions', undefined);
      expect(handleLocalApiRequest).not.toHaveBeenCalled();
    },
  );

  it('fails closed before dispatch when the selector is retired', async () => {
    setBrowserPublicEnvForTests('VITE_RUNTIME_PROFILE', 'local-mock');

    await expect(apiFetch('/api/sessions')).rejects.toThrow(
      'VITE_RUNTIME_PROFILE must select a supported semantic runtime profile',
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(handleLocalApiRequest).not.toHaveBeenCalled();
  });
});

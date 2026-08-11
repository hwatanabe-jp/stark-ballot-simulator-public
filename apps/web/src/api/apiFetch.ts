import { resolveBrowserRuntimeProfile } from '@stark-ballot/runtime-config/env/public-runtime-config';

function shouldUseMockApi(): boolean {
  return resolveBrowserRuntimeProfile().apiMode === 'mock';
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (shouldUseMockApi()) {
    const { handleLocalApiRequest } = await import('@stark-ballot/web/mock-api/fetcher');
    return handleLocalApiRequest(input, init);
  }
  return fetch(input, init);
}

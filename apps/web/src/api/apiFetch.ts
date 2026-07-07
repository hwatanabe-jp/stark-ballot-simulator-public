async function shouldUseMockApi(): Promise<boolean> {
  if (!import.meta.env.DEV || import.meta.env['VITE_USE_MOCK_API'] !== 'true') {
    return false;
  }
  if (typeof window === 'undefined') {
    return true;
  }
  const { MOCK_API_STORAGE_KEY } = await import('@stark-ballot/web/mock-api/config');
  const stored = window.localStorage.getItem(MOCK_API_STORAGE_KEY);
  if (stored === 'true') {
    return true;
  }
  if (stored === 'false') {
    return false;
  }
  return true;
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (await shouldUseMockApi()) {
    const { handleLocalApiRequest } = await import('@stark-ballot/web/mock-api/fetcher');
    return handleLocalApiRequest(input, init);
  }
  return fetch(input, init);
}

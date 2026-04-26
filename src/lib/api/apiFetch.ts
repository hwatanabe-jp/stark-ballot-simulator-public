import { isMockApiEnabled, mockApiFetch } from '@/lib/mock-api/fetcher';

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (isMockApiEnabled()) {
    return mockApiFetch(input, init);
  }
  return fetch(input, init);
}

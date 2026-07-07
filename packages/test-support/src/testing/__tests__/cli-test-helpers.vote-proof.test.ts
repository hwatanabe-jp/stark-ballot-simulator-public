import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLITestHelpers } from '../cli-test-helpers';

const baseUrl = 'http://localhost:3000';

function buildJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  };
}

describe('CLITestHelpers.submitVote', () => {
  const voteId = 'vote-123';
  const sessionId = 'session-abc';
  const electionId = '00000000-0000-4000-8000-000000000000';
  let helpers: CLITestHelpers;

  beforeEach(() => {
    helpers = new CLITestHelpers(baseUrl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('includes session auth headers when fetching vote proof', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : (() => {
                  throw new Error('Unexpected fetch input type');
                })();

      if (url === `${baseUrl}/api/vote`) {
        const headers = init?.headers;
        const sessionIdHeader =
          headers instanceof Headers
            ? headers.get('X-Session-ID')
            : (headers as Record<string, string> | undefined)?.['X-Session-ID'];
        const capabilityHeader =
          headers instanceof Headers
            ? headers.get('X-Session-Capability')
            : (headers as Record<string, string> | undefined)?.['X-Session-Capability'];

        expect(sessionIdHeader).toBe(sessionId);
        expect(capabilityHeader).toBe('v1.test.session-capability');

        return Promise.resolve(buildJsonResponse({ data: { voteId } }));
      }

      if (url === `${baseUrl}/api/session`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId,
              electionId,
              capabilityToken: 'v1.test.session-capability',
            },
          }),
        );
      }

      if (url === `${baseUrl}/api/bulletin/${voteId}/proof`) {
        const headers = init?.headers;
        const sessionIdHeader =
          headers instanceof Headers
            ? headers.get('X-Session-ID')
            : (headers as Record<string, string> | undefined)?.['X-Session-ID'];
        const capabilityHeader =
          headers instanceof Headers
            ? headers.get('X-Session-Capability')
            : (headers as Record<string, string> | undefined)?.['X-Session-Capability'];

        expect(sessionIdHeader).toBe(sessionId);
        expect(capabilityHeader).toBe('v1.test.session-capability');

        return Promise.resolve(
          buildJsonResponse({
            proof: {
              leafIndex: 0,
              merklePath: ['0x01'],
            },
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const createdSessionId = await helpers.createSession();
    const result = await helpers.submitVote(createdSessionId, 'A');

    expect(result.leafIndex).toBe(0);
    expect(result.merklePath).toEqual(['0x01']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

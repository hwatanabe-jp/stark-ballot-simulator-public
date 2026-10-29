import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLITestHelpers } from './cli-test-helpers';

const baseUrl = 'http://localhost:3000';
type FetchInput = Parameters<typeof fetch>[0];

function buildJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  };
}

function extractFetchUrl(input: FetchInput): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input instanceof Request
        ? input.url
        : (() => {
            throw new Error('Unexpected fetch input type');
          })();
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

  it('includes the session capability when fetching vote proof', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: RequestInit) => {
      const url = extractFetchUrl(input);

      if (url === `${baseUrl}/api/sessions/${sessionId}/votes`) {
        const capabilityHeader = new Headers(init?.headers).get('X-Session-Capability');

        expect(capabilityHeader).toBe('v1.test.session-capability');

        return Promise.resolve(
          buildJsonResponse({
            data: { voteId },
            meta: { requestId: 'request-vote' },
          }),
        );
      }

      if (url === `${baseUrl}/api/sessions`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId,
              electionId,
              capabilityToken: 'v1.test.session-capability',
            },
            meta: { requestId: 'request-session' },
          }),
        );
      }

      if (url === `${baseUrl}/api/sessions/${sessionId}/votes/${voteId}/inclusion-proof`) {
        const capabilityHeader = new Headers(init?.headers).get('X-Session-Capability');

        expect(capabilityHeader).toBe('v1.test.session-capability');

        return Promise.resolve(
          buildJsonResponse({
            data: {
              proof: {
                leafIndex: 0,
                merklePath: ['0x01'],
              },
            },
            meta: { requestId: 'request-proof' },
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

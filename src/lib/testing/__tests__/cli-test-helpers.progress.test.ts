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

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  throw new Error('Unexpected fetch input type');
}

describe('CLITestHelpers.generateBotVotes', () => {
  let helpers: CLITestHelpers;

  beforeEach(() => {
    helpers = new CLITestHelpers(baseUrl);
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails immediately when bot progress reports the current session is unavailable', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = extractUrl(input);

      if (url === `${baseUrl}/api/session`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
          }),
        );
      }

      if (url === `${baseUrl}/api/progress`) {
        return Promise.resolve(buildJsonResponse({ error: 'SESSION_NOT_FOUND' }, 404));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();

    await expect(helpers.generateBotVotes(sessionId)).rejects.toThrow(
      'Bot voting progress became unavailable (SESSION_NOT_FOUND). Create a fresh session before retrying.',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

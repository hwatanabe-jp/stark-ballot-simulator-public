import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ROUTES, type RouteInput } from '@stark-ballot/api-contract/routes';
import voteFixture from '@stark-ballot/web/mock-api/fixtures/json/sessions.votes.post.json';
import { ApiClientContractError, requestJsonRoute } from './client';
import { apiFetch } from './apiFetch';

vi.mock('./apiFetch', () => ({
  apiFetch: vi.fn(),
}));

const capabilityHeaders = { 'X-Session-Capability': 'capability-token' } as const;
const validVoteInput: RouteInput<typeof API_ROUTES.submitVote> = {
  params: { sessionId: 'session/one' },
  headers: capabilityHeaders,
  body: {
    commitment: `0x${'1'.repeat(64)}`,
    vote: 'A',
    rand: `0x${'2'.repeat(64)}`,
  },
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('route-bound JSON client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives method, encoded path, headers, and serialized body from one route input', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse({ data: voteFixture.data, meta: { requestId: 'request-id' } }));

    await expect(requestJsonRoute(API_ROUTES.submitVote, validVoteInput, 'vote')).resolves.toEqual({
      status: 200,
      body: { data: voteFixture.data, meta: { requestId: 'request-id' } },
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/votes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Capability': 'capability-token',
      },
      body: JSON.stringify(validVoteInput.body),
    });
  });

  it('serializes admitted query values through the route-owned wire format', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse({
        data: {
          commitments: [],
          bulletinRoot: `0x${'0'.repeat(64)}`,
          treeSize: 0,
          generatedAtMs: 0,
        },
        meta: {
          requestId: 'request-id',
          page: { nextOffset: null, hasMore: false },
        },
      }),
    );

    await requestJsonRoute(
      API_ROUTES.sessionBulletin,
      {
        params: { sessionId: 'session/one' },
        query: { offset: 2, limit: 50 },
        headers: capabilityHeaders,
      },
      'bulletin',
    );

    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/session%2Fone/bulletin?offset=2&limit=50', {
      method: 'GET',
      headers: capabilityHeaders,
    });
  });

  it.each([
    {
      label: 'path parameters',
      request: () =>
        requestJsonRoute(
          API_ROUTES.progress,
          {
            params: { sessionId: '' },
            headers: capabilityHeaders,
          },
          'resource',
        ),
    },
    {
      label: 'query',
      request: () =>
        requestJsonRoute(
          API_ROUTES.sessionBulletin,
          {
            params: { sessionId: 'session-1' },
            query: { offset: -1 },
            headers: capabilityHeaders,
          },
          'resource',
        ),
    },
    {
      label: 'headers',
      request: () =>
        requestJsonRoute(
          API_ROUTES.progress,
          {
            params: { sessionId: 'session-1' },
            headers: { 'X-Session-Capability': '' },
          },
          'resource',
        ),
    },
  ])('rejects invalid $label before issuing a request', async ({ request }) => {
    await expect(request()).rejects.toBeInstanceOf(ApiClientContractError);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects an invalid body before issuing a request', async () => {
    const input = {
      ...validVoteInput,
      body: { ...validVoteInput.body, commitment: 'not-a-commitment' },
    } as RouteInput<typeof API_ROUTES.submitVote>;

    await expect(requestJsonRoute(API_ROUTES.submitVote, input, 'vote')).rejects.toBeInstanceOf(ApiClientContractError);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

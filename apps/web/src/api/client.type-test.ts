import { API_ROUTES, type RouteInput } from '@stark-ballot/api-contract/routes';
import type { VoteResponse } from '@stark-ballot/api-contract/schemas/votes';
import { requestJsonRoute, type JsonRouteResult } from './client';

const voteInput: RouteInput<typeof API_ROUTES.submitVote> = {
  params: { sessionId: 'session-1' },
  headers: { 'X-Session-Capability': 'capability-token' },
  body: {
    commitment: `0x${'1'.repeat(64)}`,
    vote: 'A',
    rand: `0x${'2'.repeat(64)}`,
  },
};

const voteResult = requestJsonRoute(API_ROUTES.submitVote, voteInput, 'vote');
void (voteResult satisfies Promise<JsonRouteResult<typeof API_ROUTES.submitVote>>);
void (voteResult satisfies Promise<{ status: 200; body: VoteResponse }>);

void requestJsonRoute(
  API_ROUTES.sessionBulletin,
  {
    params: { sessionId: 'session-1' },
    query: { offset: 2, limit: 50 },
    headers: { 'X-Session-Capability': 'capability-token' },
  },
  'bulletin',
);

const finalizationResult = requestJsonRoute(
  API_ROUTES.createFinalization,
  {
    params: { sessionId: 'session-1' },
    headers: { 'X-Session-Capability': 'capability-token' },
    body: { scenarioId: 'S0' },
  },
  'finalization',
);
void (finalizationResult satisfies Promise<{ status: 200 | 202; body: unknown }>);

// @ts-expect-error The request path is derived from the route-bound input.
void requestJsonRoute(API_ROUTES.submitVote, '/api/sessions/session-1/votes', 'vote', {
  body: voteInput.body,
  headers: voteInput.headers,
});

void requestJsonRoute(
  API_ROUTES.submitVote,
  {
    // @ts-expect-error The submit-vote route requires its declared path parameters.
    params: {},
    headers: voteInput.headers,
    body: voteInput.body,
  },
  'vote',
);

void requestJsonRoute(
  API_ROUTES.submitVote,
  {
    params: voteInput.params,
    headers: voteInput.headers,
    // @ts-expect-error A body from a different route cannot be paired with submit-vote.
    body: { scenarioId: 'S0' },
  },
  'vote',
);

void requestJsonRoute(
  API_ROUTES.progress,
  {
    params: { sessionId: 'session-1' },
    headers: voteInput.headers,
  },
  'progress',
  {
    // @ts-expect-error Transport options cannot override route-declared headers.
    headers: { Authorization: 'independent-header' },
  },
);

void requestJsonRoute(
  // @ts-expect-error Protected report artifacts require their named bounded adapter.
  API_ROUTES.finalizationArtifactReport,
  {
    params: { sessionId: 'session-1', finalizationId: 'finalization-1' },
    headers: voteInput.headers,
  },
  'verification report',
);

void requestJsonRoute(
  // @ts-expect-error Conditional bitmap responses require their named bounded adapter.
  API_ROUTES.currentFinalizationBitmapProof,
  {
    params: { sessionId: 'session-1', kind: 'included', voteIndex: 0 },
    headers: voteInput.headers,
  },
  'bitmap proof',
);

void requestJsonRoute(
  // @ts-expect-error Binary bundle responses require their named bounded adapter.
  API_ROUTES.finalizationArtifactBundle,
  {
    params: { sessionId: 'session-1', finalizationId: 'finalization-1' },
    headers: voteInput.headers,
  },
  'verification bundle',
);

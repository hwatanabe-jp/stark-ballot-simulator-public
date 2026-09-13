import type { ApiContractRouteId } from '@stark-ballot/api-contract/routes';

export interface OpenApiRouteReference {
  readonly summary: string;
  readonly description: string;
  readonly tag: 'Artifacts' | 'Bulletin' | 'Finalization' | 'Sessions' | 'Verification' | 'Voting';
  readonly additionalAdmissionControls?: readonly string[];
  readonly parameterOverlays?: Readonly<
    Partial<Record<`${'header' | 'path' | 'query'}:${string}`, Readonly<Record<string, unknown>>>>
  >;
}

const SESSION_ID_PATH = {
  'path:sessionId': { pattern: '^[A-Za-z0-9-]+$' },
} as const;

const VOTE_ID_PATH = {
  format: 'uuid',
  pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$',
} as const;

export const OPENAPI_ROUTE_REFERENCE = {
  'progress.get': {
    summary: 'Read session progress',
    description: 'Returns the capability-scoped progress projection for one session.',
    tag: 'Sessions',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.finalizations.verification.get': {
    summary: 'Read verification evidence',
    description:
      'Returns the available fail-closed public verification resource, optionally including its journal. The current mounted route converts unavailable or corrupt preparation outcomes to its declared internal-error response.',
    tag: 'Verification',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.finalizations.current.get': {
    summary: 'Read current finalization',
    description: 'Returns the current finalization lifecycle resource for a session.',
    tag: 'Finalization',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.finalizations.artifacts.bundle.get': {
    summary: 'Download the public verification bundle',
    description: 'Downloads the public ZIP bundle and supports bounded byte ranges.',
    tag: 'Artifacts',
    parameterOverlays: {
      ...SESSION_ID_PATH,
      'header:Range': {
        pattern: '^\\s*bytes=(?:\\d+-\\d*|-\\d+)\\s*$',
        'x-stark-ballot-runtime-constraint':
          'Decimal components are JavaScript safe integers; suffix length is positive and a closed end is at least its start.',
      },
    },
  },
  'sessions.finalizations.artifacts.report.get': {
    summary: 'Read the verifier report',
    description:
      'Returns the protected verifier-service report. Delivery is raw JSON and the route does not revalidate the retained bytes.',
    tag: 'Artifacts',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.bulletin.get': {
    summary: 'Read the bulletin board',
    description: 'Returns a capability-scoped page of committed votes and bulletin-root history.',
    tag: 'Bulletin',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.bulletin.consistencyProof.get': {
    summary: 'Read a bulletin consistency proof',
    description: 'Returns an RFC 6962-style proof between two admitted tree sizes.',
    tag: 'Bulletin',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.votes.inclusionProof.get': {
    summary: 'Read a vote inclusion proof',
    description: 'Returns the exact recorded inclusion proof for a capability-scoped admitted vote.',
    tag: 'Bulletin',
    parameterOverlays: { ...SESSION_ID_PATH, 'path:voteId': VOTE_ID_PATH },
  },
  'sessions.finalizations.current.bitmapProof.get': {
    summary: 'Read a bitmap proof',
    description:
      'Returns a proof for the authenticated session user vote index in the included or seen bitmap of the current finalization.',
    tag: 'Artifacts',
    additionalAdmissionControls: ['owner-vote-index'],
    parameterOverlays: {
      ...SESSION_ID_PATH,
      'path:voteIndex': {
        'x-stark-ballot-numeric-maximum': Number.MAX_SAFE_INTEGER,
        'x-stark-ballot-runtime-constraint': 'The index must equal the authenticated session user vote index.',
      },
    },
  },
  'sessions.bulletin.sth.get': {
    summary: 'Read the signed tree head',
    description: 'Returns the finalization-bound signed tree head after same-origin admission.',
    tag: 'Bulletin',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.finalizations.current.inputCommitment.get': {
    summary: 'Read the input commitment',
    description: 'Returns the hash commitment that binds the current zkVM input.',
    tag: 'Artifacts',
    parameterOverlays: SESSION_ID_PATH,
  },
  'session.post': {
    summary: 'Create a voting session',
    description: 'Creates a session and issues its capability token after the active public-admission checks.',
    tag: 'Sessions',
  },
  'vote.post': {
    summary: 'Submit a vote',
    description: 'Submits one commitment-bound vote under the session capability.',
    tag: 'Voting',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.finalizations.post': {
    summary: 'Start finalization',
    description: 'Starts or completes the admitted finalization path for a fully voted session.',
    tag: 'Finalization',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.finalizations.cancel.post': {
    summary: 'Cancel finalization',
    description: 'Requests cancellation of a cancellable asynchronous finalization.',
    tag: 'Finalization',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.finalizations.verification.observations.post': {
    summary: 'Record cast-check observations',
    description: 'Records the bounded browser-local cast-check observation with durable conflict detection.',
    tag: 'Verification',
    parameterOverlays: SESSION_ID_PATH,
  },
  'sessions.finalizations.verification.post': {
    summary: 'Run receipt verification',
    description: 'Starts or reuses receipt verification for one finalized session authority.',
    tag: 'Verification',
    parameterOverlays: SESSION_ID_PATH,
  },
} as const satisfies Record<ApiContractRouteId, OpenApiRouteReference>;

export function getOpenApiRouteReference(routeId: string): OpenApiRouteReference | undefined {
  if (!Object.hasOwn(OPENAPI_ROUTE_REFERENCE, routeId)) return undefined;
  return OPENAPI_ROUTE_REFERENCE[routeId as ApiContractRouteId];
}

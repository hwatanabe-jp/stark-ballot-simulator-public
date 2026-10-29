import { s } from '@stark-ballot/validation/schema';
import {
  BitmapProofResponseSchema,
  BulletinProofResponseSchema,
  BulletinQuerySchema,
  BulletinResponseSchema,
  ConsistencyProofQuerySchema,
  ConsistencyProofResponseSchema,
  CurrentFinalizationBitmapProofParamsSchema,
  CurrentFinalizationInputCommitmentParamsSchema,
  CurrentFinalizationParamsSchema,
  CurrentFinalizationResponseSchema,
  FinalizationCancelParamsSchema,
  FinalizationCancelRequestSchema,
  FinalizationCreateParamsSchema,
  FinalizationCreateRequestSchema,
  FinalizationResponseSchema,
  InputCommitmentResponseSchema,
  FinalizationArtifactParamsSchema,
  ProgressResponseSchema,
  PathSessionCapabilityHeadersSchema,
  SessionCreateRequestSchema,
  SessionParamsSchema,
  SessionResponseSchema,
  SessionBulletinParamsSchema,
  SessionVoteInclusionProofParamsSchema,
  SthQuerySchema,
  SthResponseSchema,
  VerificationObservationRequestSchema,
  VerificationObservationResponseSchema,
  VerificationResourceParamsSchema,
  VerificationResourceQuerySchema,
  VerificationResourceResponseSchema,
  VerificationRunRequestSchema,
  VerificationRunResponseSchema,
  VoteRequestSchema,
  VoteResponseSchema,
} from '../schemas';
import {
  BODY_ERROR_RESPONSES,
  FINALIZE_RATE_LIMIT_ERROR_RESPONSES,
  MOUNTED_ROUTE_ERROR_RESPONSES,
  PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
  TURNSTILE_ERROR_RESPONSES,
  apiBodySize,
  clientIpAndGlobalRateLimit,
  clientIpRateLimit,
  noBodySize,
  noRateLimit,
  noSourceIp,
  noTurnstile,
  publicErrors,
  standardJsonError,
  trustedProxySourceIp,
  turnstile,
  type ApiRouteContract,
} from './contract';
import {
  binaryResponse,
  createQuerySerializer,
  defineRoute,
  jsonResponse,
  jsonResponseExempt,
  matchRoutePath,
  type HttpMethod,
  type RouteInput,
} from './route';

const verificationBundleHeadersSchema = PathSessionCapabilityHeadersSchema.extend({
  Range: s.string().min(1).optional(),
});

const bitmapProofHeadersSchema = PathSessionCapabilityHeadersSchema.extend({
  'If-None-Match': s.string().min(1).optional(),
});

const sthHeadersSchema = PathSessionCapabilityHeadersSchema.extend({
  Origin: s.string().min(1).optional(),
  'Sec-Fetch-Site': s.string().min(1).optional(),
});

export const progressRoute = defineRoute({
  routeId: 'progress.get',
  method: 'GET',
  path: '/sessions/:sessionId/progress',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: SessionParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
  },
  responses: [jsonResponse(200, ProgressResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'current-contract-session'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const verificationRoute = defineRoute({
  routeId: 'sessions.finalizations.verification.get',
  method: 'GET',
  path: '/sessions/:sessionId/finalizations/:finalizationId/verification',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: VerificationResourceParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
    query: VerificationResourceQuerySchema,
  },
  serializeQuery: createQuerySerializer(VerificationResourceQuerySchema, (query) => ({
    ...(query.include === undefined ? {} : { include: query.include }),
  })),
  responses: [jsonResponse(200, VerificationResourceResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('SESSION_NOT_FINALIZED', 400),
    standardJsonError('USER_NOT_VOTED', 400),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'finalization-id', 'finalized-session', 'finalization-authority'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
  variants: [
    {
      selector: 'include=journal',
      lifecycle: 'active',
      dataClassification: 'owner-scoped-public-projection',
      admissionControls: ['path-session-capability', 'finalization-id', 'finalized-session', 'finalization-authority'],
    },
  ],
});

export const currentFinalizationRoute = defineRoute({
  routeId: 'sessions.finalizations.current.get',
  method: 'GET',
  path: '/sessions/:sessionId/finalizations/current',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: CurrentFinalizationParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
  },
  responses: [jsonResponse(200, CurrentFinalizationResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'finalization-authority', 'finalization-resource'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const finalizationArtifactBundleRoute = defineRoute({
  routeId: 'sessions.finalizations.artifacts.bundle.get',
  method: 'GET',
  path: '/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: FinalizationArtifactParamsSchema,
    headers: verificationBundleHeadersSchema,
  },
  responses: [
    binaryResponse(200, 'binary-public-bundle-download'),
    binaryResponse(206, 'binary-public-bundle-range-download'),
  ],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('INVALID_BUNDLE_REFERENCE', 400),
    standardJsonError('BUNDLE_NOT_FOUND', 404),
    standardJsonError('BUNDLE_DOWNLOAD_FAILED', 500),
    standardJsonError('BUNDLE_REQUIRES_RANGE_DOWNLOAD', 413),
    standardJsonError('INVALID_RANGE', 416),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'finalization-id', 'range-supported', 'public-bundle-allowlist'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const finalizationArtifactReportRoute = defineRoute({
  routeId: 'sessions.finalizations.artifacts.report.get',
  method: 'GET',
  path: '/sessions/:sessionId/finalizations/:finalizationId/artifacts/report',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: FinalizationArtifactParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
  },
  responses: [jsonResponseExempt(200, 'protected-report-artifact-download')],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('INVALID_BUNDLE_REFERENCE', 400),
    standardJsonError('REPORT_NOT_FOUND', 404),
    standardJsonError('REPORT_DOWNLOAD_FAILED', 500),
    standardJsonError('REPORT_DOWNLOAD_TOO_LARGE', 413),
  ]),
  dataClassification: 'owner-scoped-private-report',
  admissionControls: ['path-session-capability', 'finalization-id', 'inline-report-size-limit'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const sessionBulletinRoute = defineRoute({
  routeId: 'sessions.bulletin.get',
  method: 'GET',
  path: '/sessions/:sessionId/bulletin',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: SessionBulletinParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
    query: BulletinQuerySchema,
  },
  responses: [jsonResponse(200, BulletinResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('INVALID_OFFSET', 400),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'owner-inspection'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const sessionBulletinConsistencyProofRoute = defineRoute({
  routeId: 'sessions.bulletin.consistencyProof.get',
  method: 'GET',
  path: '/sessions/:sessionId/bulletin/consistency-proof',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: SessionBulletinParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
    query: ConsistencyProofQuerySchema,
  },
  responses: [jsonResponse(200, ConsistencyProofResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('INVALID_SIZE', 400),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'range-validation', 'root-history'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const sessionVoteInclusionProofRoute = defineRoute({
  routeId: 'sessions.votes.inclusionProof.get',
  method: 'GET',
  path: '/sessions/:sessionId/votes/:voteId/inclusion-proof',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: SessionVoteInclusionProofParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
  },
  responses: [jsonResponse(200, BulletinProofResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('INVALID_VOTE_ID', 400),
    standardJsonError('VOTE_NOT_FOUND', 404),
    standardJsonError('VERIFICATION_FAILED', 400, 'ct-proof-unavailable'),
    standardJsonError('SESSION_NOT_FINALIZED', 400),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: [
    'path-session-capability',
    'vote-proof-ownership',
    'ct-proof-material',
    'finalized-session',
    'finalization-authority',
  ],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const currentFinalizationBitmapProofRoute = defineRoute({
  routeId: 'sessions.finalizations.current.bitmapProof.get',
  method: 'GET',
  path: '/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: CurrentFinalizationBitmapProofParamsSchema,
    headers: bitmapProofHeadersSchema,
  },
  responses: [
    jsonResponse(200, BitmapProofResponseSchema),
    jsonResponseExempt(304, 'conditional-request-not-modified'),
  ],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('INVALID_BITMAP_PROOF_REQUEST', 400),
    standardJsonError('USER_NOT_VOTED', 400),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'finalized-session', 'finalization-authority', 'private-cache-vary'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const sessionBulletinSthRoute = defineRoute({
  routeId: 'sessions.bulletin.sth.get',
  method: 'GET',
  path: '/sessions/:sessionId/bulletin/sth',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: SessionBulletinParamsSchema,
    headers: sthHeadersSchema,
    query: SthQuerySchema,
  },
  responses: [jsonResponse(200, SthResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('SESSION_NOT_FINALIZED', 404),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'same-origin', 'finalized-session', 'finalization-authority'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const currentFinalizationInputCommitmentRoute = defineRoute({
  routeId: 'sessions.finalizations.current.inputCommitment.get',
  method: 'GET',
  path: '/sessions/:sessionId/finalizations/current/input-commitment',
  kind: 'readonly',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: CurrentFinalizationInputCommitmentParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
  },
  responses: [jsonResponse(200, InputCommitmentResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('SESSION_NOT_FINALIZED', 400),
    standardJsonError('CT_PROOF_UNAVAILABLE', 400),
    standardJsonError('INTERNAL_ERROR', 500, 'input-commitment-validation-or-handler-failure'),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'finalized-session', 'finalization-authority', 'hash-only'],
  bodySize: noBodySize,
  sourceIp: noSourceIp,
  productionBypass: 'not-applicable',
});

export const createSessionRoute = defineRoute({
  routeId: 'session.post',
  method: 'POST',
  path: '/sessions',
  kind: 'mutation',
  lifecycle: 'active',
  authScope: 'public-mutation',
  capabilityScope: 'none',
  request: {
    body: SessionCreateRequestSchema,
    emptyBody: 'empty-object',
  },
  responses: [jsonResponse(200, SessionResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    ...BODY_ERROR_RESPONSES,
    ...TURNSTILE_ERROR_RESPONSES,
    standardJsonError('GLOBAL_LIMIT_EXCEEDED', 503),
    standardJsonError('SESSION_LIMIT_EXCEEDED', 503),
  ]),
  dataClassification: 'public-session-issued',
  admissionControls: [
    'body-size',
    'malformed-json',
    'turnstile-session-action',
    'rate-limit',
    'capability-issuance',
    'operator-gated-develop-session-create',
    'non-operator-develop-gate',
    'ungated-public-server-turnstile-required',
  ],
  bodySize: apiBodySize,
  sourceIp: trustedProxySourceIp,
  rateLimit: clientIpRateLimit,
  turnstile: turnstile('session'),
  productionBypass: 'operator-gated-develop-only',
  targetAdmission: {
    nonOperatorDevelop: 'blocked-by-outer-operator-gate',
    operatorGatedDevelop: 'enabled-for-production-equivalent-smoke',
    ungatedPublic: 'requires-explicit-public-enable-and-server-turnstile',
    runtimeEnforcementHandoff: 'trusted-proxy-and-public-admission',
  },
});

export const submitVoteRoute = defineRoute({
  routeId: 'vote.post',
  method: 'POST',
  path: '/sessions/:sessionId/votes',
  kind: 'mutation',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: SessionParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
    body: VoteRequestSchema,
  },
  responses: [jsonResponse(200, VoteResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    ...BODY_ERROR_RESPONSES,
    ...TURNSTILE_ERROR_RESPONSES,
    standardJsonError('GLOBAL_LIMIT_EXCEEDED', 503),
    standardJsonError('ALREADY_VOTED', 400),
    standardJsonError('SESSION_FINALIZED', 400),
    standardJsonError('INVALID_COMMITMENT', 400),
    standardJsonError('DUPLICATE_VOTE', 409),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: [
    'path-session-capability',
    'turnstile-vote-action',
    'rate-limit',
    'body-size',
    'malformed-json',
    'duplicate-vote',
    'finalized-session-rejects',
  ],
  bodySize: apiBodySize,
  sourceIp: trustedProxySourceIp,
  rateLimit: clientIpRateLimit,
  turnstile: turnstile('vote'),
  productionBypass: 'deny-outside-approved-non-production',
});

export const createFinalizationRoute = defineRoute({
  routeId: 'sessions.finalizations.post',
  method: 'POST',
  path: '/sessions/:sessionId/finalizations',
  kind: 'mutation',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: FinalizationCreateParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
    body: FinalizationCreateRequestSchema,
  },
  responses: [jsonResponse(200, FinalizationResponseSchema), jsonResponse(202, FinalizationResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    ...BODY_ERROR_RESPONSES,
    ...TURNSTILE_ERROR_RESPONSES,
    ...FINALIZE_RATE_LIMIT_ERROR_RESPONSES,
    standardJsonError('INVALID_IMAGE_ID', 400),
    standardJsonError('SESSION_ALREADY_FINALIZED', 400),
    standardJsonError('USER_NOT_VOTED', 400),
    standardJsonError('VOTING_NOT_COMPLETE', 400),
    standardJsonError('INVALID_FINALIZATION_ARTIFACT', 500),
    standardJsonError('VERIFICATION_FAILED', 400),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: [
    'path-session-capability',
    'turnstile-finalize-action',
    'rate-limit',
    'body-size',
    'malformed-json',
    'finalized-session',
    'finalization-transition-policy',
  ],
  bodySize: apiBodySize,
  sourceIp: trustedProxySourceIp,
  rateLimit: clientIpAndGlobalRateLimit,
  turnstile: turnstile('finalize'),
  productionBypass: 'deny-outside-approved-non-production',
});

export const cancelFinalizationRoute = defineRoute({
  routeId: 'sessions.finalizations.cancel.post',
  method: 'POST',
  path: '/sessions/:sessionId/finalizations/:finalizationId/cancel',
  kind: 'mutation',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: FinalizationCancelParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
    body: FinalizationCancelRequestSchema,
  },
  responses: [jsonResponse(200, FinalizationResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    ...BODY_ERROR_RESPONSES,
    standardJsonError('GLOBAL_LIMIT_EXCEEDED', 503),
    standardJsonError('ASYNC_FINALIZATION_DISABLED', 404),
    standardJsonError('FINALIZATION_NOT_CANCELLABLE', 409),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: ['path-session-capability', 'rate-limit', 'body-size', 'malformed-json', 'finalization-id'],
  bodySize: apiBodySize,
  sourceIp: trustedProxySourceIp,
  rateLimit: clientIpRateLimit,
  turnstile: noTurnstile,
  productionBypass: 'deny-outside-approved-non-production',
});

export const recordVerificationObservationRoute = defineRoute({
  routeId: 'sessions.finalizations.verification.observations.post',
  method: 'POST',
  path: '/sessions/:sessionId/finalizations/:finalizationId/verification/observations',
  kind: 'mutation',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: VerificationResourceParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
    body: VerificationObservationRequestSchema,
  },
  responses: [jsonResponse(200, VerificationObservationResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    ...BODY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('SESSION_NOT_FINALIZED', 400),
    standardJsonError('USER_NOT_VOTED', 400),
    standardJsonError('VERIFICATION_OBSERVATION_CONFLICT', 409),
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: [
    'path-session-capability',
    'api-gateway-default-throttle',
    'body-size',
    'malformed-json',
    'finalized-session',
    'finalization-authority',
    'finalization-id',
    'durable-observation-cas',
  ],
  bodySize: apiBodySize,
  sourceIp: noSourceIp,
  rateLimit: noRateLimit,
  turnstile: noTurnstile,
  productionBypass: 'deny-outside-approved-non-production',
});

export const runVerificationRoute = defineRoute({
  routeId: 'sessions.finalizations.verification.post',
  method: 'POST',
  path: '/sessions/:sessionId/finalizations/:finalizationId/verification',
  kind: 'mutation',
  lifecycle: 'active',
  authScope: 'path-session-capability',
  capabilityScope: 'path',
  request: {
    params: VerificationResourceParamsSchema,
    headers: PathSessionCapabilityHeadersSchema,
    body: VerificationRunRequestSchema,
  },
  responses: [jsonResponse(200, VerificationRunResponseSchema), jsonResponse(202, VerificationRunResponseSchema)],
  publicErrorShape: 'standard-error-envelope',
  publicErrors: publicErrors('standard-error-envelope', [
    ...MOUNTED_ROUTE_ERROR_RESPONSES,
    ...PATH_SESSION_CAPABILITY_ERROR_RESPONSES,
    ...BODY_ERROR_RESPONSES,
    standardJsonError('SESSION_NOT_FOUND', 404),
    standardJsonError('SESSION_NOT_FINALIZED', 400),
    standardJsonError('FINALIZATION_NOT_CURRENT', 409),
    ...FINALIZE_RATE_LIMIT_ERROR_RESPONSES,
  ]),
  dataClassification: 'owner-scoped-public-projection',
  admissionControls: [
    'path-session-capability',
    'rate-limit',
    'body-size',
    'malformed-json',
    'finalization-id',
    'finalized-session',
    'finalization-authority',
    'expected-image-id',
  ],
  bodySize: apiBodySize,
  sourceIp: trustedProxySourceIp,
  rateLimit: clientIpAndGlobalRateLimit,
  turnstile: noTurnstile,
  productionBypass: 'deny-outside-approved-non-production',
});

export const API_ROUTES = {
  progress: progressRoute,
  verification: verificationRoute,
  currentFinalization: currentFinalizationRoute,
  finalizationArtifactBundle: finalizationArtifactBundleRoute,
  finalizationArtifactReport: finalizationArtifactReportRoute,
  sessionBulletin: sessionBulletinRoute,
  sessionBulletinConsistencyProof: sessionBulletinConsistencyProofRoute,
  sessionVoteInclusionProof: sessionVoteInclusionProofRoute,
  currentFinalizationBitmapProof: currentFinalizationBitmapProofRoute,
  sessionBulletinSth: sessionBulletinSthRoute,
  currentFinalizationInputCommitment: currentFinalizationInputCommitmentRoute,
  createSession: createSessionRoute,
  submitVote: submitVoteRoute,
  createFinalization: createFinalizationRoute,
  cancelFinalization: cancelFinalizationRoute,
  recordVerificationObservation: recordVerificationObservationRoute,
  runVerification: runVerificationRoute,
} as const satisfies Record<string, ApiRouteContract>;

export const TARGET_API_ROUTE_CONTRACTS = Object.values(API_ROUTES);

export type ApiContractRouteId = (typeof TARGET_API_ROUTE_CONTRACTS)[number]['routeId'];
export type ApiRoute = (typeof TARGET_API_ROUTE_CONTRACTS)[number];
export type ApiRouteRegistry = typeof API_ROUTES;

type RouteLookup<TMethod extends HttpMethod, TPath extends string> = string extends TPath
  ? ApiRouteContract
  : Extract<ApiRoute, { method: TMethod; path: TPath }> extends never
    ? ApiRouteContract
    : Extract<ApiRoute, { method: TMethod; path: TPath }>;

export function getApiRouteContract<const TMethod extends HttpMethod, const TPath extends string>(
  method: TMethod,
  path: TPath,
): RouteLookup<TMethod, TPath> {
  const route = TARGET_API_ROUTE_CONTRACTS.find((contract) => contract.method === method && contract.path === path);
  if (!route) {
    throw new Error(`API contract route not registered: ${method} ${path}`);
  }
  return route as RouteLookup<TMethod, TPath>;
}

function stripBasePath(pathname: string, basePath: string): string | null {
  if (!basePath) {
    return pathname;
  }
  if (pathname === basePath) {
    return '/';
  }
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

function staticSegmentCount(route: ApiRoute): number {
  return route.path.split('/').filter((segment) => segment.length > 0 && !segment.startsWith(':')).length;
}

const MATCH_ORDER = [...TARGET_API_ROUTE_CONTRACTS].sort((left, right) => {
  const staticDifference = staticSegmentCount(right) - staticSegmentCount(left);
  return staticDifference !== 0 ? staticDifference : right.path.length - left.path.length;
});

export type MatchedApiRoute = {
  [TKey in keyof ApiRouteRegistry]: {
    route: ApiRouteRegistry[TKey];
    params: RouteInput<ApiRouteRegistry[TKey]> extends { params: infer TParams } ? TParams : Record<never, never>;
  };
}[keyof ApiRouteRegistry];

export function matchApiRoute(method: HttpMethod, pathname: string, basePath = '/api'): MatchedApiRoute | null {
  const candidate = stripBasePath(pathname.split(/[?#]/, 1)[0] ?? '', basePath);
  if (candidate === null) {
    return null;
  }
  for (const route of MATCH_ORDER) {
    if (route.method !== method) {
      continue;
    }
    const contract: ApiRouteContract = route;
    const params = matchRoutePath(contract, candidate);
    if (params !== null) {
      return { route, params } as MatchedApiRoute;
    }
  }
  return null;
}

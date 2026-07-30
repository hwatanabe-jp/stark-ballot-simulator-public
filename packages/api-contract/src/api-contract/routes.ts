export type ApiContractMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export type ApiContractRouteKind = 'readonly' | 'mutation';
export type ApiContractLifecycle = 'active' | 'retired' | 'internal-operator-only';
export type ApiContractAuthScope =
  | 'public-mutation'
  | 'header-session-capability'
  | 'path-session-capability'
  | 'query-session-capability'
  | 'same-origin-session-capability'
  | 'callback-authenticity'
  | 'none';
export type ApiContractDataClassification =
  | 'public-session-issued'
  | 'owner-scoped-public-projection'
  | 'owner-scoped-private-report'
  | 'internal-operator'
  | 'retired-private';

export type ApiContractSchemaName = `${string}Schema`;
export type ApiContractRouteId =
  | 'debug.enable.get'
  | 'progress.get'
  | 'verify.get'
  | 'sessions.status.get'
  | 'verification.bundle.get'
  | 'verification.report.get'
  | 'bulletin.get'
  | 'bulletin.consistencyProof.get'
  | 'bulletin.voteProof.get'
  | 'botdata.get'
  | 'bitmapProof.get'
  | 'sth.get'
  | 'zkvmInputHash.get'
  | 'session.post'
  | 'vote.post'
  | 'finalize.post'
  | 'finalizeCancel.post'
  | 'finalizeCallback.post'
  | 'verificationObservation.post'
  | 'verificationRun.post';

export type ApiContractBodySizeLimitPath = 'API_REQUEST_BODY_LIMIT_BYTES' | 'FINALIZE_CALLBACK_BODY_LIMIT_BYTES';
export type ApiContractProductionBypassPosture =
  'not-applicable' | 'deny-outside-approved-non-production' | 'operator-gated-develop-only' | 'internal-operator-only';

export interface ApiContractRequestSchemas {
  params?: ApiContractSchemaName;
  query?: ApiContractSchemaName;
  headers?: ApiContractSchemaName;
  body?: ApiContractSchemaName;
}

export interface ApiContractResponseSchema {
  status: number;
  content: 'json' | 'binary';
  schema?: ApiContractSchemaName;
  exemptReason?: string;
}

export interface ApiContractPublicErrors {
  envelope: 'standard-error-envelope' | 'route-specific-error-envelope';
  codes: readonly string[];
}

export interface ApiContractBodySize {
  applies: boolean;
  limitPath?: ApiContractBodySizeLimitPath;
}

export interface ApiContractSourceIp {
  dependency: 'not-required' | 'trusted-proxy-required-for-target-runtime';
  runtimeEnforcementHandoff: 'none' | 'plans-07-and-11';
}

export interface ApiContractRateLimit {
  required: boolean;
  scope: 'none' | 'client-ip' | 'session' | 'session-and-client-ip' | 'callback-authenticity';
  sourceIpDependency: ApiContractSourceIp['dependency'];
}

export interface ApiContractTurnstile {
  required: boolean;
  action?: 'session' | 'vote' | 'finalize';
  tokenLocations?: readonly ['body.turnstileToken', 'body.cf-turnstile-response', 'body.cfTurnstileResponse'];
  hostnameValidation?: 'required';
  productionBypass: 'not-applicable' | 'deny-outside-approved-non-production';
}

export interface ApiContractTargetAdmission {
  nonOperatorDevelop: 'blocked-by-outer-operator-gate';
  operatorGatedDevelop: 'enabled-for-production-equivalent-smoke';
  ungatedPublic: 'requires-explicit-public-enable-and-server-turnstile';
  runtimeEnforcementHandoff: 'plans-07-and-11';
}

export interface ApiRouteContract {
  routeId: ApiContractRouteId;
  method: ApiContractMethod;
  path: string;
  kind: ApiContractRouteKind;
  lifecycle: ApiContractLifecycle;
  authScope: ApiContractAuthScope;
  capabilityScope: 'none' | 'header' | 'path' | 'query';
  requestSchemas: ApiContractRequestSchemas;
  responseSchemas: readonly ApiContractResponseSchema[];
  requestSchema?: string;
  responseSchema?: string;
  responseSchemaExemptReason?: string;
  publicErrorShape: 'standard-error-envelope' | 'route-specific-error-envelope';
  publicErrors: ApiContractPublicErrors;
  dataClassification: ApiContractDataClassification;
  admissionControls: readonly string[];
  bodySize: ApiContractBodySize;
  sourceIp: ApiContractSourceIp;
  rateLimit?: ApiContractRateLimit;
  turnstile?: ApiContractTurnstile;
  productionBypass: ApiContractProductionBypassPosture;
  targetAdmission?: ApiContractTargetAdmission;
  variants?: readonly ApiRouteVariantContract[];
}

export interface ApiRouteVariantContract {
  selector: string;
  lifecycle: ApiContractLifecycle;
  dataClassification: ApiContractDataClassification;
  admissionControls: readonly string[];
}

const SESSION_HEADERS_SCHEMA = 'SessionCapabilityHeadersSchema';
const PATH_SESSION_HEADERS_SCHEMA = 'PathSessionCapabilityHeadersSchema';
const STANDARD_ERROR_CODES = [
  'INTERNAL_ERROR',
  'INVALID_REQUEST',
  'SESSION_NOT_FOUND',
  'SESSION_CAPABILITY_REQUIRED',
] as const;
const TURNSTILE_BODY_TOKEN_LOCATIONS = [
  'body.turnstileToken',
  'body.cf-turnstile-response',
  'body.cfTurnstileResponse',
] as const;

const noBodySize: ApiContractBodySize = { applies: false };
const apiBodySize: ApiContractBodySize = { applies: true, limitPath: 'API_REQUEST_BODY_LIMIT_BYTES' };
const callbackBodySize: ApiContractBodySize = {
  applies: true,
  limitPath: 'FINALIZE_CALLBACK_BODY_LIMIT_BYTES',
};
const noSourceIp: ApiContractSourceIp = { dependency: 'not-required', runtimeEnforcementHandoff: 'none' };
const trustedProxySourceIp: ApiContractSourceIp = {
  dependency: 'trusted-proxy-required-for-target-runtime',
  runtimeEnforcementHandoff: 'plans-07-and-11',
};
const noRateLimit: ApiContractRateLimit = {
  required: false,
  scope: 'none',
  sourceIpDependency: 'not-required',
};
const clientIpRateLimit: ApiContractRateLimit = {
  required: true,
  scope: 'client-ip',
  sourceIpDependency: 'trusted-proxy-required-for-target-runtime',
};
const sessionRateLimit: ApiContractRateLimit = {
  required: true,
  scope: 'session-and-client-ip',
  sourceIpDependency: 'trusted-proxy-required-for-target-runtime',
};
const noTurnstile: ApiContractTurnstile = { required: false, productionBypass: 'not-applicable' };

function standardErrors(...codes: readonly string[]): ApiContractPublicErrors {
  return { envelope: 'standard-error-envelope', codes: [...STANDARD_ERROR_CODES, ...codes] };
}

function routeSpecificErrors(...codes: readonly string[]): ApiContractPublicErrors {
  return { envelope: 'route-specific-error-envelope', codes: [...STANDARD_ERROR_CODES, ...codes] };
}

function jsonResponse(status: number, schema: ApiContractSchemaName): ApiContractResponseSchema {
  return { status, content: 'json', schema };
}

function jsonResponseExempt(status: number, exemptReason: string): ApiContractResponseSchema {
  return { status, content: 'json', exemptReason };
}

function binaryResponse(status: number, exemptReason: string): ApiContractResponseSchema {
  return { status, content: 'binary', exemptReason };
}

function turnstile(action: 'session' | 'vote' | 'finalize'): ApiContractTurnstile {
  return {
    required: true,
    action,
    tokenLocations: TURNSTILE_BODY_TOKEN_LOCATIONS,
    hostnameValidation: 'required',
    productionBypass: 'deny-outside-approved-non-production',
  };
}

export const TARGET_API_ROUTE_CONTRACTS = [
  {
    routeId: 'debug.enable.get',
    method: 'GET',
    path: '/debug/enable',
    kind: 'readonly',
    lifecycle: 'retired',
    authScope: 'none',
    capabilityScope: 'none',
    requestSchemas: {},
    responseSchemas: [jsonResponse(410, 'StandardErrorResponseSchema')],
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('ROUTE_RETIRED'),
    dataClassification: 'retired-private',
    admissionControls: ['target-runtime-rejects-public-debug-enable'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'progress.get',
    method: 'GET',
    path: '/progress',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA },
    responseSchemas: [jsonResponse(200, 'ProgressResponseSchema')],
    responseSchema: 'ProgressResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('SESSION_ID_REQUIRED', 'SESSION_CAPABILITY_INVALID'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['session-header-capability', 'current-contract-session'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'verify.get',
    method: 'GET',
    path: '/verify',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, query: 'VerifyQuerySchema' },
    responseSchemas: [jsonResponse(200, 'VerifyResponseSchema'), jsonResponse(200, 'VerifyFailClosedResponseSchema')],
    responseSchema: 'VerifyResponseSchema|VerifyFailClosedResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('SESSION_ID_REQUIRED', 'SESSION_CAPABILITY_INVALID', 'SESSION_NOT_FINALIZED'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['session-header-capability', 'finalized-session', 'current-artifact'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
    variants: [
      {
        selector: 'includeJournal=1',
        lifecycle: 'active',
        dataClassification: 'owner-scoped-public-projection',
        admissionControls: ['session-header-capability', 'finalized-session', 'current-artifact'],
      },
    ],
  },
  {
    routeId: 'sessions.status.get',
    method: 'GET',
    path: '/sessions/:sessionId/status',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'path-session-capability',
    capabilityScope: 'path',
    requestSchemas: { params: 'SessionStatusParamsSchema', headers: PATH_SESSION_HEADERS_SCHEMA },
    responseSchemas: [jsonResponse(200, 'SessionStatusResponseSchema')],
    responseSchema: 'SessionStatusResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('SESSION_CAPABILITY_INVALID', 'UNSUPPORTED_CURRENT_ARTIFACT'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['path-session-capability', 'current-artifact', 'finalization-state'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'verification.bundle.get',
    method: 'GET',
    path: '/verification/bundles/:sessionId/:executionId',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'path-session-capability',
    capabilityScope: 'path',
    requestSchemas: { params: 'VerificationBundleParamsSchema', headers: PATH_SESSION_HEADERS_SCHEMA },
    responseSchemas: [
      binaryResponse(200, 'binary-public-bundle-download'),
      binaryResponse(206, 'binary-public-bundle-range-download'),
    ],
    responseSchemaExemptReason: 'binary-public-bundle-download',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors(
      'INVALID_BUNDLE_REFERENCE',
      'BUNDLE_NOT_FOUND',
      'BUNDLE_DOWNLOAD_FAILED',
      'BUNDLE_REQUIRES_RANGE_DOWNLOAD',
      'INVALID_RANGE',
      'UNSUPPORTED_CURRENT_ARTIFACT',
      'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
    ),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['path-session-capability', 'execution-id', 'range-supported', 'public-bundle-allowlist'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'verification.report.get',
    method: 'GET',
    path: '/verification/bundles/:sessionId/:executionId/report',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'path-session-capability',
    capabilityScope: 'path',
    requestSchemas: { params: 'VerificationBundleParamsSchema', headers: PATH_SESSION_HEADERS_SCHEMA },
    responseSchemas: [jsonResponseExempt(200, 'protected-report-artifact-download')],
    responseSchemaExemptReason: 'protected-report-artifact-download',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors(
      'INVALID_BUNDLE_REFERENCE',
      'REPORT_NOT_FOUND',
      'REPORT_DOWNLOAD_FAILED',
      'REPORT_DOWNLOAD_TOO_LARGE',
      'UNSUPPORTED_CURRENT_ARTIFACT',
      'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
    ),
    dataClassification: 'owner-scoped-private-report',
    admissionControls: ['path-session-capability', 'execution-id', 'inline-report-size-limit'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'bulletin.get',
    method: 'GET',
    path: '/bulletin',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, query: 'BulletinQuerySchema' },
    responseSchemas: [jsonResponse(200, 'BulletinResponseSchema')],
    responseSchema: 'BulletinResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('SESSION_ID_REQUIRED', 'SESSION_CAPABILITY_INVALID', 'UNSUPPORTED_CURRENT_ARTIFACT'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['session-header-capability', 'owner-inspection', 'unsupported-artifact-rejects'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'bulletin.consistencyProof.get',
    method: 'GET',
    path: '/bulletin/consistency-proof',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, query: 'ConsistencyProofQuerySchema' },
    responseSchemas: [jsonResponse(200, 'ConsistencyProofResponseSchema')],
    responseSchema: 'ConsistencyProofResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('INVALID_SIZE', 'SESSION_CAPABILITY_INVALID', 'UNSUPPORTED_CURRENT_ARTIFACT'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: [
      'session-header-capability',
      'range-validation',
      'root-history',
      'current-artifact',
      'unsupported-artifact-rejects',
    ],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'bulletin.voteProof.get',
    method: 'GET',
    path: '/bulletin/:voteId/proof',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { params: 'BulletinVoteProofParamsSchema', headers: SESSION_HEADERS_SCHEMA },
    responseSchemas: [jsonResponse(200, 'BulletinProofResponseSchema')],
    responseSchema: 'BulletinProofResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors(
      'CT_PROOF_UNAVAILABLE',
      'SESSION_CAPABILITY_INVALID',
      'SESSION_NOT_FINALIZED',
      'UNSUPPORTED_CURRENT_ARTIFACT',
    ),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: [
      'session-header-capability',
      'vote-proof-ownership',
      'ct-proof-material',
      'finalized-session',
      'current-artifact',
      'unsupported-artifact-rejects',
    ],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'botdata.get',
    method: 'GET',
    path: '/botdata/:id',
    kind: 'readonly',
    lifecycle: 'retired',
    authScope: 'none',
    capabilityScope: 'none',
    requestSchemas: { params: 'BotDataParamsSchema' },
    responseSchemas: [jsonResponse(410, 'StandardErrorResponseSchema')],
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('ROUTE_RETIRED'),
    dataClassification: 'retired-private',
    admissionControls: ['target-runtime-rejects-public-botdata'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'bitmapProof.get',
    method: 'GET',
    path: '/bitmap-proof',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, query: 'BitmapProofQuerySchema' },
    responseSchemas: [jsonResponse(200, 'BitmapProofResponseSchema')],
    responseSchema: 'BitmapProofResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('INVALID_BITMAP_PROOF_REQUEST', 'UNSUPPORTED_CURRENT_ARTIFACT'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['session-header-capability', 'finalized-session', 'current-artifact', 'private-cache-vary'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'sth.get',
    method: 'GET',
    path: '/sth',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'same-origin-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, query: 'SthQuerySchema' },
    responseSchemas: [jsonResponse(200, 'SthResponseSchema')],
    responseSchema: 'SthResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('SESSION_CAPABILITY_INVALID', 'SESSION_NOT_FINALIZED', 'SAME_ORIGIN_REQUIRED'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['session-header-capability', 'same-origin', 'finalized-session', 'current-artifact'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
  },
  {
    routeId: 'zkvmInputHash.get',
    method: 'GET',
    path: '/zkvm-input-hash',
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'query-session-capability',
    capabilityScope: 'query',
    requestSchemas: { query: 'ZkVMInputHashQuerySchema', headers: PATH_SESSION_HEADERS_SCHEMA },
    responseSchemas: [jsonResponse(200, 'ZkVMInputHashResponseSchema')],
    responseSchema: 'ZkVMInputHashResponseSchema',
    publicErrorShape: 'route-specific-error-envelope',
    publicErrors: routeSpecificErrors('MISSING_SESSION_ID', 'ROUTE_RETIRED', 'CT_PROOF_UNAVAILABLE'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['query-session-capability', 'finalized-session', 'current-artifact', 'hash-only'],
    bodySize: noBodySize,
    sourceIp: noSourceIp,
    productionBypass: 'not-applicable',
    variants: [
      {
        selector: 'includeData=<truthy>',
        lifecycle: 'retired',
        dataClassification: 'retired-private',
        admissionControls: ['target-runtime-rejects-private-input-data'],
      },
    ],
  },
  {
    routeId: 'session.post',
    method: 'POST',
    path: '/session',
    kind: 'mutation',
    lifecycle: 'active',
    authScope: 'public-mutation',
    capabilityScope: 'none',
    requestSchemas: { body: 'SessionCreateRequestSchema' },
    responseSchemas: [jsonResponse(200, 'SessionResponseSchema')],
    requestSchema: 'SessionCreateRequestSchema',
    responseSchema: 'SessionResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('INVALID_REQUEST', 'TURNSTILE_FAILED', 'RATE_LIMITED'),
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
      runtimeEnforcementHandoff: 'plans-07-and-11',
    },
  },
  {
    routeId: 'vote.post',
    method: 'POST',
    path: '/vote',
    kind: 'mutation',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, body: 'VoteRequestSchema' },
    responseSchemas: [jsonResponse(200, 'VoteResponseSchema')],
    requestSchema: 'VoteRequestSchema',
    responseSchema: 'VoteResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('INVALID_REQUEST', 'TURNSTILE_FAILED', 'RATE_LIMITED', 'DUPLICATE_VOTE'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: [
      'session-header-capability',
      'turnstile-vote-action',
      'rate-limit',
      'body-size',
      'malformed-json',
      'duplicate-vote',
      'finalized-session-rejects',
    ],
    bodySize: apiBodySize,
    sourceIp: trustedProxySourceIp,
    rateLimit: sessionRateLimit,
    turnstile: turnstile('vote'),
    productionBypass: 'deny-outside-approved-non-production',
  },
  {
    routeId: 'finalize.post',
    method: 'POST',
    path: '/finalize',
    kind: 'mutation',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, body: 'FinalizeRequestSchema' },
    responseSchemas: [
      jsonResponse(200, 'FinalizeSyncResponseSchema'),
      jsonResponse(202, 'FinalizeAcceptedResponseSchema'),
    ],
    requestSchema: 'FinalizeRequestSchema',
    responseSchema: 'FinalizeSyncResponseSchema|FinalizeAcceptedResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors(
      'INVALID_SCENARIO',
      'INVALID_IMAGE_ID',
      'TURNSTILE_FAILED',
      'RATE_LIMITED',
      'SESSION_ALREADY_FINALIZED',
    ),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: [
      'session-header-capability',
      'turnstile-finalize-action',
      'rate-limit',
      'body-size',
      'malformed-json',
      'finalized-session',
      'current-artifact',
    ],
    bodySize: apiBodySize,
    sourceIp: trustedProxySourceIp,
    rateLimit: sessionRateLimit,
    turnstile: turnstile('finalize'),
    productionBypass: 'deny-outside-approved-non-production',
  },
  {
    routeId: 'finalizeCancel.post',
    method: 'POST',
    path: '/finalize/cancel',
    kind: 'mutation',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, body: 'FinalizeCancelRequestSchema' },
    responseSchemas: [jsonResponse(200, 'FinalizeCancelResponseSchema')],
    requestSchema: 'FinalizeCancelRequestSchema',
    responseSchema: 'FinalizeCancelResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors(
      'INVALID_REQUEST',
      'RATE_LIMITED',
      'ASYNC_FINALIZATION_DISABLED',
      'CANCELLATION_UNSUPPORTED',
      'FINALIZATION_NOT_CANCELLABLE',
    ),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: ['session-header-capability', 'rate-limit', 'body-size', 'malformed-json', 'execution-id'],
    bodySize: apiBodySize,
    sourceIp: trustedProxySourceIp,
    rateLimit: sessionRateLimit,
    turnstile: noTurnstile,
    productionBypass: 'deny-outside-approved-non-production',
  },
  {
    routeId: 'finalizeCallback.post',
    method: 'POST',
    path: '/finalize/callback',
    kind: 'mutation',
    lifecycle: 'internal-operator-only',
    authScope: 'callback-authenticity',
    capabilityScope: 'none',
    requestSchemas: {},
    responseSchemas: [jsonResponse(200, 'FinalizeCallbackResponseSchema')],
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('CALLBACK_AUTH_REQUIRED', 'INVALID_CALLBACK_PAYLOAD'),
    dataClassification: 'internal-operator',
    admissionControls: ['hmac-callback-authenticity', 'timestamp-skew', 'body-size', 'excluded-from-normal-lambda'],
    bodySize: callbackBodySize,
    sourceIp: noSourceIp,
    rateLimit: noRateLimit,
    turnstile: noTurnstile,
    productionBypass: 'internal-operator-only',
  },
  {
    routeId: 'verificationObservation.post',
    method: 'POST',
    path: '/verification/observation',
    kind: 'mutation',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, body: 'VerificationObservationRequestSchema' },
    responseSchemas: [jsonResponse(200, 'VerificationObservationResponseSchema')],
    requestSchema: 'VerificationObservationRequestSchema',
    responseSchema: 'VerificationObservationResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors(
      'SESSION_NOT_FINALIZED',
      'UNSUPPORTED_CURRENT_ARTIFACT',
      'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
      'VERIFICATION_OBSERVATION_CONFLICT',
    ),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: [
      'session-header-capability',
      'api-gateway-default-throttle',
      'body-size',
      'malformed-json',
      'finalized-session',
      'current-artifact',
      'execution-id',
      'durable-observation-cas',
    ],
    bodySize: apiBodySize,
    sourceIp: noSourceIp,
    rateLimit: noRateLimit,
    turnstile: noTurnstile,
    productionBypass: 'deny-outside-approved-non-production',
  },
  {
    routeId: 'verificationRun.post',
    method: 'POST',
    path: '/verification/run',
    kind: 'mutation',
    lifecycle: 'active',
    authScope: 'header-session-capability',
    capabilityScope: 'header',
    requestSchemas: { headers: SESSION_HEADERS_SCHEMA, body: 'VerificationRunRequestSchema' },
    responseSchemas: [jsonResponse(200, 'VerificationRunResponseSchema')],
    requestSchema: 'VerificationRunRequestSchema',
    responseSchema: 'VerificationRunResponseSchema',
    publicErrorShape: 'standard-error-envelope',
    publicErrors: standardErrors('RATE_LIMITED', 'VERIFICATION_BUNDLE_UNAVAILABLE', 'EXPECTED_IMAGE_ID_UNAVAILABLE'),
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: [
      'session-header-capability',
      'rate-limit',
      'body-size',
      'malformed-json',
      'finalized-session',
      'current-artifact',
      'expected-image-id',
    ],
    bodySize: apiBodySize,
    sourceIp: trustedProxySourceIp,
    rateLimit: sessionRateLimit,
    turnstile: noTurnstile,
    productionBypass: 'deny-outside-approved-non-production',
  },
] as const satisfies readonly ApiRouteContract[];

export function getApiRouteContract(method: ApiContractMethod, path: string): ApiRouteContract {
  const route = TARGET_API_ROUTE_CONTRACTS.find((contract) => contract.method === method && contract.path === path);
  if (!route) {
    throw new Error(`API contract route not registered: ${method} ${path}`);
  }
  return route;
}

export function isRetiredTargetRouteVariant(contract: ApiRouteContract, requestUrl: string): boolean {
  if (contract.method !== 'GET' || contract.path !== '/zkvm-input-hash') {
    return false;
  }
  const includeData = new URL(requestUrl).searchParams.get('includeData');
  if (!includeData) {
    return false;
  }
  return ['true', '1', 'yes'].includes(includeData.toLowerCase());
}

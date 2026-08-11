import type { ApiContractRouteId } from '@stark-ballot/api-contract/routes';

export interface PublicContractCallerEvidence {
  readonly path: string;
  readonly sourcePatterns: readonly RegExp[];
}

export interface PublicContractCallerInventoryEntry {
  readonly browser: readonly PublicContractCallerEvidence[];
  readonly mockApi: readonly PublicContractCallerEvidence[];
  readonly cli: readonly PublicContractCallerEvidence[];
  readonly lambda: readonly PublicContractCallerEvidence[];
  readonly stepFunctions: readonly PublicContractCallerEvidence[];
  readonly internalCallbackProducer: readonly PublicContractCallerEvidence[];
}

function evidence(path: string, ...sourcePatterns: readonly RegExp[]): PublicContractCallerEvidence {
  return { path, sourcePatterns };
}

function callers(entry: Partial<PublicContractCallerInventoryEntry> = {}): PublicContractCallerInventoryEntry {
  return {
    browser: [],
    mockApi: [],
    cli: [],
    lambda: [],
    stepFunctions: [],
    internalCallbackProducer: [],
    ...entry,
  };
}

const WEB_ARTIFACTS_PATH = 'apps/web/src/api/artifacts.ts';
const WEB_BULLETIN_PATH = 'apps/web/src/api/bulletin.ts';
const WEB_FINALIZATIONS_PATH = 'apps/web/src/api/finalizations.ts';
const WEB_PROGRESS_PATH = 'apps/web/src/api/progress.ts';
const WEB_SESSIONS_PATH = 'apps/web/src/api/sessions.ts';
const WEB_VERIFICATION_PATH = 'apps/web/src/api/verification.ts';
const WEB_VOTES_PATH = 'apps/web/src/api/votes.ts';
const MOCK_HANDLERS_PATH = 'apps/web/src/mock-api/handlers.ts';
const CLI_HELPERS_PATH = 'packages/test-support/src/testing/cli-test-helpers.ts';
const CLI_FLOW_PATH = 'scripts/tests/cli-e2e-voting-flow.ts';
const GATED_SMOKE_PATH = 'scripts/tests/develop-gated-smoke.ts';

/**
 * Reviewed first-party caller inventory for the current public wire baseline.
 *
 * The browser and CLI surfaces record direct HTTP client owners. Browser
 * components and hooks are intentionally transitive through the resource
 * clients. The mock surface records explicit contract route-handler branches.
 * Transitive orchestrators and inbound route hosts, such as the public API
 * Lambda bridge, are not callers. Empty arrays explicitly record that a
 * surface has no current caller.
 *
 * Step Functions invokes Lambdas directly, so it currently calls no HTTP
 * route. The callback route is full-Hono-only and has no current
 * in-repository HTTP producer.
 */
export const PUBLIC_CONTRACT_CALLER_INVENTORY = {
  'progress.get': callers({
    browser: [
      evidence(
        WEB_PROGRESS_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.progress,\s*buildApiRouteUrl\(API_ROUTES\.progress,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'progress\.get'/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /fetch\(`\$\{baseUrl\}\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/progress`,\s*\{\s*method: 'GET'/u,
        /const payload = await readJsonRecord\(response, 'bot progress'\);\s*const data = getRecordProperty\(payload, 'data'\)/u,
      ),
      evidence(
        GATED_SMOKE_PATH,
        /expectJsonErrorCodeRejected\(\s*'wrong capability GET \/api\/sessions\/:sessionId\/progress',\s*`\$\{baseUrl\}\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/progress`[\s\S]*?method: 'GET'/u,
      ),
    ],
  }),
  'sessions.finalizations.verification.get': callers({
    browser: [
      evidence(
        WEB_VERIFICATION_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.verification,\s*buildApiRouteUrl\(API_ROUTES\.verification/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.verification\.get'/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /buildApiRouteUrl\(API_ROUTES\.verification,\s*\{\s*params: \{ sessionId, finalizationId \}/u,
        /fetch\(new URL\(verificationPath, baseUrl\),\s*\{\s*method: API_ROUTES\.verification\.method/u,
      ),
      evidence(
        GATED_SMOKE_PATH,
        /const pollPath = buildApiRouteUrl\(API_ROUTES\.verification/u,
        /fetch\(pollUrl,\s*\{\s*method: 'GET'/u,
      ),
    ],
  }),
  'sessions.finalizations.current.get': callers({
    browser: [
      evidence(
        WEB_FINALIZATIONS_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.currentFinalization,\s*buildApiRouteUrl\(API_ROUTES\.currentFinalization/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.current\.get'/u)],
    cli: [
      evidence(
        'packages/test-support/src/testing/finalization-status-client.ts',
        /buildApiRouteUrl\(API_ROUTES\.currentFinalization,\s*\{\s*params: \{ sessionId \}/u,
        /fetch\(requestUrl,\s*\{\s*method: API_ROUTES\.currentFinalization\.method/u,
      ),
    ],
  }),
  'sessions.finalizations.artifacts.bundle.get': callers({
    browser: [
      evidence(
        WEB_ARTIFACTS_PATH,
        /buildApiRouteUrl\(API_ROUTES\.finalizationArtifactBundle/u,
        /export async function downloadBundle[\s\S]*?fetchBundleBlob\(candidate\.url, options\)/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.artifacts\.bundle\.get'/u)],
    cli: [
      evidence(
        CLI_FLOW_PATH,
        /buildArtifactUrl\(this\.baseUrl, sessionId, finalizationId, 'bundle'\)/u,
        /kind: 'bundle'/u,
        /downloadAuthenticatedBundle\(candidate\.url\)/u,
      ),
      evidence(
        GATED_SMOKE_PATH,
        /const bundleUrl = buildVerificationArtifactUrl\(options\.baseUrl, options\.sessionId, options\.finalizationId\)/u,
        /downloadAuthenticatedBundle\(bundleUrl, artifactAuthHeaders\)/u,
      ),
    ],
  }),
  'sessions.finalizations.artifacts.report.get': callers({
    browser: [
      evidence(
        WEB_ARTIFACTS_PATH,
        /buildApiRouteUrl\(API_ROUTES\.finalizationArtifactReport/u,
        /export async function fetchVerificationReport[\s\S]*?apiFetch\(candidate\.url/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.artifacts\.report\.get'/u)],
    cli: [
      evidence(
        CLI_FLOW_PATH,
        /buildArtifactUrl\(this\.baseUrl, sessionId, finalizationId, 'report'\)/u,
        /kind: 'report'/u,
        /downloadAuthenticatedReport\(candidate\.url\)/u,
      ),
      evidence(
        GATED_SMOKE_PATH,
        /const reportUrl = buildVerificationArtifactUrl\(options\.baseUrl, options\.sessionId, options\.finalizationId, true\)/u,
        /fetchAuthenticatedArtifact\('verification report', reportUrl, artifactAuthHeaders\)/u,
      ),
    ],
  }),
  'sessions.bulletin.get': callers({
    browser: [
      evidence(
        WEB_BULLETIN_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.sessionBulletin,\s*buildApiRouteUrl\(API_ROUTES\.sessionBulletin/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /const bulletinRouteId: 'sessions\.bulletin\.get' = routeId/u)],
  }),
  'sessions.bulletin.consistencyProof.get': callers({
    browser: [
      evidence(
        WEB_BULLETIN_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.sessionBulletinConsistencyProof,\s*buildApiRouteUrl\(API_ROUTES\.sessionBulletinConsistencyProof/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.bulletin\.consistencyProof\.get'/u)],
  }),
  'sessions.votes.inclusionProof.get': callers({
    browser: [
      evidence(
        WEB_BULLETIN_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.sessionVoteInclusionProof,\s*buildApiRouteUrl\(API_ROUTES\.sessionVoteInclusionProof/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.votes\.inclusionProof\.get'/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /buildApiRouteUrl\(API_ROUTES\.sessionVoteInclusionProof,\s*\{\s*params:\s*\{\s*sessionId,\s*voteId\s*\}/u,
        /fetch\(`\$\{baseUrl\}\$\{proofPath\}`,\s*\{\s*method: 'GET'/u,
      ),
    ],
  }),
  'sessions.finalizations.current.bitmapProof.get': callers({
    browser: [
      evidence(
        WEB_ARTIFACTS_PATH,
        /buildApiRouteUrl\(API_ROUTES\.currentFinalizationBitmapProof,\s*\{\s*params:/u,
        /apiFetch\(resolveWebApiUrl\(path, options\.baseUrl\),\s*\{\s*method: API_ROUTES\.currentFinalizationBitmapProof\.method/u,
        /admitJsonRouteResponse\(API_ROUTES\.currentFinalizationBitmapProof, response, 'bitmap proof'\)/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.current\.bitmapProof\.get'/u)],
  }),
  'sessions.bulletin.sth.get': callers({
    browser: [
      evidence(
        WEB_BULLETIN_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.sessionBulletinSth,\s*buildApiRouteUrl\(API_ROUTES\.sessionBulletinSth/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.bulletin\.sth\.get'/u)],
  }),
  'sessions.finalizations.current.inputCommitment.get': callers({
    browser: [
      evidence(
        WEB_ARTIFACTS_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.currentFinalizationInputCommitment,\s*buildApiRouteUrl\(API_ROUTES\.currentFinalizationInputCommitment/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.current\.inputCommitment\.get'/u)],
  }),
  'session.post': callers({
    browser: [
      evidence(
        WEB_SESSIONS_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.createSession,\s*buildApiRouteUrl\(API_ROUTES\.createSession\)/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'session\.post'/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /fetch\(`\$\{baseUrl\}\/api\/sessions`,\s*\{\s*method: 'POST'/u,
        /const payload = await readJsonRecord\(response, 'create session'\);\s*const data = getRecordProperty\(payload, 'data'\)/u,
      ),
      evidence(
        GATED_SMOKE_PATH,
        /expectCloudFrontGateRejected\(\s*'unauthenticated POST \/api\/sessions',\s*`\$\{baseUrl\}\/api\/sessions`,\s*\{\s*method: 'POST'/u,
      ),
    ],
  }),
  'vote.post': callers({
    browser: [
      evidence(
        WEB_VOTES_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.submitVote,\s*buildApiRouteUrl\(API_ROUTES\.submitVote,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'vote\.post'/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /fetch\(`\$\{baseUrl\}\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/votes`,\s*\{\s*method: 'POST'/u,
        /const payload = await readJsonRecord\(response, 'submit vote'\);\s*const data = getRecordProperty\(payload, 'data'\)/u,
      ),
    ],
  }),
  'sessions.finalizations.post': callers({
    browser: [
      evidence(
        WEB_FINALIZATIONS_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.createFinalization,\s*buildApiRouteUrl\(API_ROUTES\.createFinalization/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.post'/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /buildApiRouteUrl\(API_ROUTES\.createFinalization,\s*\{\s*params: \{ sessionId \}/u,
        /fetch\(new URL\(createPath, baseUrl\),\s*\{\s*method: API_ROUTES\.createFinalization\.method/u,
      ),
    ],
  }),
  'sessions.finalizations.cancel.post': callers({
    browser: [
      evidence(
        WEB_FINALIZATIONS_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.cancelFinalization,\s*buildApiRouteUrl\(API_ROUTES\.cancelFinalization/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.cancel\.post'/u)],
  }),
  'sessions.finalizations.verification.observations.post': callers({
    browser: [
      evidence(
        WEB_VERIFICATION_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.recordVerificationObservation,\s*buildApiRouteUrl\(API_ROUTES\.recordVerificationObservation/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.verification\.observations\.post'/u)],
  }),
  'sessions.finalizations.verification.post': callers({
    browser: [
      evidence(
        WEB_VERIFICATION_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.runVerification,\s*buildApiRouteUrl\(API_ROUTES\.runVerification,\s*\{\s*params:/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /routeId === 'sessions\.finalizations\.verification\.post'/u)],
    cli: [
      evidence(
        GATED_SMOKE_PATH,
        /const verificationPath = buildApiRouteUrl\(API_ROUTES\.runVerification/u,
        /fetch\(new URL\(verificationPath, options\.baseUrl\),\s*\{\s*method: 'POST'/u,
      ),
    ],
  }),
} satisfies Record<ApiContractRouteId, PublicContractCallerInventoryEntry>;

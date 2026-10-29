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
 * clients. The mock surface records explicit contract route-handler registrations.
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
        /requestJsonRoute\(\s*API_ROUTES\.progress,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'progress\.get':\s*readProgress\b/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /fetch\(`\$\{baseUrl\}\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/progress`,\s*\{\s*method: 'GET'/u,
        /const payload = await readJsonRecord\(response, 'bot progress'\);\s*const data = getObjectProperty\(payload, 'data'\)/u,
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
        /requestJsonRoute\(\s*API_ROUTES\.verification,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId,\s*finalizationId/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.finalizations\.verification\.get':\s*readVerification\b/u)],
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
        /requestJsonRoute\(\s*API_ROUTES\.currentFinalization,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.finalizations\.current\.get':\s*readCurrentFinalization\b/u)],
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
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.finalizations\.artifacts\.bundle\.get':\s*readArtifact\b/u)],
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
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.finalizations\.artifacts\.report\.get':\s*readArtifact\b/u)],
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
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.bulletin\.get':\s*readBulletin\b/u)],
  }),
  'sessions.bulletin.consistencyProof.get': callers({
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.bulletin\.consistencyProof\.get':\s*readConsistencyProof\b/u)],
  }),
  'sessions.votes.inclusionProof.get': callers({
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.votes\.inclusionProof\.get':\s*readInclusionProof\b/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /buildApiRouteUrl\(API_ROUTES\.sessionVoteInclusionProof,\s*\{\s*params:\s*\{\s*sessionId,\s*voteId\s*\}/u,
        /fetch\(`\$\{baseUrl\}\$\{proofPath\}`,\s*\{\s*method: 'GET'/u,
      ),
    ],
  }),
  'sessions.finalizations.current.bitmapProof.get': callers({
    mockApi: [
      evidence(MOCK_HANDLERS_PATH, /'sessions\.finalizations\.current\.bitmapProof\.get':\s*readBitmapProof\b/u),
    ],
  }),
  'sessions.bulletin.sth.get': callers({
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.bulletin\.sth\.get':\s*readSignedTreeHead\b/u)],
  }),
  'sessions.finalizations.current.inputCommitment.get': callers({
    mockApi: [
      evidence(
        MOCK_HANDLERS_PATH,
        /'sessions\.finalizations\.current\.inputCommitment\.get':\s*readInputCommitment\b/u,
      ),
    ],
  }),
  'session.post': callers({
    browser: [
      evidence(WEB_SESSIONS_PATH, /requestJsonRoute\(\s*API_ROUTES\.createSession,\s*\{\s*body:\s*request\s*\}/u),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'session\.post':\s*createSession\b/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /fetch\(`\$\{baseUrl\}\/api\/sessions`,\s*\{\s*method: 'POST'/u,
        /const payload = await readJsonRecord\(response, 'create session'\);\s*const data = getObjectProperty\(payload, 'data'\)/u,
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
        /requestJsonRoute\(\s*API_ROUTES\.submitVote,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'vote\.post':\s*submitVote\b/u)],
    cli: [
      evidence(
        CLI_HELPERS_PATH,
        /fetch\(`\$\{baseUrl\}\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/votes`,\s*\{\s*method: 'POST'/u,
        /const payload = await readJsonRecord\(response, 'submit vote'\);\s*const data = getObjectProperty\(payload, 'data'\)/u,
      ),
    ],
  }),
  'sessions.finalizations.post': callers({
    browser: [
      evidence(
        WEB_FINALIZATIONS_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.createFinalization,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.finalizations\.post':\s*createFinalization\b/u)],
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
      evidence(WEB_FINALIZATIONS_PATH, /requestJsonRoute\(\s*API_ROUTES\.cancelFinalization,\s*\{\s*params:\s*\{/u),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.finalizations\.cancel\.post':\s*cancelFinalization\b/u)],
  }),
  'sessions.finalizations.verification.observations.post': callers({
    browser: [
      evidence(
        WEB_VERIFICATION_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.recordVerificationObservation,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId,\s*finalizationId/u,
      ),
    ],
    mockApi: [
      evidence(
        MOCK_HANDLERS_PATH,
        /'sessions\.finalizations\.verification\.observations\.post':\s*recordVerificationObservation\b/u,
      ),
    ],
  }),
  'sessions.finalizations.verification.post': callers({
    browser: [
      evidence(
        WEB_VERIFICATION_PATH,
        /requestJsonRoute\(\s*API_ROUTES\.runVerification,\s*\{\s*params:\s*\{\s*sessionId:\s*identity\.sessionId,\s*finalizationId/u,
      ),
    ],
    mockApi: [evidence(MOCK_HANDLERS_PATH, /'sessions\.finalizations\.verification\.post':\s*startVerification\b/u)],
    cli: [
      evidence(
        GATED_SMOKE_PATH,
        /const verificationPath = buildApiRouteUrl\(API_ROUTES\.runVerification/u,
        /fetch\(new URL\(verificationPath, options\.baseUrl\),\s*\{\s*method: 'POST'/u,
      ),
    ],
  }),
} satisfies Record<ApiContractRouteId, PublicContractCallerInventoryEntry>;

import { createHash } from 'node:crypto';
import type { ApiHandlerContext } from '@stark-ballot/api/server';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import type {
  MountedBehaviorCoverageEntry,
  MountedBehaviorProbe,
  MountedBehaviorProbeSnapshot,
} from './public-contract-policy';

const PROBE_ONE_BIT_BITMAP_ROOT = computeIncludedBitmapRoot([true]);
const PROBE_ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';

const MOUNTED_BEHAVIOR_COVERAGE: MountedBehaviorCoverageEntry[] = [
  {
    caseId: 'route-registration-modes-full-lambda-readonly',
    status: 'probed',
    probeIds: ['readonly.sessions-post.not-mounted', 'lambda.finalization-callback.not-mounted'],
  },
  {
    caseId: 'cors-preflight-exposed-range-headers',
    status: 'probed',
    probeIds: ['lambda.bundle.cors-preflight.range-header'],
  },
  {
    caseId: 'bundle-auth-capability-failure',
    status: 'probed',
    probeIds: ['lambda.bundle.missing-capability.error-envelope'],
  },
  {
    caseId: 'bundle-local-binary-headers-cache-privacy',
    status: 'probed',
    probeIds: ['lambda.bundle.local-binary.no-store'],
  },
  {
    caseId: 'bundle-range-unsatisfiable-416',
    status: 'probed',
    probeIds: ['lambda.bundle.range-unsatisfiable.416'],
  },
  {
    caseId: 'report-authenticated-delivery-cache-privacy',
    status: 'probed',
    probeIds: ['lambda.report.local-json.no-store'],
  },
  {
    caseId: 'bitmap-proof-admission-projection-cache-conditional',
    status: 'probed',
    probeIds: [
      'lambda.bitmap.missing-capability.error-envelope',
      'lambda.bitmap.etag.private-cache',
      'lambda.bitmap.conditional.no-body',
    ],
  },
  {
    caseId: 'finalization-callback-mounted-mode-and-error-envelope',
    status: 'probed',
    probeIds: ['lambda.finalization-callback.not-mounted', 'full.finalization-callback.invalid-request.error-envelope'],
  },
  {
    caseId: 'internal-finalization-callback-no-public-cors',
    status: 'probed',
    probeIds: ['full.finalization-callback.cors-preflight.not-public'],
  },
  {
    caseId: 'session-creation-success-flow',
    status: 'exempt',
    exemption:
      'Successful POST /api/sessions depends on Turnstile/rate-limit mutable state and session issuance side effects; the mounted success and target-admission cases are covered by `apps/api/src/server/api/routes/hono.test.ts`, and the direct browser and CLI callers are frozen by `scripts/api-contract/public-contract-baseline.test.ts`.',
  },
  {
    caseId: 'vote-success-flow',
    status: 'exempt',
    exemption:
      'Successful POST /api/sessions/:sessionId/votes depends on issued session state, Turnstile/rate-limit mutable state, and vote-store mutation; success and admission are covered by `apps/api/src/server/api/handlers/vote.test.ts`, `apps/web/src/components/vote/VoteForm.test.tsx`, and `scripts/api-contract/public-contract-baseline.test.ts`.',
  },
  {
    caseId: 'progress-read-flow',
    status: 'exempt',
    exemption:
      'GET /api/sessions/:sessionId/progress requires bot-progress mutation state that the mounted comparator does not create; projection, browser consumption, and CLI handling are covered by `apps/api/src/server/api/routes/hono.test.ts`, `apps/web/src/components/vote/BotVotingProgress.test.tsx`, and `packages/test-support/src/testing/__tests__/cli-test-helpers.progress.test.ts`.',
  },
  {
    caseId: 'finalization-create-success-flow',
    status: 'exempt',
    exemption:
      'Successful POST /api/sessions/:sessionId/finalizations requires finalization orchestration, zkVM mode selection, Turnstile/rate-limit state, and bundle persistence; focused coverage is in `apps/api/src/server/api/handlers/finalize.test.ts` and `packages/application/src/finalize/usecases/finalize-session.test.ts`. The broader characterization command `pnpm test:cli -- --user-choice A --all-scenarios` covers every scenario separately; the required `test:cli:mock` gate in `package.json` is intentionally the narrower S0-only run.',
  },
  {
    caseId: 'current-finalization-succeeded-flow',
    status: 'probed',
    probeIds: ['lambda.current-finalization.succeeded.no-store'],
  },
  {
    caseId: 'verification-resource-flow',
    status: 'exempt',
    exemption:
      'GET /api/sessions/:sessionId/finalizations/:finalizationId/verification success and fail-closed projections require full finalized artifacts that the mounted comparator avoids duplicating; both projections are exercised by `apps/api/src/server/api/routes/hono.public-contract.test.ts`, with CLI response admission covered by `packages/test-support/src/testing/__tests__/cli-test-helpers.finalize.test.ts` and browser polling by `apps/web/src/verification/stark-verification-polling.test.ts`.',
  },
  {
    caseId: 'verification-run-flow',
    status: 'exempt',
    exemption:
      'POST /api/sessions/:sessionId/finalizations/:finalizationId/verification invokes verifier-service orchestration and verifier-result persistence; idempotent, queued, completed, rollback, and fail-closed cases are covered by `apps/api/src/server/api/handlers/verificationRun.test.ts`, the gated CLI contract by `scripts/__tests__/develop-gated-smoke.test.ts`, and both direct browser POST callers by `scripts/api-contract/public-contract-baseline.test.ts`.',
  },
  {
    caseId: 'verification-observation-flow',
    status: 'exempt',
    exemption:
      'POST /api/sessions/:sessionId/finalizations/:finalizationId/verification/observations rebuilds server verification authority and performs a durable exact-finalization CAS; strict handler and integration behavior is covered by `apps/api/src/server/api/handlers/verificationObservation.test.ts` and `apps/api/src/server/api/routes/hono.public-contract.test.ts`, while browser and mock admission are covered by `apps/web/src/routes/verify/hooks/useVerificationObservation.test.tsx` and `apps/web/src/mock-api/__tests__/fetcher.test.ts`.',
  },
  {
    caseId: 'cross-session-cross-capability-denial',
    status: 'probed',
    probeIds: ['lambda.bundle.cross-session-capability-denied'],
  },
  {
    caseId: 'private-artifact-boundary',
    status: 'exempt',
    exemption:
      'Mounted probes record only response shape and hashes; public/private archive membership is covered by `packages/verification/src/verification/__tests__/verification-bundle.test.ts`, `scripts/tests/entrypoint-bundle.test.sh`, and `scripts/security/scan-public-safety.sh`.',
  },
  {
    caseId: 'report-size-failure-413',
    status: 'exempt',
    exemption:
      'Report-size rejection depends on S3 HEAD-size fixtures rather than the local mounted harness; the 413 response and pre-download rejection are covered by `apps/api/src/server/api/handlers/verificationBundles.test.ts`.',
  },
  {
    caseId: 'absent-report-fail-closed',
    status: 'exempt',
    exemption:
      'Absent-report behavior requires deterministic store and S3 fixtures and is covered by `apps/api/src/server/api/handlers/verificationBundles.test.ts`.',
  },
  {
    caseId: 'include-journal-query',
    status: 'exempt',
    exemption:
      'The include=journal representation selector is covered by mounted verification-resource success/fail-closed cases in `apps/api/src/server/api/routes/hono.public-contract.test.ts`, malformed-query admission in `apps/api/src/server/api/routes/hono.test.ts`, and CLI response handling in `packages/test-support/src/testing/__tests__/cli-test-helpers.finalize.test.ts`.',
  },
  {
    caseId: 'turnstile-rate-limit-source-ip-target-admission',
    status: 'exempt',
    exemption:
      'The mounted baseline avoids mutable Turnstile and rate-limit state; exact admission behavior is covered by `apps/api/src/server/api/security/turnstile.test.ts`, `apps/api/src/server/api/middleware/rateLimit.test.ts`, and target/source-IP cases in `apps/api/src/server/api/routes/hono.test.ts`.',
  },
];

export function validateMountedBehaviorCoverage(
  probes: readonly MountedBehaviorProbeSnapshot[],
): MountedBehaviorCoverageEntry[] {
  const probeIds = new Set(probes.map((probe) => probe.probeId));
  const caseIds = new Set<string>();
  for (const entry of MOUNTED_BEHAVIOR_COVERAGE) {
    if (caseIds.has(entry.caseId)) {
      throw new Error(`Duplicate mounted behavior coverage case: ${entry.caseId}`);
    }
    caseIds.add(entry.caseId);
    if (entry.status === 'probed') {
      if (!entry.probeIds || entry.probeIds.length === 0) {
        throw new Error(`Mounted behavior coverage case ${entry.caseId} has no probe IDs`);
      }
      for (const probeId of entry.probeIds) {
        if (!probeIds.has(probeId)) {
          throw new Error(`Mounted behavior coverage case ${entry.caseId} references missing probe ${probeId}`);
        }
      }
    } else if (!entry.exemption || entry.exemption.trim().length === 0) {
      throw new Error(`Mounted behavior coverage case ${entry.caseId} has no exemption`);
    }
  }
  return [...MOUNTED_BEHAVIOR_COVERAGE].sort((left, right) => left.caseId.localeCompare(right.caseId));
}

type ApiContextStore = ApiHandlerContext['store'];
type ProbeSessionIdentityRecord = NonNullable<Awaited<ReturnType<ApiContextStore['getSessionIdentity']>>>;
type ProbeSessionVotingRecord = NonNullable<Awaited<ReturnType<ApiContextStore['getVotingRecord']>>>;
type ProbeFinalizationRecord = NonNullable<Awaited<ReturnType<ApiContextStore['getFinalizationRecord']>>>;
type ProbeSucceededFinalizationRecord = Extract<ProbeFinalizationRecord, { state: { status: 'succeeded' } }>;
type ProbeFinalizationResult = NonNullable<ProbeSucceededFinalizationRecord['finalizationResult']>;
type ProbeVerificationResultRecord = NonNullable<Awaited<ReturnType<ApiContextStore['getVerificationResultRecord']>>>;
type ProbeFinalizationBitmapData = NonNullable<Awaited<ReturnType<NonNullable<ApiContextStore['getBitmapData']>>>>;
type ProbeVerificationDeliveryMetadata = NonNullable<
  Awaited<ReturnType<ApiContextStore['getAwsVerificationDeliveryMetadata']>>
>;

function buildProbeFinalizationResult(finalizationId: string): ProbeFinalizationResult {
  const journal = {
    ...createTestJournal({
      electionId: PROBE_ELECTION_ID,
      validVotes: 1,
      totalExpected: 1,
      seenIndicesCount: 1,
    }),
    bulletinRoot: `0x${'34'.repeat(32)}`,
    sthDigest: `0x${'56'.repeat(32)}`,
    verifiedTally: [1, 0, 0, 0, 0],
    includedBitmapRoot: PROBE_ONE_BIT_BITMAP_ROOT,
    seenBitmapRoot: PROBE_ONE_BIT_BITMAP_ROOT,
    inputCommitment: `0x${'78'.repeat(32)}`,
  };
  return {
    finalizationId,
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: `0x${'12'.repeat(32)}`,
    journal,
    publicInputArtifact: createTestPublicInputArtifact({
      source: 'generated',
      finalizationId,
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        methodVersion: journal.methodVersion,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        votesCount: journal.validVotes,
        recomputedInputCommitment: journal.inputCommitment,
      },
    }),
  };
}

interface ProbeRecords {
  identity: ProbeSessionIdentityRecord;
  voting: ProbeSessionVotingRecord;
  finalization: ProbeSucceededFinalizationRecord;
  verification: ProbeVerificationResultRecord;
  bitmap: ProbeFinalizationBitmapData;
  delivery: ProbeVerificationDeliveryMetadata;
}

function buildProbeRecords(sessionId: string, finalizationId: string): ProbeRecords {
  const timestamp = Date.UTC(2026, 5, 17, 0, 0, 0);
  const logId = `0x${'90'.repeat(32)}`;
  const identity: ProbeSessionIdentityRecord = {
    sessionId,
    electionId: PROBE_ELECTION_ID,
    electionConfigHash: `0x${'91'.repeat(32)}`,
    electionConfig: {
      totalExpected: 1,
      choices: ['A', 'B', 'C', 'D', 'E'],
      version: '1',
      botCount: 0,
      merkleTreeDepth: 1,
    },
    logId,
    createdAtMs: timestamp,
  };
  const voting: ProbeSessionVotingRecord = {
    sessionId,
    votes: new Map([
      [
        0,
        {
          voteId: '550e8400-e29b-41d4-a716-446655440001',
          vote: 'A' as const,
          rand: `0x${'ab'.repeat(32)}`,
          commit: `0x${'cd'.repeat(32)}`,
          timestamp,
          rootAtCast: `0x${'ef'.repeat(32)}`,
        },
      ],
    ]),
    bulletin: new SimpleBulletinBoard(logId),
    bulletinRootHistory: [],
    botCount: 0,
    userParticipation: { status: 'cast' as const, voteIndex: 0 },
    lastActivityMs: timestamp,
  };
  const finalizationResult = buildProbeFinalizationResult(finalizationId);
  const finalization: ProbeRecords['finalization'] = {
    sessionId,
    finalizationId,
    scenarioContext: {
      scenarios: [],
      tamperMode: 'none' as const,
      claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      claimedTotalVotes: 1,
      summary: {
        ignoredCount: 0,
        recountedCount: 0,
        userRecountChoice: null,
      },
    },
    state: {
      status: 'succeeded' as const,
      finalizationId,
      queuedAtMs: timestamp,
      startedAtMs: timestamp,
      completedAtMs: timestamp + 1_000,
    },
    finalizationResult,
  };

  return {
    identity,
    voting,
    finalization,
    verification: {
      sessionId,
      finalizationId,
      verificationResult: { status: 'success' as const },
    },
    bitmap: {
      sessionId,
      finalizationId,
      includedBitmap: [true],
      includedBitmapRoot: PROBE_ONE_BIT_BITMAP_ROOT,
      seenBitmap: [true],
      seenBitmapRoot: PROBE_ONE_BIT_BITMAP_ROOT,
      treeSize: 1,
      finalizedAtMs: timestamp + 1_000,
    },
    delivery: {
      s3BundleKey: `sessions/${sessionId}/${finalizationId}/bundle.zip`,
      s3ReportKey: `sessions/${sessionId}/${finalizationId}/verification.json`,
      s3UploadedAtMs: timestamp + 1_000,
    },
  };
}

type PublicContractProbeStoreMethod =
  | 'getSessionIdentity'
  | 'getVotingRecord'
  | 'getCurrentFinalizationRecord'
  | 'getFinalizationRecord'
  | 'getVerificationResultRecord'
  | 'getBitmapData'
  | 'getAwsFinalizationRuntimeMetadata'
  | 'getAwsVerificationDeliveryMetadata'
  | 'touchSession';

export type PublicContractProbeStore = Required<Pick<ApiContextStore, PublicContractProbeStoreMethod>>;

export function buildProbeStore(
  sessionId: string,
  finalizationId: string,
  options: { bitmapEvidence?: 'available' | 'unavailable' } = {},
): PublicContractProbeStore {
  const records = buildProbeRecords(sessionId, finalizationId);
  const isCurrentSession = (requestedSessionId: string): boolean => requestedSessionId === sessionId;
  const isCurrentFinalization = (requestedSessionId: string, requestedFinalizationId: string): boolean =>
    isCurrentSession(requestedSessionId) && requestedFinalizationId === finalizationId;

  return {
    getSessionIdentity: (requestedSessionId: string) =>
      Promise.resolve(isCurrentSession(requestedSessionId) ? records.identity : null),
    getVotingRecord: (requestedSessionId: string) =>
      Promise.resolve(isCurrentSession(requestedSessionId) ? records.voting : null),
    getCurrentFinalizationRecord: (requestedSessionId: string) =>
      Promise.resolve(isCurrentSession(requestedSessionId) ? records.finalization : null),
    getFinalizationRecord: (requestedSessionId: string, requestedFinalizationId: string) =>
      Promise.resolve(isCurrentFinalization(requestedSessionId, requestedFinalizationId) ? records.finalization : null),
    getVerificationResultRecord: (requestedSessionId: string, requestedFinalizationId: string) =>
      Promise.resolve(isCurrentFinalization(requestedSessionId, requestedFinalizationId) ? records.verification : null),
    getBitmapData: (requestedSessionId: string, requestedFinalizationId: string) =>
      Promise.resolve(
        isCurrentFinalization(requestedSessionId, requestedFinalizationId) && options.bitmapEvidence !== 'unavailable'
          ? records.bitmap
          : null,
      ),
    getAwsFinalizationRuntimeMetadata: () => Promise.resolve(undefined),
    getAwsVerificationDeliveryMetadata: (requestedSessionId: string, requestedFinalizationId: string) =>
      Promise.resolve(
        isCurrentFinalization(requestedSessionId, requestedFinalizationId) ? records.delivery : undefined,
      ),
    touchSession: () => Promise.resolve(),
  };
}

export function buildMountedBehaviorProbes(options: {
  sessionId: string;
  finalizationId: string;
  pathCapabilityHeaders: Readonly<Record<string, string>>;
}): MountedBehaviorProbe[] {
  const { sessionId, finalizationId, pathCapabilityHeaders } = options;
  const bitmapProofUrl = `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/0`;
  const artifactBaseUrl = `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/artifacts`;
  return [
    {
      probeId: 'lambda.bundle.cors-preflight.range-header',
      mode: 'lambda',
      method: 'OPTIONS',
      url: `${artifactBaseUrl}/bundle`,
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': `${SESSION_CAPABILITY_HEADER}, Range`,
      },
    },
    {
      probeId: 'lambda.bundle.missing-capability.error-envelope',
      mode: 'lambda',
      method: 'GET',
      url: `${artifactBaseUrl}/bundle`,
      expectCanonicalJson: true,
    },
    {
      probeId: 'lambda.bundle.local-binary.no-store',
      mode: 'lambda',
      method: 'GET',
      url: `${artifactBaseUrl}/bundle`,
      headers: pathCapabilityHeaders,
    },
    {
      probeId: 'lambda.bundle.range-unsatisfiable.416',
      mode: 'lambda',
      method: 'GET',
      url: `${artifactBaseUrl}/bundle`,
      headers: {
        ...pathCapabilityHeaders,
        Range: 'bytes=999999-1000000',
      },
      expectCanonicalJson: true,
    },
    {
      probeId: 'lambda.bundle.cross-session-capability-denied',
      mode: 'lambda',
      method: 'GET',
      url: `http://localhost/api/sessions/other-session/finalizations/${finalizationId}/artifacts/bundle`,
      headers: pathCapabilityHeaders,
      expectCanonicalJson: true,
    },
    {
      probeId: 'lambda.report.local-json.no-store',
      mode: 'lambda',
      method: 'GET',
      url: `${artifactBaseUrl}/report`,
      headers: pathCapabilityHeaders,
    },
    {
      probeId: 'lambda.current-finalization.succeeded.no-store',
      mode: 'lambda',
      method: 'GET',
      url: `http://localhost/api/sessions/${sessionId}/finalizations/current`,
      headers: pathCapabilityHeaders,
      expectCanonicalJson: true,
    },
    {
      probeId: 'lambda.bitmap.missing-capability.error-envelope',
      mode: 'lambda',
      method: 'GET',
      url: bitmapProofUrl,
      expectCanonicalJson: true,
    },
    {
      probeId: 'lambda.bitmap.etag.private-cache',
      mode: 'lambda',
      method: 'GET',
      url: bitmapProofUrl,
      headers: pathCapabilityHeaders,
      expectCanonicalJson: true,
    },
    {
      probeId: 'lambda.bitmap.conditional.no-body',
      mode: 'lambda',
      method: 'GET',
      url: bitmapProofUrl,
      headers: pathCapabilityHeaders,
    },
    {
      probeId: 'readonly.sessions-post.not-mounted',
      mode: 'readonly',
      method: 'POST',
      url: 'http://localhost/api/sessions',
    },
    {
      probeId: 'lambda.finalization-callback.not-mounted',
      mode: 'lambda',
      method: 'POST',
      url: `http://localhost/api/internal/sessions/${sessionId}/finalizations/${finalizationId}/callback`,
    },
    {
      probeId: 'full.finalization-callback.invalid-request.error-envelope',
      mode: 'full',
      method: 'POST',
      url: `http://localhost/api/internal/sessions/${sessionId}/finalizations/${finalizationId}/callback`,
      headers: {
        'Content-Type': 'application/json',
      },
    },
    {
      probeId: 'full.finalization-callback.cors-preflight.not-public',
      mode: 'full',
      method: 'OPTIONS',
      url: `http://localhost/api/internal/sessions/${sessionId}/finalizations/${finalizationId}/callback`,
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    },
  ];
}

function selectProbeHeaders(headers: Headers): Record<string, string | null> {
  return {
    'accept-ranges': headers.get('accept-ranges'),
    'access-control-allow-headers': headers.get('access-control-allow-headers'),
    'access-control-allow-methods': headers.get('access-control-allow-methods'),
    'access-control-allow-origin': headers.get('access-control-allow-origin'),
    'cache-control': headers.get('cache-control'),
    'content-disposition': headers.get('content-disposition'),
    'content-range': headers.get('content-range'),
    'content-type': headers.get('content-type'),
    etag: headers.get('etag'),
    vary: headers.get('vary'),
    'x-stark-bundle-range-chunk-size': headers.get('x-stark-bundle-range-chunk-size'),
    'x-request-id': headers.get('x-request-id'),
  };
}

export function deterministicProbeRequestId(probeId: string): string {
  // Injected through the simulated trusted gateway context, never through an
  // untrusted client request header.
  return `public-contract-baseline:${probeId}`;
}

export function buildMountedBehaviorProbeSnapshot(options: {
  probe: MountedBehaviorProbe;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  expectedRequestId: string;
}): MountedBehaviorProbeSnapshot {
  const { probe, status, headers, bytes, expectedRequestId } = options;
  const contentType = headers.get('content-type') ?? '';
  let jsonError: string | undefined;
  let jsonKeys: string[] | undefined;
  let jsonRequestId: string | undefined;
  if (bytes.byteLength > 0 && contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        jsonKeys = Object.keys(record).sort();
        if (typeof record['error'] === 'string') {
          jsonError = record['error'];
        } else if (record['error'] && typeof record['error'] === 'object' && !Array.isArray(record['error'])) {
          const code = (record['error'] as Record<string, unknown>)['code'];
          if (typeof code === 'string') {
            jsonError = code;
          }
        }
        if (record['meta'] && typeof record['meta'] === 'object' && !Array.isArray(record['meta'])) {
          const requestId = (record['meta'] as Record<string, unknown>)['requestId'];
          if (typeof requestId === 'string') {
            jsonRequestId = requestId;
          }
        }
      }
    } catch {
      jsonKeys = ['<invalid-json>'];
    }
  }

  const responseRequestId = headers.get('x-request-id');
  if (responseRequestId !== expectedRequestId) {
    throw new Error(
      `Mounted behavior probe ${probe.probeId} request ID header mismatch: expected ${expectedRequestId}, received ${responseRequestId ?? '<none>'}`,
    );
  }
  if (probe.expectCanonicalJson && jsonRequestId !== expectedRequestId) {
    throw new Error(
      `Mounted behavior probe ${probe.probeId} JSON request ID mismatch: expected ${expectedRequestId}, received ${jsonRequestId ?? '<none>'}`,
    );
  }

  return {
    probeId: probe.probeId,
    mode: probe.mode,
    method: probe.method,
    path: new URL(probe.url).pathname,
    status,
    headers: selectProbeHeaders(headers),
    body: {
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(jsonError ? { jsonError } : {}),
      ...(jsonKeys ? { jsonKeys } : {}),
      ...(jsonRequestId ? { jsonRequestId } : {}),
    },
  };
}

export function sortMountedBehaviorSnapshots(
  snapshots: MountedBehaviorProbeSnapshot[],
): MountedBehaviorProbeSnapshot[] {
  return snapshots.sort((left, right) => left.probeId.localeCompare(right.probeId));
}

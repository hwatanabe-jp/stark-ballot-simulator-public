import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { capturePublicContractSnapshot, resolveCurrentSourceMetadata } from './public-contract-baseline';
import { resolveCaptureOutputPath } from './lib/public-contract-cli';
import {
  comparePublicContractSnapshots,
  computePublicContractHash,
  parseDriftClassification,
  parsePublicContractSnapshot,
  type PublicContractSnapshot,
} from './lib/public-contract-policy';
import { PUBLIC_CONTRACT_CALLER_INVENTORY } from './public-contract-callers';
import type { SchemaSemanticEvidence } from './schema-semantic-fingerprint';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function cloneSnapshot(snapshot: PublicContractSnapshot): PublicContractSnapshot {
  return structuredClone(snapshot);
}

function refreshContractHash(snapshot: PublicContractSnapshot): void {
  snapshot.contractHash = computePublicContractHash(snapshot);
}

function classifyDrift(baseline: PublicContractSnapshot, current: PublicContractSnapshot, allowedDriftPaths: string[]) {
  return {
    comparatorType: 'public-contract-drift-classification' as const,
    baselineContractHash: baseline.contractHash,
    baselineSourceSha: baseline.sourceSha,
    currentContractHash: current.contractHash,
    reason: 'Focused test classification',
    allowedDriftPaths,
  };
}

function changeFirstRoutePath(snapshot: PublicContractSnapshot, routePath: string): string {
  const firstRoute = strictDefined(snapshot.routeContracts[0]);
  snapshot.routeContracts[0] = { ...firstRoute, path: routePath };
  return firstRoute.routeId;
}

function expectedProbeRequestId(probeId: string): string {
  return `public-contract-baseline:${probeId}`;
}

const BASELINE_CAPTURED_AT = '2026-06-17T00:00:00.000Z';
// A capture includes multiple isolated Node evaluations plus a source/schema scan.
// Keep a larger outer budget than the bounded subprocesses, including cleanup.
const CAPTURE_TIMEOUT_MS = 60_000;
let baselineSnapshot: PublicContractSnapshot;
beforeAll(async () => {
  baselineSnapshot = await capturePublicContractSnapshot();
}, CAPTURE_TIMEOUT_MS);
const reviewedBaselineInput: unknown = JSON.parse(
  readFileSync(path.join(process.cwd(), 'scripts/api-contract/baselines/reviewed-public-contract.json'), 'utf8'),
);
const reviewedBaselineSnapshot = parsePublicContractSnapshot(
  reviewedBaselineInput,
  'Reviewed public-contract snapshot',
);

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function writeSourceFile(repoRoot: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}

async function createSourceRefMountedBehaviorFixture(): Promise<{
  repoRoot: string;
  sourceRef: string;
  cleanup: () => Promise<void>;
}> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'stark-ballot-source-ref-fixture-'));
  const repoRoot = path.join(tempRoot, 'repo');
  await mkdir(repoRoot, { recursive: true });
  runGit(repoRoot, ['init', '--initial-branch=main']);

  await writeSourceFile(repoRoot, 'package.json', `{"private":true,"type":"module"}\n`);
  await writeSourceFile(
    repoRoot,
    'tsconfig.json',
    `{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","target":"ES2024"}}\n`,
  );
  await writeSourceFile(
    repoRoot,
    'apps/api/src/server/api/routes/hono.ts',
    `export function createHonoApp(): {
  request: (
    input: string,
    init?: RequestInit,
    env?: { requestContext?: { extendedRequestId?: string } },
  ) => Promise<Response>;
} {
  return {
    request: async (_input, _init, env) => {
      const requestId = env?.requestContext?.extendedRequestId ?? 'missing-source-ref-request-id';
      return new Response(
        JSON.stringify({
          data: { sourceMarker: 'source-ref-mounted-workspace' },
          meta: { requestId },
        }),
        {
        status: 218,
          headers: {
            'content-type': 'application/json',
            'x-request-id': requestId,
          },
        },
      );
    },
  };
}
`,
  );
  await writeSourceFile(repoRoot, 'apps/api/src/server/api/routes/honoBindings.ts', `export {};\n`);
  await writeSourceFile(repoRoot, 'apps/api/src/server/api/routes/definitions.ts', `export const SOURCE_REF = true;\n`);
  await writeSourceFile(
    repoRoot,
    'packages/api-contract/src/routes/index.ts',
    `export const API_ROUTES = {} as const;
export const TARGET_API_ROUTE_CONTRACTS = [] as const;
`,
  );
  await writeSourceFile(repoRoot, 'packages/api-contract/src/schemas/index.ts', `export {};\n`);
  await writeSourceFile(
    repoRoot,
    'scripts/api-contract/typed-route-baseline-projection.ts',
    `export function projectTypedRoutesForBaseline(routes: readonly unknown[]): readonly unknown[] {
  return routes;
}
`,
  );
  await writeSourceFile(
    repoRoot,
    'packages/validation/package.json',
    `{"name":"@stark-ballot/validation","private":true,"type":"module","exports":{".":"./src/index.ts"}}\n`,
  );

  runGit(repoRoot, ['add', '.']);
  runGit(repoRoot, ['commit', '-m', 'source ref mounted behavior fixture'], {
    ...process.env,
    GIT_AUTHOR_NAME: 'Public Contract Test',
    GIT_AUTHOR_EMAIL: 'public-contract-test@example.invalid',
    GIT_COMMITTER_NAME: 'Public Contract Test',
    GIT_COMMITTER_EMAIL: 'public-contract-test@example.invalid',
  });
  const committedFiles = runGit(repoRoot, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
  expect(committedFiles).toContain('apps/api/src/server/api/routes/hono.ts');
  expect(committedFiles).toContain('packages/api-contract/src/routes/index.ts');

  return {
    repoRoot,
    sourceRef: 'HEAD',
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
}

describe('public contract baseline comparator', () => {
  it('uses CodeBuild resolved source metadata when current source is an archive without git metadata', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'stark-ballot-no-git-source-'));
    const previousSourceVersion = process.env['CODEBUILD_RESOLVED_SOURCE_VERSION'];

    try {
      process.env['CODEBUILD_RESOLVED_SOURCE_VERSION'] = '0123456789abcdef0123456789abcdef01234567';
      expect(resolveCurrentSourceMetadata(tempRoot)).toEqual({
        sourceSha: '0123456789ab',
        dirtyStatus: 'source-archive',
      });
    } finally {
      if (previousSourceVersion === undefined) {
        delete process.env['CODEBUILD_RESOLVED_SOURCE_VERSION'];
      } else {
        process.env['CODEBUILD_RESOLVED_SOURCE_VERSION'] = previousSourceVersion;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('captures route-bound request contracts', () => {
    const snapshot = cloneSnapshot(baselineSnapshot);

    expect(snapshot.comparatorType).toBe('public-contract-baseline');
    expect(snapshot.routeContracts.map((route) => route.routeId)).toContain(
      'sessions.finalizations.artifacts.bundle.get',
    );
    expect(snapshot.routeContracts.find((route) => route.routeId === 'session.post')).toMatchObject({
      method: 'POST',
      path: '/sessions',
      publicErrorShape: 'standard-error-envelope',
    });
    const schemaEvidence = (schemaName: string) => ({
      algorithm: 'json-wire-admission',
      fingerprint: strictDefined(snapshot.schemaSemantics.fingerprints[schemaName], schemaName),
    });
    const directSchemaEvidence = (
      routeId: string,
      location: 'params' | 'query' | 'headers' | 'body',
    ): SchemaSemanticEvidence => {
      const route = strictDefined(
        snapshot.routeContracts.find((candidate) => candidate.routeId === routeId),
        routeId,
      );
      const evidence = strictDefined(route.request[location], `${routeId}.${location}`);
      expect(evidence.algorithm).toBe('json-wire-admission');
      expect(evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      return evidence;
    };
    expect(snapshot.routeContracts.find((route) => route.routeId === 'vote.post')).toMatchObject({
      method: 'POST',
      path: '/sessions/:sessionId/votes',
      authScope: 'path-session-capability',
      request: {
        params: schemaEvidence('SessionParamsSchema'),
        headers: schemaEvidence('PathSessionCapabilityHeadersSchema'),
        body: schemaEvidence('VoteRequestSchema'),
      },
      publicErrorShape: 'standard-error-envelope',
    });
    expect(snapshot.routeContracts.find((route) => route.routeId === 'progress.get')).toMatchObject({
      method: 'GET',
      path: '/sessions/:sessionId/progress',
      authScope: 'path-session-capability',
      request: {
        params: schemaEvidence('SessionParamsSchema'),
        headers: schemaEvidence('PathSessionCapabilityHeadersSchema'),
      },
      publicErrorShape: 'standard-error-envelope',
    });
    for (const [routeId, routePath, requestSchemaNames] of [
      [
        'sessions.bulletin.get',
        '/sessions/:sessionId/bulletin',
        {
          params: 'SessionBulletinParamsSchema',
          query: 'BulletinQuerySchema',
          headers: 'PathSessionCapabilityHeadersSchema',
        },
      ],
      [
        'sessions.bulletin.consistencyProof.get',
        '/sessions/:sessionId/bulletin/consistency-proof',
        {
          params: 'SessionBulletinParamsSchema',
          query: 'ConsistencyProofQuerySchema',
          headers: 'PathSessionCapabilityHeadersSchema',
        },
      ],
      [
        'sessions.votes.inclusionProof.get',
        '/sessions/:sessionId/votes/:voteId/inclusion-proof',
        {
          params: 'SessionVoteInclusionProofParamsSchema',
          headers: 'PathSessionCapabilityHeadersSchema',
        },
      ],
      [
        'sessions.bulletin.sth.get',
        '/sessions/:sessionId/bulletin/sth',
        {
          params: 'SessionBulletinParamsSchema',
          query: 'SthQuerySchema',
          headers: null,
        },
      ],
      [
        'sessions.finalizations.current.bitmapProof.get',
        '/sessions/:sessionId/finalizations/current/bitmap-proofs/:kind/:voteIndex',
        {
          params: 'CurrentFinalizationBitmapProofParamsSchema',
          headers: null,
        },
      ],
      [
        'sessions.finalizations.current.inputCommitment.get',
        '/sessions/:sessionId/finalizations/current/input-commitment',
        {
          params: 'CurrentFinalizationInputCommitmentParamsSchema',
          headers: 'PathSessionCapabilityHeadersSchema',
        },
      ],
    ] as const) {
      const request = Object.fromEntries(
        Object.entries(requestSchemaNames).map(([location, schemaName]) => [
          location,
          schemaName === null
            ? directSchemaEvidence(routeId, location as 'params' | 'query' | 'headers' | 'body')
            : schemaEvidence(schemaName),
        ]),
      );
      expect(
        snapshot.routeContracts.find((route) => route.routeId === routeId),
        routeId,
      ).toMatchObject({
        method: 'GET',
        path: routePath,
        authScope: 'path-session-capability',
        capabilityScope: 'path',
        request,
      });
    }
    for (const route of snapshot.routeContracts.filter((candidate) => candidate.lifecycle === 'active')) {
      expect(route.publicErrorShape, route.routeId).toBe('standard-error-envelope');
      expect(route.publicErrors.envelope, route.routeId).toBe('standard-error-envelope');
    }
    for (const routeId of ['session.post', 'vote.post', 'sessions.finalizations.post']) {
      expect(
        snapshot.routeContracts.find((route) => route.routeId === routeId)?.turnstile?.tokenLocations,
        routeId,
      ).toEqual(['body.turnstileToken']);
    }
  });

  it('captures schema exports, authority, and semantic fingerprints', () => {
    const snapshot = cloneSnapshot(baselineSnapshot);
    expect(snapshot.schemaExports).toContain('StandardErrorResponseSchema');
    expect(snapshot.schemaExports).toContain('PathSessionCapabilityHeadersSchema');
    expect(strictDefined(snapshot.schemaFingerprints['StandardErrorResponseSchema'])).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.schemaSemantics.algorithm).toBe('json-wire-admission');
    expect(strictDefined(snapshot.schemaSemantics.fingerprints['StandardErrorResponseSchema'])).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(Object.keys(snapshot.schemaFingerprints).sort()).toEqual(snapshot.schemaExports);
    expect(Object.keys(snapshot.schemaSemantics.fingerprints).sort()).toEqual(snapshot.schemaExports);
    for (const authorityPath of [
      'packages/api-contract/src/schemas/index.ts',
      'packages/api-contract/src/schemas/errors.ts',
      'packages/api-contract/src/schemas/verification.ts',
      'packages/validation/src/safe-verifier-segment.ts',
      'packages/validation/src/schema.ts',
    ]) {
      expect(strictDefined(snapshot.schemaAuthorityFingerprints[authorityPath], authorityPath)).toMatch(
        /^[a-f0-9]{64}$/,
      );
    }
  });

  it('captures mounted route modes and HTTP evidence', () => {
    const snapshot = cloneSnapshot(baselineSnapshot);
    for (const mode of snapshot.mountedRoutes) {
      expect(
        mode.routes.some((route) => route.authScope === 'callback-authenticity'),
        mode.mode,
      ).toBe(false);
    }
    expect(snapshot.mountedRoutes.find((mode) => mode.mode === 'readonly')?.routeIds).toContain(
      'sessions.finalizations.verification.get',
    );
    expect(
      snapshot.mountedBehavior.find((probe) => probe.probeId === 'lambda.bundle.local-binary.no-store'),
    ).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'cache-control': 'no-store',
      },
    });
    expect(
      snapshot.mountedBehavior.find((probe) => probe.probeId === 'lambda.bitmap.conditional.no-body'),
    ).toMatchObject({
      path: `/api/sessions/session-baseline-mounted/finalizations/current/bitmap-proofs/included/0`,
      status: 304,
      body: {
        bytes: 0,
      },
    });
    const unsatisfiedRangeProbe = strictDefined(
      snapshot.mountedBehavior.find((probe) => probe.probeId === 'lambda.bundle.range-unsatisfiable.416'),
    );
    expect(unsatisfiedRangeProbe.status).toBe(416);
    expect(unsatisfiedRangeProbe.headers['content-range']).toMatch(/^bytes \*\/[1-9]\d*$/u);
    expect(
      snapshot.mountedBehavior.find((probe) => probe.probeId === 'lambda.report.local-json.no-store'),
    ).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
    expect(
      snapshot.mountedBehavior.find(
        (probe) => probe.probeId === 'full.finalization-callback.invalid-request.error-envelope',
      ),
    ).toMatchObject({
      path: '/api/internal/sessions/session-baseline-mounted/finalizations/finalization-baseline-mounted/callback',
      status: 401,
      headers: {
        'access-control-allow-origin': null,
        vary: null,
      },
    });
    expect(
      snapshot.mountedBehavior.find(
        (probe) => probe.probeId === 'full.finalization-callback.cors-preflight.not-public',
      ),
    ).toMatchObject({
      path: '/api/internal/sessions/session-baseline-mounted/finalizations/finalization-baseline-mounted/callback',
      status: 404,
      headers: {
        'access-control-allow-headers': null,
        'access-control-allow-methods': null,
        'access-control-allow-origin': null,
        vary: null,
      },
    });
    expect(
      snapshot.mountedBehavior.find((probe) => probe.probeId === 'lambda.finalization-callback.not-mounted'),
    ).toMatchObject({
      path: '/api/internal/sessions/session-baseline-mounted/finalizations/finalization-baseline-mounted/callback',
      status: 404,
    });
    expect(
      snapshot.mountedBehavior.find((probe) => probe.probeId === 'lambda.current-finalization.succeeded.no-store'),
    ).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
    for (const probe of snapshot.mountedBehavior) {
      expect(probe.headers['x-request-id'], probe.probeId).toBe(expectedProbeRequestId(probe.probeId));
    }
    for (const probeId of [
      'lambda.bitmap.etag.private-cache',
      'lambda.bitmap.missing-capability.error-envelope',
      'lambda.bundle.cross-session-capability-denied',
      'lambda.bundle.missing-capability.error-envelope',
      'lambda.bundle.range-unsatisfiable.416',
      'lambda.current-finalization.succeeded.no-store',
    ]) {
      const probe = strictDefined(
        snapshot.mountedBehavior.find((candidate) => candidate.probeId === probeId),
        probeId,
      );
      expect(probe.body.jsonKeys, probeId).toEqual(expect.arrayContaining(['meta']));
      expect(probe.body.jsonRequestId, probeId).toBe(expectedProbeRequestId(probeId));
      expect(probe.body.jsonRequestId, probeId).toBe(probe.headers['x-request-id']);
    }
    expect(snapshot.mountedBehaviorCoverage.map((entry) => entry.caseId)).toContain('bundle-range-unsatisfiable-416');
    expect(snapshot.mountedBehaviorCoverage.map((entry) => entry.caseId)).toEqual(
      expect.arrayContaining([
        'session-creation-success-flow',
        'vote-success-flow',
        'progress-read-flow',
        'finalization-create-success-flow',
        'current-finalization-succeeded-flow',
        'verification-resource-flow',
        'verification-run-flow',
        'verification-observation-flow',
      ]),
    );
    expect(snapshot.mountedBehaviorCoverage.find((entry) => entry.caseId === 'report-size-failure-413')).toMatchObject({
      status: 'exempt',
    });
  });

  it('uses one semantic fingerprint authority for exported and route-bound schemas', () => {
    const voteRoute = strictDefined(
      baselineSnapshot.routeContracts.find((route) => route.routeId === 'vote.post'),
      'vote route',
    );
    const requestBodyEvidence = strictDefined(voteRoute.request.body, 'vote request body evidence');

    expect(requestBodyEvidence.algorithm).toBe(baselineSnapshot.schemaSemantics.algorithm);
    expect(requestBodyEvidence.fingerprint).toBe(
      strictDefined(baselineSnapshot.schemaSemantics.fingerprints['VoteRequestSchema']),
    );
  });

  it('records exact first-party caller ownership or explicit absence for every route', () => {
    const routeIds = baselineSnapshot.routeContracts.map((route) => route.routeId).sort();
    expect(Object.keys(PUBLIC_CONTRACT_CALLER_INVENTORY).sort()).toEqual(routeIds);

    for (const [routeId, callers] of Object.entries(PUBLIC_CONTRACT_CALLER_INVENTORY)) {
      const callerSurfaces = [
        ['browser', callers.browser],
        ['mockApi', callers.mockApi],
        ['cli', callers.cli],
        ['lambda', callers.lambda],
        ['stepFunctions', callers.stepFunctions],
        ['internalCallbackProducer', callers.internalCallbackProducer],
      ] as const;
      for (const [surface, callerEvidence] of callerSurfaces) {
        const callerPaths = callerEvidence.map((caller) => caller.path);
        expect(new Set(callerPaths).size, `${routeId}.${surface} has duplicate callers`).toBe(callerPaths.length);
        for (const caller of callerEvidence) {
          const absolutePath = path.join(process.cwd(), caller.path);
          expect(existsSync(absolutePath), `${routeId}.${surface}: ${caller.path}`).toBe(true);
          expect(
            caller.sourcePatterns.length,
            `${routeId}.${surface}: ${caller.path} has no reviewed evidence`,
          ).toBeGreaterThan(0);
          const source = readFileSync(absolutePath, 'utf8');
          for (const sourcePattern of caller.sourcePatterns) {
            expect(
              sourcePattern.global || sourcePattern.sticky,
              `${routeId}.${surface}: ${caller.path} uses a stateful evidence pattern`,
            ).toBe(false);
            expect(source, `${routeId}.${surface}: ${caller.path} no longer matches ${sourcePattern}`).toMatch(
              sourcePattern,
            );
          }
        }
      }
      expect(callers.stepFunctions, `${routeId} unexpectedly has an HTTP Step Functions caller`).toEqual([]);
      expect(callers.internalCallbackProducer, `${routeId} unexpectedly has a callback producer`).toEqual([]);
    }

    expect(
      PUBLIC_CONTRACT_CALLER_INVENTORY['sessions.finalizations.verification.post'].browser.map((caller) => caller.path),
    ).toEqual(['apps/web/src/api/verification.ts']);
  });

  it('binds every mounted-behavior exemption to existing focused evidence', () => {
    for (const entry of baselineSnapshot.mountedBehaviorCoverage) {
      if (entry.status !== 'exempt') {
        continue;
      }
      const exemption = strictDefined(entry.exemption, `${entry.caseId} exemption`);
      const evidencePaths = [...exemption.matchAll(/`([^`]+\.(?:json|sh|ts|tsx))`/gu)].map((match) =>
        strictDefined(match[1], `${entry.caseId} evidence path`),
      );
      expect(evidencePaths.length, `${entry.caseId} has no exact evidence path`).toBeGreaterThan(0);
      for (const evidencePath of evidencePaths) {
        expect(existsSync(path.join(process.cwd(), evidencePath)), `${entry.caseId}: ${evidencePath}`).toBe(true);
      }
    }
  });

  it('uses deterministic capture timestamps by default', () => {
    expect(baselineSnapshot.capturedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('requires source-ref captures to name a non-authority output path', () => {
    expect(() => resolveCaptureOutputPath({ sourceRef: 'HEAD' })).toThrow(/explicit --out/u);
    expect(resolveCaptureOutputPath({ sourceRef: 'HEAD', out: '/tmp/review.json' })).toBe('/tmp/review.json');
  });

  it(
    'captures identical bundle bytes, ETags, and contract hashes under restrictive and ordinary umasks',
    async () => {
      const previousUmask = process.umask(0o077);
      try {
        for (const umask of [0o077, 0o022]) {
          process.umask(umask);
          const snapshot = await capturePublicContractSnapshot();

          expect(snapshot.mountedBehavior).toEqual(baselineSnapshot.mountedBehavior);
          expect(snapshot.contractHash).toBe(baselineSnapshot.contractHash);
        }
      } finally {
        process.umask(previousUmask);
      }
    },
    CAPTURE_TIMEOUT_MS,
  );

  it(
    'isolates mounted behavior from conflicting callback environment values',
    async () => {
      const previousSecret = process.env['FINALIZE_CALLBACK_SECRET'];
      const previousBodyLimit = process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES'];
      const previousSkew = process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'];
      try {
        process.env['FINALIZE_CALLBACK_SECRET'] = 'ambient-secret-that-must-not-affect-the-baseline';
        process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES'] = '1';
        process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'] = '1';
        const snapshot = await capturePublicContractSnapshot({ capturedAt: BASELINE_CAPTURED_AT });

        expect(snapshot.capturedAt).toBe(BASELINE_CAPTURED_AT);
        expect(snapshot.mountedBehavior).toEqual(baselineSnapshot.mountedBehavior);
        expect(snapshot.contractHash).toBe(baselineSnapshot.contractHash);
      } finally {
        if (previousSecret === undefined) delete process.env['FINALIZE_CALLBACK_SECRET'];
        else process.env['FINALIZE_CALLBACK_SECRET'] = previousSecret;
        if (previousBodyLimit === undefined) delete process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES'];
        else process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES'] = previousBodyLimit;
        if (previousSkew === undefined) delete process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'];
        else process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'] = previousSkew;
      }
    },
    CAPTURE_TIMEOUT_MS,
  );

  it('fails unclassified drift', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    changeFirstRoutePath(current, '/changed');
    refreshContractHash(current);

    expect(comparePublicContractSnapshots(baseline, current).map((drift) => drift.path)).toContain(
      `${strictDefined(baseline.routeContracts[0]).routeId}.path`.replace(/^/, 'routeContracts.'),
    );
  });

  it('fails unclassified schema wire-semantic drift even when the export name is unchanged', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const schemaSemantics = strictDefined(current.schemaSemantics);
    current.schemaSemantics = {
      ...schemaSemantics,
      fingerprints: {
        ...schemaSemantics.fingerprints,
        StandardErrorResponseSchema: '0'.repeat(64),
      },
    };
    refreshContractHash(current);

    expect(comparePublicContractSnapshots(baseline, current).map((drift) => drift.path)).toContain(
      'schemaSemantics.fingerprints.StandardErrorResponseSchema',
    );
  });

  it('fails unclassified schema declaration drift even when wire semantics are unchanged', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    current.schemaFingerprints = {
      ...current.schemaFingerprints,
      StandardErrorResponseSchema: '0'.repeat(64),
    };
    refreshContractHash(current);

    expect(comparePublicContractSnapshots(baseline, current).map((drift) => drift.path)).toContain(
      'schemaFingerprints.StandardErrorResponseSchema',
    );
  });

  it('fails unclassified schema authority drift even when wire semantics are unchanged', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const firstAuthorityPath = strictDefined(Object.keys(current.schemaAuthorityFingerprints).sort()[0]);
    current.schemaAuthorityFingerprints = {
      ...current.schemaAuthorityFingerprints,
      [firstAuthorityPath]: '1'.repeat(64),
    };
    refreshContractHash(current);

    expect(comparePublicContractSnapshots(baseline, current).map((drift) => drift.path)).toContain(
      `schemaAuthorityFingerprints.${firstAuthorityPath}`,
    );
  });

  it('requires complete semantic evidence in the reviewed and current snapshots', () => {
    const classificationInput: unknown = JSON.parse(
      readFileSync(path.join(process.cwd(), 'scripts/api-contract/baselines/reviewed-contract-metadata.json'), 'utf8'),
    );
    const classification = parseDriftClassification(classificationInput);
    expect(comparePublicContractSnapshots(reviewedBaselineSnapshot, baselineSnapshot, classification)).toEqual([]);

    const baselineWithoutSemantics = cloneSnapshot(baselineSnapshot);
    delete (baselineWithoutSemantics as Partial<PublicContractSnapshot>).schemaSemantics;
    refreshContractHash(baselineWithoutSemantics);
    expect(() => comparePublicContractSnapshots(baselineWithoutSemantics, baselineSnapshot)).toThrow(
      /Baseline public-contract snapshot has no schema semantic evidence/u,
    );

    const currentWithoutSemantics = cloneSnapshot(baselineSnapshot);
    delete (currentWithoutSemantics as Partial<PublicContractSnapshot>).schemaSemantics;
    refreshContractHash(currentWithoutSemantics);
    expect(() => comparePublicContractSnapshots(baselineSnapshot, currentWithoutSemantics)).toThrow(
      /Current public-contract snapshot has no schema semantic evidence/u,
    );
  });

  it('fails unclassified mounted behavior drift', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const firstProbe = strictDefined(current.mountedBehavior[0]);
    current.mountedBehavior[0] = { ...firstProbe, status: 599 };
    refreshContractHash(current);

    expect(comparePublicContractSnapshots(baseline, current).map((drift) => drift.path)).toContain(
      `mountedBehavior.${firstProbe.probeId}.status`,
    );
  });

  it(
    'captures source-ref mounted behavior and workspace packages from the materialized source tree',
    async () => {
      const fixture = await createSourceRefMountedBehaviorFixture();
      try {
        const snapshot = await capturePublicContractSnapshot({
          sourceRef: fixture.sourceRef,
          sourceRepoRoot: fixture.repoRoot,
          capturedAt: '2026-06-17T00:00:00.000Z',
        });
        expect(snapshot.dirtyStatus).toBe('source-ref');
        expect(snapshot.mountedBehavior).not.toEqual([]);
        expect(snapshot.mountedBehavior.every((probe) => probe.status === 218)).toBe(true);
        for (const probe of snapshot.mountedBehavior) {
          const requestId = expectedProbeRequestId(probe.probeId);
          const sourceRefBodyHash = createHash('sha256')
            .update(
              JSON.stringify({
                data: { sourceMarker: 'source-ref-mounted-workspace' },
                meta: { requestId },
              }),
            )
            .digest('hex');
          expect(probe.headers['x-request-id']).toBe(requestId);
          expect(probe.body.jsonRequestId).toBe(requestId);
          expect(probe.body.sha256).toBe(sourceRefBodyHash);
        }
      } finally {
        await fixture.cleanup();
      }
    },
    CAPTURE_TIMEOUT_MS,
  );

  it('allows explicitly classified drift paths', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const routeId = changeFirstRoutePath(current, '/changed');
    refreshContractHash(current);

    expect(
      comparePublicContractSnapshots(
        baseline,
        current,
        classifyDrift(baseline, current, [`routeContracts.${routeId}.path`]),
      ),
    ).toEqual([]);
  });

  it('does not allow old numeric route paths to hide reorder drift', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const firstRoute = strictDefined(current.routeContracts[0]);
    current.routeContracts = [...current.routeContracts.slice(1), firstRoute];
    const changedRoute = strictDefined(current.routeContracts[0]);
    current.routeContracts[0] = { ...changedRoute, path: '/changed-after-reorder' };
    refreshContractHash(current);

    expect(() =>
      comparePublicContractSnapshots(baseline, current, classifyDrift(baseline, current, ['routeContracts.0.path'])),
    ).toThrow(/unused paths/u);
  });

  it('does not allow old numeric schema paths to hide unrelated schema insertion', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    current.schemaExports = [
      ...current.schemaExports.slice(0, 10),
      'UnrelatedInsertedSchema',
      ...current.schemaExports.slice(10),
    ];
    current.schemaFingerprints = {
      ...current.schemaFingerprints,
      UnrelatedInsertedSchema: '2'.repeat(64),
    };
    const schemaSemantics = strictDefined(current.schemaSemantics);
    current.schemaSemantics = {
      ...schemaSemantics,
      fingerprints: {
        ...schemaSemantics.fingerprints,
        UnrelatedInsertedSchema: '3'.repeat(64),
      },
    };
    refreshContractHash(current);

    expect(() =>
      comparePublicContractSnapshots(baseline, current, classifyDrift(baseline, current, ['schemaExports.10'])),
    ).toThrow(/unused paths/u);
  });

  it('does not allow old numeric mounted behavior paths to hide probe reorder drift', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const firstProbe = strictDefined(current.mountedBehavior[0]);
    current.mountedBehavior = [...current.mountedBehavior.slice(1), firstProbe];
    const changedProbe = strictDefined(current.mountedBehavior[0]);
    current.mountedBehavior[0] = { ...changedProbe, status: 599 };
    refreshContractHash(current);

    expect(() =>
      comparePublicContractSnapshots(baseline, current, classifyDrift(baseline, current, ['mountedBehavior.0.status'])),
    ).toThrow(/unused paths/u);
  });

  it('rejects invalid snapshot integrity and stale drift classifications', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    changeFirstRoutePath(current, '/changed');
    refreshContractHash(current);

    const corruptBaseline = cloneSnapshot(baseline);
    corruptBaseline.contractHash = '0'.repeat(64);
    expect(() => comparePublicContractSnapshots(corruptBaseline, current)).toThrow(/contractHash/u);
    const wrongComparator = cloneSnapshot(baseline);
    (wrongComparator as { comparatorType: string }).comparatorType = 'other-comparator';
    expect(() => comparePublicContractSnapshots(wrongComparator, current)).toThrow(/comparatorType/u);
    expect(() =>
      comparePublicContractSnapshots(baseline, current, {
        ...classifyDrift(baseline, current, ['routeContracts.unused.path']),
        baselineContractHash: '0'.repeat(64),
      }),
    ).toThrow(/not bound/u);
    expect(() =>
      comparePublicContractSnapshots(baseline, current, {
        ...classifyDrift(baseline, current, ['routeContracts.unused.path']),
        currentContractHash: '0'.repeat(64),
      }),
    ).toThrow(/exact current contract payload/u);
    expect(() =>
      comparePublicContractSnapshots(baseline, current, {
        ...classifyDrift(baseline, current, ['routeContracts.unused.path']),
        comparatorType: 'other-classification' as 'public-contract-drift-classification',
      }),
    ).toThrow(/classification type/u);
    expect(() =>
      comparePublicContractSnapshots(
        baseline,
        current,
        classifyDrift(baseline, current, ['routeContracts.unused.path']),
      ),
    ).toThrow(/unused paths/u);
    expect(() => parsePublicContractSnapshot({ ...baseline, compatibilityMarker: 'retired' }, 'snapshot')).toThrow(
      /exactly/u,
    );
    expect(() =>
      parseDriftClassification({ ...classifyDrift(baseline, current, []), compatibilityMarker: 'retired' }),
    ).toThrow(/exactly/u);
  });
});

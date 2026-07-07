import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApiRouteContract } from '@stark-ballot/api-contract/api-contract/routes';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';

const COMPARATOR_VERSION = 'public-contract-baseline-v1';
const DEFAULT_BASELINE_PATH = '.tmp/type-system-redesign/pre-redesign-public-contract-baseline.json';
const DEFAULT_CURRENT_PATH = '.tmp/type-system-redesign/current-public-contract-baseline.json';
const DETERMINISTIC_CAPTURED_AT = '1970-01-01T00:00:00.000Z';
const PROBE_ONE_BIT_BITMAP_ROOT = computeIncludedBitmapRoot([true]);

type RouteMode = 'full' | 'lambda' | 'readonly';

interface ParsedRouteRegistration {
  method: string;
  path: string;
  kind: string;
  excludeFromLambda: boolean;
}

interface MountedRouteSnapshot {
  mode: RouteMode;
  routeIds: string[];
  routes: Array<{
    routeId: string;
    method: string;
    path: string;
    lifecycle: string;
    kind: string;
    authScope: string;
    capabilityScope: string;
    dataClassification: string;
  }>;
}

type MountedBehaviorMode = 'full' | 'lambda' | 'readonly';

interface MountedBehaviorProbe {
  probeId: string;
  mode: MountedBehaviorMode;
  method: string;
  url: string;
  headers?: Record<string, string>;
}

interface MountedBehaviorProbeSnapshot {
  probeId: string;
  mode: MountedBehaviorMode;
  method: string;
  path: string;
  status: number;
  headers: Record<string, string | null>;
  body: {
    bytes: number;
    sha256: string;
    jsonError?: string;
    jsonKeys?: string[];
  };
}

interface MountedBehaviorCoverageEntry {
  caseId: string;
  status: 'probed' | 'exempt';
  probeIds?: string[];
  exemption?: string;
}

export interface PublicContractSnapshot {
  comparatorVersion: typeof COMPARATOR_VERSION;
  sourceRef: string;
  sourceSha: string;
  dirtyStatus: 'clean' | 'dirty' | 'source-ref' | 'source-archive';
  capturedAt: string;
  contractHash: string;
  routeContracts: ApiRouteContract[];
  mountedRoutes: MountedRouteSnapshot[];
  mountedBehavior: MountedBehaviorProbeSnapshot[];
  mountedBehaviorCoverage: MountedBehaviorCoverageEntry[];
  schemaExports: string[];
  schemaFingerprints: Record<string, string>;
}

export interface PublicContractDrift {
  path: string;
  before: unknown;
  after: unknown;
}

interface DriftClassification {
  comparatorVersion?: string;
  allowedDriftPaths?: string[];
}

type ComparableMountedRouteSnapshot = Omit<MountedRouteSnapshot, 'routeIds' | 'routes'> & {
  routeIds: Record<string, true>;
  routes: Record<string, MountedRouteSnapshot['routes'][number]>;
};

interface ComparablePublicContractSnapshot {
  routeContracts: Record<string, ApiRouteContract>;
  mountedRoutes: Record<RouteMode, ComparableMountedRouteSnapshot | undefined>;
  mountedBehavior: Record<string, MountedBehaviorProbeSnapshot>;
  mountedBehaviorCoverage: Record<string, MountedBehaviorCoverageEntry>;
  schemaExports: Record<string, true>;
  schemaFingerprints: Record<string, string>;
}

interface MaterializedSourceRef {
  repoRoot: string;
  tempRoot: string;
}

interface CliOptions {
  command: 'capture' | 'compare';
  out?: string;
  baseline?: string;
  current?: string;
  sourceRef?: string;
  requireCleanCurrent?: boolean;
  classification?: string;
}

function runGit(args: string[], cwd = process.cwd()): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function readCodeBuildResolvedSourceVersion(): string | undefined {
  const value = process.env['CODEBUILD_RESOLVED_SOURCE_VERSION'];
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) ? value : undefined;
}

export function resolveCurrentSourceMetadata(repoRoot: string): {
  sourceSha: string;
  dirtyStatus: PublicContractSnapshot['dirtyStatus'];
} {
  const headResult = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (headResult.status === 0) {
    return {
      sourceSha: headResult.stdout.trim(),
      dirtyStatus: runGit(['status', '--short'], repoRoot).length === 0 ? 'clean' : 'dirty',
    };
  }

  const codeBuildSourceVersion = readCodeBuildResolvedSourceVersion();
  if (codeBuildSourceVersion) {
    return {
      sourceSha: codeBuildSourceVersion.slice(0, 12),
      dirtyStatus: 'source-archive',
    };
  }

  throw new Error(`git rev-parse --short=12 HEAD failed: ${headResult.stderr.trim()}`);
}

async function linkCurrentDependencies(repoRoot: string): Promise<void> {
  const tempNodeModules = path.join(repoRoot, 'node_modules');
  const currentNodeModules = path.join(process.cwd(), 'node_modules');
  await mkdir(tempNodeModules, { recursive: true });

  if (existsSync(currentNodeModules)) {
    for (const entry of await readdir(currentNodeModules)) {
      if (entry === '@stark-ballot') {
        continue;
      }
      await symlink(path.join(currentNodeModules, entry), path.join(tempNodeModules, entry));
    }
  }

  const starkBallotScope = path.join(tempNodeModules, '@stark-ballot');
  await mkdir(starkBallotScope, { recursive: true });
  for (const workspaceRoot of ['apps', 'packages'] as const) {
    const rootPath = path.join(repoRoot, workspaceRoot);
    if (!existsSync(rootPath)) {
      continue;
    }
    for (const entry of await readdir(rootPath)) {
      const packageDir = path.join(rootPath, entry);
      const manifestPath = path.join(packageDir, 'package.json');
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown };
      if (typeof manifest.name === 'string' && manifest.name.startsWith('@stark-ballot/')) {
        await symlink(packageDir, path.join(starkBallotScope, manifest.name.slice('@stark-ballot/'.length)));
      }
    }
  }
  for (const workspaceRoot of ['apps', 'packages'] as const) {
    const rootPath = path.join(process.cwd(), workspaceRoot);
    if (!existsSync(rootPath)) {
      continue;
    }
    for (const entry of await readdir(rootPath)) {
      const packageDir = path.join(rootPath, entry);
      const manifestPath = path.join(packageDir, 'package.json');
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown };
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@stark-ballot/')) {
        continue;
      }
      const linkPath = path.join(starkBallotScope, manifest.name.slice('@stark-ballot/'.length));
      if (!existsSync(linkPath)) {
        await symlink(packageDir, linkPath);
      }
    }
  }
}

async function materializeSourceRefFromRoot(sourceRepoRoot: string, sourceRef: string): Promise<MaterializedSourceRef> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'stark-ballot-api-contract-'));
  const repoRoot = path.join(tempRoot, 'source');
  const archivePath = path.join(tempRoot, 'source.tar');
  await mkdir(repoRoot, { recursive: true });
  const archive = spawnSync('git', ['archive', '--format=tar', `--output=${archivePath}`, sourceRef], {
    cwd: sourceRepoRoot,
    encoding: 'utf8',
  });
  if (archive.status !== 0) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(`git archive ${sourceRef} failed: ${archive.stderr.trim()}`);
  }
  const extract = spawnSync('tar', ['-xf', archivePath, '-C', repoRoot], { encoding: 'utf8' });
  if (extract.status !== 0) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(`tar extraction for ${sourceRef} failed: ${extract.stderr.trim()}`);
  }
  const contractRoutesPath = path.join(repoRoot, 'packages/api-contract/src/api-contract/routes.ts');
  if (!existsSync(contractRoutesPath)) {
    const rootEntries = existsSync(repoRoot) ? await readdir(repoRoot) : [];
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(
      `materialized source ref ${sourceRef} is missing packages/api-contract/src/api-contract/routes.ts; root entries: ${rootEntries.join(', ')}`,
    );
  }
  await linkCurrentDependencies(repoRoot);
  return { repoRoot, tempRoot };
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = stableNormalize(record[key]);
    }
    return normalized;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(stableNormalize(value), null, 2)}\n`;
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function keyByUnique<T>(items: readonly T[], keyOf: (item: T) => string, label: string): Record<string, T> {
  const keyed: Record<string, T> = {};
  for (const item of items) {
    const key = keyOf(item);
    if (Object.prototype.hasOwnProperty.call(keyed, key)) {
      throw new Error(`Duplicate ${label} identity in public contract snapshot: ${key}`);
    }
    keyed[key] = item;
  }
  return Object.fromEntries(Object.entries(keyed).sort(([left], [right]) => left.localeCompare(right)));
}

function keySet(items: readonly string[]): Record<string, true> {
  return Object.fromEntries([...new Set(items)].sort().map((item) => [item, true] as const));
}

function toComparableSnapshot(snapshot: PublicContractSnapshot): ComparablePublicContractSnapshot {
  return {
    routeContracts: keyByUnique(snapshot.routeContracts, (route) => route.routeId, 'route contract'),
    mountedRoutes: keyByUnique(
      snapshot.mountedRoutes.map((mountedRoute) => ({
        mode: mountedRoute.mode,
        routeIds: keySet(mountedRoute.routeIds),
        routes: keyByUnique(mountedRoute.routes, (route) => route.routeId, `${mountedRoute.mode} mounted route`),
      })),
      (mountedRoute) => mountedRoute.mode,
      'mounted route mode',
    ),
    mountedBehavior: keyByUnique(snapshot.mountedBehavior, (probe) => probe.probeId, 'mounted behavior probe'),
    mountedBehaviorCoverage: keyByUnique(
      snapshot.mountedBehaviorCoverage,
      (entry) => entry.caseId,
      'mounted behavior coverage case',
    ),
    schemaExports: keySet(snapshot.schemaExports),
    schemaFingerprints: snapshot.schemaFingerprints,
  };
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const MOUNTED_BEHAVIOR_COVERAGE: MountedBehaviorCoverageEntry[] = [
  {
    caseId: 'route-registration-modes-full-lambda-readonly',
    status: 'probed',
    probeIds: ['readonly.session-post.not-mounted', 'lambda.finalize-callback.not-mounted'],
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
      'lambda.bitmap.missing-session.error-envelope',
      'lambda.bitmap.etag.private-cache',
      'lambda.bitmap.conditional.no-body',
    ],
  },
  {
    caseId: 'finalize-callback-mounted-mode-and-error-envelope',
    status: 'probed',
    probeIds: ['lambda.finalize-callback.not-mounted', 'full.finalize-callback.invalid-request.error-envelope'],
  },
  {
    caseId: 'session-creation-success-flow',
    status: 'exempt',
    exemption:
      'Successful POST /api/session depends on Turnstile/rate-limit mutable state and session issuance side effects; covered by session route tests, route-contract metadata, browser API admission, and CLI/browser flow evidence.',
  },
  {
    caseId: 'vote-success-flow',
    status: 'exempt',
    exemption:
      'Successful POST /api/vote depends on issued session state, Turnstile/rate-limit mutable state, and vote-store mutation; covered by vote route/component tests, browser API admission, and CLI/browser flow evidence.',
  },
  {
    caseId: 'progress-read-flow',
    status: 'exempt',
    exemption:
      'GET /api/progress projection is covered by route-contract metadata, browser API admission, progress UI tests, and CLI/browser flow evidence; the mounted comparator fixture does not run bot-progress mutation state.',
  },
  {
    caseId: 'finalize-success-flow',
    status: 'exempt',
    exemption:
      'Successful POST /api/finalize requires finalization orchestration, zkVM mode selection, Turnstile/rate-limit state, and bundle persistence; covered by finalize handler/usecase tests, CLI S0-S5 flow evidence, and route-contract metadata.',
  },
  {
    caseId: 'session-status-finalized-flow',
    status: 'probed',
    probeIds: ['lambda.session-status.finalized.no-store'],
  },
  {
    caseId: 'verify-finalized-flow',
    status: 'exempt',
    exemption:
      'GET /api/verify successful and fail-closed projections are covered by verify handler tests, CLI/browser verification evidence, and route-contract metadata; the mounted comparator fixture avoids duplicating full verification artifact fixtures.',
  },
  {
    caseId: 'verification-run-flow',
    status: 'exempt',
    exemption:
      'POST /api/verification/run invokes verifier-service orchestration and verifier-result persistence; covered by verification-run handler tests, route-contract metadata, browser polling admission, and CLI verification evidence.',
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
      'Public/private bundle member checks are covered by verification-bundle and public-safety tests; mounted probes record only response shape and hashes.',
  },
  {
    caseId: 'report-size-failure-413',
    status: 'exempt',
    exemption:
      'Report-size rejection depends on S3/head size fixtures and is covered by verification bundle handler tests rather than the local mounted harness.',
  },
  {
    caseId: 'absent-report-fail-closed',
    status: 'exempt',
    exemption:
      'Absent report behavior is covered by verification bundle handler tests with deterministic store/S3 fixtures.',
  },
  {
    caseId: 'include-journal-query',
    status: 'exempt',
    exemption: 'includeJournal is API schema/handler behavior covered by focused verify/verification-run tests.',
  },
  {
    caseId: 'turnstile-rate-limit-source-ip-target-admission',
    status: 'exempt',
    exemption:
      'Admission controls are deterministic in route metadata and focused middleware/security tests; the mounted baseline avoids rate-limit mutable state.',
  },
];

function validateMountedBehaviorCoverage(
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

function runSourceRootJson<T>(repoRoot: string, script: string): T {
  const marker = '__PUBLIC_CONTRACT_BASELINE_JSON__';
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: path.join(repoRoot, 'tsconfig.json'),
    },
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.status !== 0) {
    throw new Error(`source-root module evaluation failed: ${result.stderr.trim()}`);
  }
  const payloadLine = result.stdout.split('\n').find((line) => line.startsWith(marker));
  if (!payloadLine) {
    throw new Error(`source-root module evaluation did not emit ${marker}`);
  }
  return JSON.parse(payloadLine.slice(marker.length)) as T;
}

async function importRouteContracts(repoRoot: string, isolatedSourceRoot = false): Promise<ApiRouteContract[]> {
  const modulePath = path.join(repoRoot, 'packages/api-contract/src/api-contract/routes.ts');
  const routeContracts = isolatedSourceRoot
    ? runSourceRootJson<readonly ApiRouteContract[]>(
        repoRoot,
        `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const modulePath = path.join(process.cwd(), 'packages/api-contract/src/api-contract/routes.ts');
const routeModule = await import(pathToFileURL(modulePath).href);
console.log('__PUBLIC_CONTRACT_BASELINE_JSON__' + JSON.stringify(routeModule.TARGET_API_ROUTE_CONTRACTS));
`,
      )
    : (
        (await import(pathToFileURL(modulePath).href)) as {
          TARGET_API_ROUTE_CONTRACTS: readonly ApiRouteContract[];
        }
      ).TARGET_API_ROUTE_CONTRACTS;

  return routeContracts
    .map((route) => stableNormalize(route) as ApiRouteContract)
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
}

function parseRouteRegistrations(definitionsSource: string): ParsedRouteRegistration[] {
  const registrations: ParsedRouteRegistration[] = [];
  const routePattern = /defineRoute\(\s*\{([\s\S]*?)\}\s*\)/g;
  for (const match of definitionsSource.matchAll(routePattern)) {
    const body = match[1];
    if (!body) {
      continue;
    }
    const method = /method:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const routePath = /path:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    const kind = /kind:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
    if (!method || !routePath || !kind) {
      continue;
    }
    registrations.push({
      method,
      path: routePath,
      kind,
      excludeFromLambda: /excludeFromLambda:\s*true/.test(body),
    });
  }
  return registrations.sort((left, right) =>
    `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
  );
}

function buildMountedRoutes(
  contracts: readonly ApiRouteContract[],
  registrations: readonly ParsedRouteRegistration[],
): MountedRouteSnapshot[] {
  const byMethodAndPath = new Map(contracts.map((route) => [`${route.method} ${route.path}`, route]));

  return (['full', 'lambda', 'readonly'] as const).map((mode) => {
    const routes = registrations
      .map((registration) => {
        const contract = byMethodAndPath.get(`${registration.method} ${registration.path}`);
        if (!contract) {
          throw new Error(`Route registration has no contract: ${registration.method} ${registration.path}`);
        }
        return { registration, contract };
      })
      .filter(({ registration, contract }) => {
        if (mode === 'full') {
          return contract.lifecycle !== 'retired';
        }
        if (mode === 'lambda') {
          return contract.lifecycle === 'active' && !registration.excludeFromLambda;
        }
        return contract.kind === 'readonly' && contract.lifecycle === 'active';
      })
      .map(({ contract }) => ({
        routeId: contract.routeId,
        method: contract.method,
        path: contract.path,
        lifecycle: contract.lifecycle,
        kind: contract.kind,
        authScope: contract.authScope,
        capabilityScope: contract.capabilityScope,
        dataClassification: contract.dataClassification,
      }))
      .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));

    return {
      mode,
      routeIds: routes.map((route) => route.routeId),
      routes,
    };
  });
}

function buildProbeFinalizationResult(sessionId: string, executionId: string): Record<string, unknown> {
  const journal = createTestJournal({
    validVotes: 1,
    totalExpected: 1,
    seenIndicesCount: 1,
  });
  const currentJournal = {
    ...journal,
    includedBitmapRoot: PROBE_ONE_BIT_BITMAP_ROOT,
    seenBitmapRoot: PROBE_ONE_BIT_BITMAP_ROOT,
  };
  const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
  const reportKey = `sessions/${sessionId}/${executionId}/verification.json`;

  return {
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: `0x${'12'.repeat(32)}`,
    journal: currentJournal,
    publicInputArtifact: createTestPublicInputArtifact({
      source: 'bundle',
      executionId,
      bundleKey,
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
    verificationExecutionId: executionId,
    s3BundleKey: bundleKey,
    verificationResult: {
      status: 'success',
      executionId,
      s3BundleKey: bundleKey,
      s3ReportKey: reportKey,
    },
  };
}

function buildProbeSession(sessionId: string, executionId: string): Record<string, unknown> {
  const timestamp = Date.UTC(2026, 5, 17, 0, 0, 0);
  return {
    sessionId,
    contractGeneration: resolveCurrentContractGeneration(),
    finalizationContractGeneration: resolveCurrentContractGeneration(),
    hasPersistedFinalizationBranch: true,
    votes: new Map([
      [
        0,
        {
          vote: 'A',
          rand: `0x${'ab'.repeat(32)}`,
          commit: `0x${'cd'.repeat(32)}`,
          path: [],
          timestamp,
          rootAtCast: `0x${'ef'.repeat(32)}`,
          treeSize: 1,
        },
      ],
    ]),
    botCount: 0,
    finalized: true,
    userVoteIndex: 0,
    createdAt: timestamp,
    lastActivity: timestamp,
    finalizationResult: buildProbeFinalizationResult(sessionId, executionId),
  };
}

function buildProbeStore(sessionId: string, executionId: string): Record<string, unknown> {
  const session = buildProbeSession(sessionId, executionId);
  return {
    getSession: (requestedSessionId: string) => Promise.resolve(requestedSessionId === sessionId ? session : null),
    updateSession: () => Promise.resolve(undefined),
    getBitmapData: () =>
      Promise.resolve({
        sessionId,
        includedBitmap: [true],
        includedBitmapRoot: PROBE_ONE_BIT_BITMAP_ROOT,
        seenBitmap: [true],
        seenBitmapRoot: PROBE_ONE_BIT_BITMAP_ROOT,
        treeSize: 1,
        finalizedAt: Date.UTC(2026, 5, 17, 0, 0, 1),
      }),
  };
}

async function prepareProbeArtifacts(root: string, sessionId: string, executionId: string): Promise<void> {
  const artifactDir = path.join(root, sessionId, executionId);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, 'bundle.zip'), Uint8Array.from([80, 75, 3, 4, 0, 0]));
  await writeFile(path.join(artifactDir, 'verification.json'), `${JSON.stringify({ ok: true })}\n`);
}

function selectProbeHeaders(response: Response): Record<string, string | null> {
  return {
    'accept-ranges': response.headers.get('accept-ranges'),
    'access-control-allow-headers': response.headers.get('access-control-allow-headers'),
    'access-control-allow-methods': response.headers.get('access-control-allow-methods'),
    'access-control-allow-origin': response.headers.get('access-control-allow-origin'),
    'cache-control': response.headers.get('cache-control'),
    'content-disposition': response.headers.get('content-disposition'),
    'content-range': response.headers.get('content-range'),
    'content-type': response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    vary: response.headers.get('vary'),
    'x-stark-bundle-range-chunk-size': response.headers.get('x-stark-bundle-range-chunk-size'),
  };
}

async function snapshotProbeResponse(
  probe: MountedBehaviorProbe,
  response: Response,
): Promise<MountedBehaviorProbeSnapshot> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  let jsonError: string | undefined;
  let jsonKeys: string[] | undefined;
  if (bytes.byteLength > 0 && contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        jsonKeys = Object.keys(record).sort();
        if (typeof record['error'] === 'string') {
          jsonError = record['error'];
        }
      }
    } catch {
      jsonKeys = ['<invalid-json>'];
    }
  }

  return {
    probeId: probe.probeId,
    mode: probe.mode,
    method: probe.method,
    path: new URL(probe.url).pathname,
    status: response.status,
    headers: selectProbeHeaders(response),
    body: {
      bytes: bytes.byteLength,
      sha256: hashBytes(bytes),
      ...(jsonError ? { jsonError } : {}),
      ...(jsonKeys ? { jsonKeys } : {}),
    },
  };
}

export async function captureMountedBehaviorForSourceRoot(repoRoot: string): Promise<MountedBehaviorProbeSnapshot[]> {
  const sessionId = 'session-baseline-mounted';
  const executionId = 'execution-baseline-mounted';
  const capabilitySecret = 'public-contract-mounted-baseline-secret-0123456789abcdef';
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'stark-ballot-mounted-baseline-'));
  const previousEnv: Record<string, string | undefined> = {
    SESSION_CAPABILITY_SECRET: process.env['SESSION_CAPABILITY_SECRET'],
    TARGET_AWS_RUNTIME: process.env['TARGET_AWS_RUNTIME'],
    USE_S3: process.env['USE_S3'],
    USE_MOCK_STORE: process.env['USE_MOCK_STORE'],
    VERIFIER_WORK_DIR: process.env['VERIFIER_WORK_DIR'],
    HONO_CORS_ALLOW_ORIGINS: process.env['HONO_CORS_ALLOW_ORIGINS'],
  };
  const globalStore = globalThis as typeof globalThis & { __globalStoreInstance?: unknown };
  const previousStore = globalStore.__globalStoreInstance;

  try {
    await prepareProbeArtifacts(artifactRoot, sessionId, executionId);
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    process.env['TARGET_AWS_RUNTIME'] = '0';
    process.env['USE_S3'] = 'false';
    process.env['USE_MOCK_STORE'] = 'true';
    process.env['VERIFIER_WORK_DIR'] = artifactRoot;
    process.env['HONO_CORS_ALLOW_ORIGINS'] = 'http://localhost:3000';
    globalStore.__globalStoreInstance = buildProbeStore(
      sessionId,
      executionId,
    ) as unknown as typeof globalStore.__globalStoreInstance;

    const honoModulePath = path.join(repoRoot, 'apps/api/src/server/api/routes/hono.ts');
    const honoModule = (await import(pathToFileURL(honoModulePath).href)) as {
      createHonoApp: (options: { basePath: string; mode: MountedBehaviorMode }) => {
        request: (input: string, init?: RequestInit) => Promise<Response>;
      };
    };
    const capability = createSessionCapabilityToken({ sessionId }, capabilitySecret);
    const sessionHeaders = {
      [SESSION_ID_HEADER]: sessionId,
      [SESSION_CAPABILITY_HEADER]: capability,
    };
    const pathCapabilityHeaders = {
      [SESSION_CAPABILITY_HEADER]: capability,
    };
    const probes: MountedBehaviorProbe[] = [
      {
        probeId: 'lambda.bundle.cors-preflight.range-header',
        mode: 'lambda',
        method: 'OPTIONS',
        url: `http://localhost/api/verification/bundles/${sessionId}/${executionId}`,
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
        url: `http://localhost/api/verification/bundles/${sessionId}/${executionId}`,
      },
      {
        probeId: 'lambda.bundle.local-binary.no-store',
        mode: 'lambda',
        method: 'GET',
        url: `http://localhost/api/verification/bundles/${sessionId}/${executionId}`,
        headers: pathCapabilityHeaders,
      },
      {
        probeId: 'lambda.bundle.range-unsatisfiable.416',
        mode: 'lambda',
        method: 'GET',
        url: `http://localhost/api/verification/bundles/${sessionId}/${executionId}`,
        headers: {
          ...pathCapabilityHeaders,
          Range: 'bytes=999999-1000000',
        },
      },
      {
        probeId: 'lambda.bundle.cross-session-capability-denied',
        mode: 'lambda',
        method: 'GET',
        url: `http://localhost/api/verification/bundles/other-session/${executionId}`,
        headers: pathCapabilityHeaders,
      },
      {
        probeId: 'lambda.report.local-json.no-store',
        mode: 'lambda',
        method: 'GET',
        url: `http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`,
        headers: pathCapabilityHeaders,
      },
      {
        probeId: 'lambda.session-status.finalized.no-store',
        mode: 'lambda',
        method: 'GET',
        url: `http://localhost/api/sessions/${sessionId}/status`,
        headers: pathCapabilityHeaders,
      },
      {
        probeId: 'lambda.bitmap.missing-session.error-envelope',
        mode: 'lambda',
        method: 'GET',
        url: 'http://localhost/api/bitmap-proof?i=0&kind=included',
      },
      {
        probeId: 'lambda.bitmap.etag.private-cache',
        mode: 'lambda',
        method: 'GET',
        url: 'http://localhost/api/bitmap-proof?i=0&kind=included',
        headers: sessionHeaders,
      },
      {
        probeId: 'lambda.bitmap.conditional.no-body',
        mode: 'lambda',
        method: 'GET',
        url: 'http://localhost/api/bitmap-proof?i=0&kind=included',
        headers: sessionHeaders,
      },
      {
        probeId: 'readonly.session-post.not-mounted',
        mode: 'readonly',
        method: 'POST',
        url: 'http://localhost/api/session',
      },
      {
        probeId: 'lambda.finalize-callback.not-mounted',
        mode: 'lambda',
        method: 'POST',
        url: 'http://localhost/api/finalize/callback',
      },
      {
        probeId: 'full.finalize-callback.invalid-request.error-envelope',
        mode: 'full',
        method: 'POST',
        url: 'http://localhost/api/finalize/callback',
        headers: {
          'Content-Type': 'application/json',
        },
      },
    ];

    const appsByMode = new Map<MountedBehaviorMode, ReturnType<typeof honoModule.createHonoApp>>();
    const resolveApp = (mode: MountedBehaviorMode): ReturnType<typeof honoModule.createHonoApp> => {
      const existing = appsByMode.get(mode);
      if (existing) {
        return existing;
      }
      const app = honoModule.createHonoApp({ basePath: '/api', mode });
      appsByMode.set(mode, app);
      return app;
    };

    const snapshots: MountedBehaviorProbeSnapshot[] = [];
    for (const probe of probes) {
      const app = resolveApp(probe.mode);
      const headers = { ...(probe.headers ?? {}) };
      if (probe.probeId === 'lambda.bitmap.conditional.no-body') {
        const fresh = await app.request(probe.url, {
          method: probe.method,
          headers,
        });
        const etag = fresh.headers.get('etag');
        if (etag) {
          headers['If-None-Match'] = etag;
        }
      }
      snapshots.push(
        await snapshotProbeResponse(
          probe,
          await app.request(probe.url, {
            method: probe.method,
            headers,
          }),
        ),
      );
    }
    return snapshots.sort((left, right) => left.probeId.localeCompare(right.probeId));
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    globalStore.__globalStoreInstance = previousStore;
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

async function captureMountedBehavior(
  repoRoot: string,
  isolatedSourceRoot = false,
): Promise<MountedBehaviorProbeSnapshot[]> {
  if (!isolatedSourceRoot) {
    return await captureMountedBehaviorForSourceRoot(repoRoot);
  }
  const moduleUrl = pathToFileURL(new URL(import.meta.url).pathname).href;
  return runSourceRootJson<MountedBehaviorProbeSnapshot[]>(
    repoRoot,
    `
import { captureMountedBehaviorForSourceRoot } from ${JSON.stringify(moduleUrl)};
const result = await captureMountedBehaviorForSourceRoot(process.cwd());
console.log('__PUBLIC_CONTRACT_BASELINE_JSON__' + JSON.stringify(result));
`,
  );
}

async function readSchemaExports(repoRoot: string): Promise<string[]> {
  const schemaSource = await readFile(
    path.join(repoRoot, 'packages/api-contract/src/validation/apiSchemas.ts'),
    'utf8',
  );
  return [...schemaSource.matchAll(/export\s+const\s+([A-Za-z0-9_]+Schema)\b/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name))
    .sort();
}

function findBalancedExpressionEnd(source: string, startIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      continue;
    }
    if (char === ';' && depth <= 0) {
      return index;
    }
  }
  return source.length;
}

async function readSchemaFingerprints(repoRoot: string): Promise<Record<string, string>> {
  const schemaSource = await readFile(
    path.join(repoRoot, 'packages/api-contract/src/validation/apiSchemas.ts'),
    'utf8',
  );
  const fingerprints: Record<string, string> = {};
  const schemaPattern = /export\s+const\s+([A-Za-z0-9_]+Schema)\s*=/g;
  for (const match of schemaSource.matchAll(schemaPattern)) {
    const name = match[1];
    if (!name) {
      continue;
    }
    const expressionStart = match.index + match[0].length;
    const expressionEnd = findBalancedExpressionEnd(schemaSource, expressionStart);
    const schemaDeclaration = schemaSource
      .slice(match.index, expressionEnd + 1)
      .replace(/\s+/g, ' ')
      .trim();
    fingerprints[name] = createHash('sha256').update(schemaDeclaration).digest('hex');
  }
  return Object.fromEntries(Object.entries(fingerprints).sort(([left], [right]) => left.localeCompare(right)));
}

export async function capturePublicContractSnapshot(
  options: {
    repoRoot?: string;
    sourceRef?: string;
    sourceRepoRoot?: string;
    capturedAt?: string;
  } = {},
): Promise<PublicContractSnapshot> {
  const initialRoot = options.repoRoot ?? process.cwd();
  const sourceRepoRoot = options.sourceRepoRoot ?? initialRoot;
  let repoRoot = initialRoot;
  let cleanup: MaterializedSourceRef | undefined;
  try {
    if (options.sourceRef) {
      cleanup = await materializeSourceRefFromRoot(sourceRepoRoot, options.sourceRef);
      repoRoot = cleanup.repoRoot;
    }

    const currentSourceMetadata = options.sourceRef
      ? {
          sourceSha: runGit(['rev-parse', '--short=12', options.sourceRef], sourceRepoRoot),
          dirtyStatus: 'source-ref' as const,
        }
      : resolveCurrentSourceMetadata(initialRoot);
    const { sourceSha, dirtyStatus } = currentSourceMetadata;
    const isolatedSourceRoot = Boolean(options.sourceRef);
    const contracts = await importRouteContracts(repoRoot, isolatedSourceRoot);
    const definitionsSource = await readFile(
      path.join(repoRoot, 'apps/api/src/server/api/routes/definitions.ts'),
      'utf8',
    );
    const registrations = parseRouteRegistrations(definitionsSource);
    const mountedBehavior = await captureMountedBehavior(repoRoot, isolatedSourceRoot);
    const mountedBehaviorCoverage = validateMountedBehaviorCoverage(mountedBehavior);
    const schemaExports = await readSchemaExports(repoRoot);
    const schemaFingerprints = await readSchemaFingerprints(repoRoot);
    const contractPayload = {
      routeContracts: contracts,
      mountedRoutes: buildMountedRoutes(contracts, registrations),
      mountedBehavior,
      mountedBehaviorCoverage,
      schemaExports,
      schemaFingerprints,
    };

    return {
      comparatorVersion: COMPARATOR_VERSION,
      ...omitUndefinedProperties({ sourceRef: options.sourceRef ?? 'HEAD' }),
      sourceSha,
      dirtyStatus,
      capturedAt: options.capturedAt ?? DETERMINISTIC_CAPTURED_AT,
      contractHash: hashStable(contractPayload),
      ...contractPayload,
    };
  } finally {
    if (cleanup) {
      await rm(cleanup.tempRoot, { recursive: true, force: true });
    }
  }
}

function collectDrift(before: unknown, after: unknown, currentPath: string[] = []): PublicContractDrift[] {
  if (stableStringify(before) === stableStringify(after)) {
    return [];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    return Array.from({ length }, (_, index) =>
      collectDrift(before[index], after[index], [...currentPath, String(index)]),
    ).flat();
  }
  if (
    !before ||
    !after ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [{ path: currentPath.join('.') || '$', before, after }];
  }

  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
  return keys.flatMap((key) => collectDrift(beforeRecord[key], afterRecord[key], [...currentPath, key]));
}

export function comparePublicContractSnapshots(
  baseline: PublicContractSnapshot,
  current: PublicContractSnapshot,
  classification: DriftClassification = {},
): PublicContractDrift[] {
  const allowed = new Set(classification.allowedDriftPaths ?? []);
  const comparableBaseline = toComparableSnapshot(baseline);
  const comparableCurrent = toComparableSnapshot(current);

  return collectDrift(comparableBaseline, comparableCurrent).filter((drift) => !allowed.has(drift.path));
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function writeSnapshot(outPath: string, snapshot: PublicContractSnapshot): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, stableStringify(snapshot));
}

function parseCli(argv: readonly string[]): CliOptions {
  const [command] = argv;
  if (command !== 'capture' && command !== 'compare') {
    throw new Error('Usage: public-contract-baseline.ts <capture|compare> [--source-ref <ref>] [--out <path>]');
  }
  const options: CliOptions = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag) {
      throw new Error('Missing option name');
    }
    if (flag === '--') {
      continue;
    }
    if (flag === '--require-clean-current') {
      options.requireCleanCurrent = true;
      continue;
    }
    const value = argv[index + 1];
    if (!flag.startsWith('--') || !value) {
      throw new Error(`Invalid argument near ${flag}`);
    }
    index += 1;
    if (flag === '--out') {
      options.out = value;
    } else if (flag === '--baseline') {
      options.baseline = value;
    } else if (flag === '--current') {
      options.current = value;
    } else if (flag === '--source-ref') {
      options.sourceRef = value;
    } else if (flag === '--classification') {
      options.classification = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'capture') {
    const outPath = options.out ?? (options.sourceRef ? DEFAULT_BASELINE_PATH : DEFAULT_CURRENT_PATH);
    const snapshot = await capturePublicContractSnapshot(omitUndefinedProperties({ sourceRef: options.sourceRef }));
    if (options.requireCleanCurrent && !options.sourceRef && snapshot.dirtyStatus !== 'clean') {
      throw new Error('Current public-contract capture requires a clean worktree for source-SHA-bound final evidence');
    }
    await writeSnapshot(outPath, snapshot);
    console.log(`Captured ${snapshot.routeContracts.length} public route contracts to ${outPath}`);
    console.log(`contractHash=${snapshot.contractHash}`);
    return;
  }

  const baselinePath = options.baseline ?? DEFAULT_BASELINE_PATH;
  const currentPath = options.current ?? DEFAULT_CURRENT_PATH;
  if (!existsSync(currentPath)) {
    await writeSnapshot(currentPath, await capturePublicContractSnapshot());
  }
  const baseline = await readJsonFile<PublicContractSnapshot>(baselinePath);
  const current = await readJsonFile<PublicContractSnapshot>(currentPath);
  const classification = options.classification
    ? await readJsonFile<DriftClassification>(options.classification)
    : undefined;
  const drift = comparePublicContractSnapshots(baseline, current, classification);
  if (drift.length > 0) {
    console.error(`Public contract drift is not classified (${drift.length} paths):`);
    for (const item of drift.slice(0, 25)) {
      console.error(`- ${item.path}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Public contract comparison passed (${baseline.sourceSha} -> ${current.sourceSha})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

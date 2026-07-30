import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  capturePublicContractSnapshot,
  comparePublicContractSnapshots,
  resolveCurrentSourceMetadata,
  type PublicContractSnapshot,
} from './public-contract-baseline';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function cloneSnapshot(snapshot: PublicContractSnapshot): PublicContractSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as PublicContractSnapshot;
}

function changeFirstRoutePath(snapshot: PublicContractSnapshot, routePath: string): string {
  const firstRoute = strictDefined(snapshot.routeContracts[0]);
  snapshot.routeContracts[0] = { ...firstRoute, path: routePath };
  return firstRoute.routeId;
}

const BASELINE_CAPTURED_AT = '2026-06-17T00:00:00.000Z';
const baselineSnapshot = await capturePublicContractSnapshot({ capturedAt: BASELINE_CAPTURED_AT });

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
    `import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';

export function createHonoApp(): { request: () => Promise<Response> } {
  return {
    request: async () =>
      new Response(JSON.stringify({ generation: resolveCurrentContractGeneration() }), {
        status: 218,
        headers: { 'content-type': 'application/json' },
      }),
  };
}
`,
  );
  await writeSourceFile(repoRoot, 'apps/api/src/server/api/routes/definitions.ts', `export const SOURCE_REF = true;\n`);
  await writeSourceFile(
    repoRoot,
    'packages/api-contract/src/api-contract/routes.ts',
    `export const TARGET_API_ROUTE_CONTRACTS = [] as const;\n`,
  );
  await writeSourceFile(
    repoRoot,
    'packages/api-contract/src/validation/apiSchemas.ts',
    `export const SourceRefMountedBehaviorSchema = { sourceRef: true };\n`,
  );
  await writeSourceFile(
    repoRoot,
    'packages/domain/package.json',
    `{"name":"@stark-ballot/domain","private":true,"type":"module","exports":{"./contract":"./src/lib/contract/index.ts"}}\n`,
  );
  await writeSourceFile(
    repoRoot,
    'packages/domain/src/lib/contract/index.ts',
    `export function resolveCurrentContractGeneration(): string {
  return 'source-ref-mounted-workspace';
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
  expect(committedFiles).toContain('packages/api-contract/src/api-contract/routes.ts');
  expect(committedFiles).toContain('packages/domain/src/lib/contract/index.ts');

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

  it('captures route contracts, schema exports, and mounted route modes', () => {
    const snapshot = cloneSnapshot(baselineSnapshot);

    expect(snapshot.comparatorType).toBe('public-contract-baseline');
    expect(snapshot.routeContracts.map((route) => route.routeId)).toContain('verification.bundle.get');
    expect(snapshot.schemaExports).toContain('StandardErrorResponseSchema');
    expect(strictDefined(snapshot.schemaFingerprints['StandardErrorResponseSchema'])).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.mountedRoutes.find((mode) => mode.mode === 'full')?.routeIds).toContain('finalizeCallback.post');
    expect(snapshot.mountedRoutes.find((mode) => mode.mode === 'lambda')?.routeIds).not.toContain(
      'finalizeCallback.post',
    );
    expect(snapshot.mountedRoutes.find((mode) => mode.mode === 'readonly')?.routeIds).toContain('verify.get');
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
      status: 304,
      body: {
        bytes: 0,
      },
    });
    expect(
      snapshot.mountedBehavior.find((probe) => probe.probeId === 'lambda.bundle.range-unsatisfiable.416'),
    ).toMatchObject({
      status: 416,
      headers: {
        'content-range': 'bytes */6',
      },
    });
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
      snapshot.mountedBehavior.find((probe) => probe.probeId === 'lambda.session-status.finalized.no-store'),
    ).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
    expect(snapshot.mountedBehaviorCoverage.map((entry) => entry.caseId)).toContain('bundle-range-unsatisfiable-416');
    expect(snapshot.mountedBehaviorCoverage.map((entry) => entry.caseId)).toEqual(
      expect.arrayContaining([
        'session-creation-success-flow',
        'vote-success-flow',
        'progress-read-flow',
        'finalize-success-flow',
        'session-status-finalized-flow',
        'verify-finalized-flow',
        'verification-run-flow',
        'verification-observation-flow',
      ]),
    );
    expect(snapshot.mountedBehaviorCoverage.find((entry) => entry.caseId === 'report-size-failure-413')).toMatchObject({
      status: 'exempt',
    });
  });

  it('uses deterministic capture timestamps by default', async () => {
    const snapshot = await capturePublicContractSnapshot();

    expect(snapshot.capturedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('fails unclassified drift', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    changeFirstRoutePath(current, '/changed');

    expect(comparePublicContractSnapshots(baseline, current).map((drift) => drift.path)).toContain(
      `${strictDefined(baseline.routeContracts[0]).routeId}.path`.replace(/^/, 'routeContracts.'),
    );
  });

  it('fails unclassified schema body drift even when the export name is unchanged', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    current.schemaFingerprints = {
      ...current.schemaFingerprints,
      StandardErrorResponseSchema: '0'.repeat(64),
    };

    expect(comparePublicContractSnapshots(baseline, current).map((drift) => drift.path)).toContain(
      'schemaFingerprints.StandardErrorResponseSchema',
    );
  });

  it('fails unclassified mounted behavior drift', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const firstProbe = strictDefined(current.mountedBehavior[0]);
    current.mountedBehavior[0] = { ...firstProbe, status: 599 };

    expect(comparePublicContractSnapshots(baseline, current).map((drift) => drift.path)).toContain(
      `mountedBehavior.${firstProbe.probeId}.status`,
    );
  });

  it('captures source-ref mounted behavior and workspace packages from the materialized source tree', async () => {
    const fixture = await createSourceRefMountedBehaviorFixture();
    try {
      const snapshot = await capturePublicContractSnapshot({
        sourceRef: fixture.sourceRef,
        sourceRepoRoot: fixture.repoRoot,
        capturedAt: '2026-06-17T00:00:00.000Z',
      });
      const sourceRefBodyHash = createHash('sha256')
        .update(JSON.stringify({ generation: 'source-ref-mounted-workspace' }))
        .digest('hex');

      expect(snapshot.dirtyStatus).toBe('source-ref');
      expect(snapshot.mountedBehavior).not.toEqual([]);
      expect(snapshot.mountedBehavior.every((probe) => probe.status === 218)).toBe(true);
      expect(snapshot.mountedBehavior.every((probe) => probe.body.sha256 === sourceRefBodyHash)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows explicitly classified drift paths', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const routeId = changeFirstRoutePath(current, '/changed');

    expect(
      comparePublicContractSnapshots(baseline, current, {
        allowedDriftPaths: [`routeContracts.${routeId}.path`],
      }),
    ).toEqual([]);
  });

  it('does not allow old numeric route paths to hide reorder drift', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const firstRoute = strictDefined(current.routeContracts[0]);
    current.routeContracts = [...current.routeContracts.slice(1), firstRoute];
    const changedRoute = strictDefined(current.routeContracts[0]);
    current.routeContracts[0] = { ...changedRoute, path: '/changed-after-reorder' };

    expect(
      comparePublicContractSnapshots(baseline, current, {
        allowedDriftPaths: ['routeContracts.0.path'],
      }).map((drift) => drift.path),
    ).toContain(`routeContracts.${changedRoute.routeId}.path`);
  });

  it('does not allow old numeric schema paths to hide unrelated schema insertion', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    current.schemaExports = [
      ...current.schemaExports.slice(0, 10),
      'UnrelatedInsertedSchema',
      ...current.schemaExports.slice(10),
    ];

    expect(
      comparePublicContractSnapshots(baseline, current, {
        allowedDriftPaths: ['schemaExports.10'],
      }).map((drift) => drift.path),
    ).toContain('schemaExports.UnrelatedInsertedSchema');
  });

  it('does not allow old numeric mounted behavior paths to hide probe reorder drift', () => {
    const baseline = cloneSnapshot(baselineSnapshot);
    const current = cloneSnapshot(baseline);
    const firstProbe = strictDefined(current.mountedBehavior[0]);
    current.mountedBehavior = [...current.mountedBehavior.slice(1), firstProbe];
    const changedProbe = strictDefined(current.mountedBehavior[0]);
    current.mountedBehavior[0] = { ...changedProbe, status: 599 };

    expect(
      comparePublicContractSnapshots(baseline, current, {
        allowedDriftPaths: ['mountedBehavior.0.status'],
      }).map((drift) => drift.path),
    ).toContain(`mountedBehavior.${changedProbe.probeId}.status`);
  });
});

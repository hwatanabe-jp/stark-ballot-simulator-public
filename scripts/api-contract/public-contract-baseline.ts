import { isNode, isReexport, isStringLiteral, parseSource, staticText } from '../source-analysis/source';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatSource } from '../formatting/format-source';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import { createVerificationBundleArchive } from '@stark-ballot/node-adapters/verification-bundle';
import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { resolvePublicBundlePolicy } from '@stark-ballot/verification/public-bundle-manifest';
import { projectTypedRoutesForBaseline, type BaselineApiRouteContract } from './typed-route-baseline-projection';
import {
  buildPublicContractCliPlan,
  parsePublicContractCli,
  renderPublicContractCaptureSuccess,
  renderPublicContractComparisonSuccess,
  renderPublicContractDriftFailure,
} from './lib/public-contract-cli';
import {
  buildMountedRoutes,
  buildPublicContractSnapshot,
  buildSchemaDeclarationFingerprints,
  buildSchemaSemanticSnapshot,
  collectSchemaExportNames,
  normalizeRouteContracts,
  parseTypedMountedRouteKeys,
  projectTypedRouteRegistrations,
  resolveSchemaEntryPath,
  type ParsedRouteRegistration,
  type SchemaSourceModule,
  type TypedMountedRoute,
} from './lib/public-contract-capture-policy';
import {
  comparePublicContractSnapshots,
  parseDriftClassification,
  parsePublicContractSnapshot,
  parseSchemaSemanticSnapshot,
  stableStringify,
  type MountedBehaviorMode,
  type MountedBehaviorProbe,
  type MountedBehaviorProbeSnapshot,
  type PublicContractSnapshot,
  type SchemaSemanticSnapshot,
} from './lib/public-contract-policy';
import {
  buildMountedBehaviorProbes,
  buildMountedBehaviorProbeSnapshot,
  buildProbeStore,
  deterministicProbeRequestId,
  sortMountedBehaviorSnapshots,
  validateMountedBehaviorCoverage,
} from './lib/public-contract-probe-policy';

interface MaterializedSourceRef {
  repoRoot: string;
  tempRoot: string;
}

function requireJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(source: string, label: string): Record<string, unknown> {
  const input: unknown = JSON.parse(source);
  return requireJsonRecord(input, label);
}

function parseIsolatedRouteContracts(value: unknown): BaselineApiRouteContract[] {
  if (!Array.isArray(value)) {
    throw new Error('isolated route contracts must be an array');
  }
  for (const [index, entry] of value.entries()) {
    const route = requireJsonRecord(entry, `isolated route contract[${index}]`);
    for (const key of ['routeId', 'method', 'path'] as const) {
      if (typeof route[key] !== 'string' || route[key].length === 0) {
        throw new Error(`isolated route contract[${index}].${key} must be a nonempty string`);
      }
    }
  }
  return value as BaselineApiRouteContract[];
}

function parseIsolatedMountedRoutes(value: unknown): TypedMountedRoute[] {
  if (!Array.isArray(value)) {
    throw new Error('isolated mounted routes must be an array');
  }
  return value.map((entry, index) => {
    const route = requireJsonRecord(entry, `isolated mounted route[${index}]`);
    const read = (key: keyof TypedMountedRoute): string => {
      const candidate = route[key];
      if (typeof candidate !== 'string' || candidate.length === 0) {
        throw new Error(`isolated mounted route[${index}].${key} must be a nonempty string`);
      }
      return candidate;
    };
    return {
      routeId: read('routeId'),
      method: read('method'),
      path: read('path'),
      kind: read('kind'),
      lifecycle: read('lifecycle'),
    };
  });
}

function parseMountedBehaviorSnapshots(value: unknown): MountedBehaviorProbeSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error('isolated mounted behavior snapshots must be an array');
  }
  for (const [index, entry] of value.entries()) {
    const snapshot = requireJsonRecord(entry, `isolated mounted behavior snapshot[${index}]`);
    if (typeof snapshot['probeId'] !== 'string' || !Number.isInteger(snapshot['status'])) {
      throw new Error(`isolated mounted behavior snapshot[${index}] is invalid`);
    }
    requireJsonRecord(snapshot['body'], `isolated mounted behavior snapshot[${index}].body`);
  }
  return value as MountedBehaviorProbeSnapshot[];
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
      const manifest = parseJsonRecord(await readFile(manifestPath, 'utf8'), `package manifest ${manifestPath}`);
      const packageName = manifest['name'];
      if (typeof packageName === 'string' && packageName.startsWith('@stark-ballot/')) {
        await symlink(packageDir, path.join(starkBallotScope, packageName.slice('@stark-ballot/'.length)));
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
      const manifest = parseJsonRecord(await readFile(manifestPath, 'utf8'), `package manifest ${manifestPath}`);
      const packageName = manifest['name'];
      if (typeof packageName !== 'string' || !packageName.startsWith('@stark-ballot/')) {
        continue;
      }
      const linkPath = path.join(starkBallotScope, packageName.slice('@stark-ballot/'.length));
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
  const contractRoutePath = path.join(repoRoot, 'packages/api-contract/src/routes/index.ts');
  if (!existsSync(contractRoutePath)) {
    const rootEntries = existsSync(repoRoot) ? await readdir(repoRoot) : [];
    await rm(tempRoot, { recursive: true, force: true });
    throw new Error(
      `materialized source ref ${sourceRef} is missing the typed API route inventory; root entries: ${rootEntries.join(', ')}`,
    );
  }
  await linkCurrentDependencies(repoRoot);
  return { repoRoot, tempRoot };
}

function runSourceRootJson(repoRoot: string, script: string): unknown {
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
  return JSON.parse(payloadLine.slice(marker.length)) as unknown;
}

async function importRouteContracts(repoRoot: string, isolatedSourceRoot = false): Promise<BaselineApiRouteContract[]> {
  const typedModulePath = path.join(repoRoot, 'packages/api-contract/src/routes/index.ts');
  let routeContracts: readonly BaselineApiRouteContract[];

  if (isolatedSourceRoot) {
    routeContracts = parseIsolatedRouteContracts(
      runSourceRootJson(
        repoRoot,
        `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const routeModule = await import(pathToFileURL(path.join(process.cwd(), 'packages/api-contract/src/routes/index.ts')).href);
const projectionModule = await import(pathToFileURL(path.join(process.cwd(), 'scripts/api-contract/typed-route-baseline-projection.ts')).href);
const projected = projectionModule.projectTypedRoutesForBaseline(routeModule.TARGET_API_ROUTE_CONTRACTS);
console.log('__PUBLIC_CONTRACT_BASELINE_JSON__' + JSON.stringify(projected));
`,
      ),
    );
  } else {
    const routeModule = (await import(pathToFileURL(typedModulePath).href)) as {
      TARGET_API_ROUTE_CONTRACTS: readonly import('@stark-ballot/api-contract/routes').ApiRouteContract[];
    };
    routeContracts = projectTypedRoutesForBaseline(routeModule.TARGET_API_ROUTE_CONTRACTS);
  }

  return normalizeRouteContracts(routeContracts);
}

async function importTypedRouteRegistrations(
  repoRoot: string,
  isolatedSourceRoot: boolean,
  honoSource: string,
): Promise<ParsedRouteRegistration[]> {
  const routeKeys = parseTypedMountedRouteKeys(honoSource);
  let mountedRoutes: TypedMountedRoute[];

  if (isolatedSourceRoot) {
    mountedRoutes = parseIsolatedMountedRoutes(
      runSourceRootJson(
        repoRoot,
        `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const routeModule = await import(pathToFileURL(path.join(process.cwd(), 'packages/api-contract/src/routes/index.ts')).href);
const routeKeys = ${JSON.stringify(routeKeys)};
const mountedRoutes = routeKeys.map((key) => {
  const route = routeModule.API_ROUTES[key];
  if (!route) throw new Error('Typed Hono mount references unknown API_ROUTES key: ' + key);
  return {
    routeId: route.routeId,
    method: route.method,
    path: route.path,
    kind: route.kind,
    lifecycle: route.lifecycle,
  };
});
console.log('__PUBLIC_CONTRACT_BASELINE_JSON__' + JSON.stringify(mountedRoutes));
`,
      ),
    );
  } else {
    const routeModule = (await import(
      pathToFileURL(path.join(repoRoot, 'packages/api-contract/src/routes/index.ts')).href
    )) as {
      API_ROUTES: Readonly<Record<string, TypedMountedRoute>>;
    };
    mountedRoutes = routeKeys.map((key) => {
      const route = routeModule.API_ROUTES[key];
      if (!route) {
        throw new Error(`Typed Hono mount references unknown API_ROUTES key: ${key}`);
      }
      return route;
    });
  }

  return projectTypedRouteRegistrations(mountedRoutes);
}

async function prepareProbeArtifacts(root: string, sessionId: string, finalizationId: string): Promise<void> {
  const artifactDir = path.join(root, sessionId, finalizationId);
  await mkdir(artifactDir, { recursive: true });
  const bundlePolicy = resolvePublicBundlePolicy('sync');
  await Promise.all(
    bundlePolicy.requiredMembers.map((member) =>
      writeFile(path.join(artifactDir, member), `${JSON.stringify({ artifact: member })}\n`),
    ),
  );
  await createVerificationBundleArchive(artifactDir, { policy: bundlePolicy });
  await writeFile(path.join(artifactDir, 'verification.json'), `${JSON.stringify({ ok: true })}\n`);
}

async function snapshotProbeResponse(
  probe: MountedBehaviorProbe,
  response: Response,
  expectedRequestId: string,
): Promise<MountedBehaviorProbeSnapshot> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return buildMountedBehaviorProbeSnapshot({
    probe,
    status: response.status,
    headers: response.headers,
    bytes,
    expectedRequestId,
  });
}

export async function captureMountedBehaviorForSourceRoot(repoRoot: string): Promise<MountedBehaviorProbeSnapshot[]> {
  const sessionId = 'session-baseline-mounted';
  const finalizationId = 'finalization-baseline-mounted';
  const capabilitySecret = 'public-contract-mounted-baseline-secret-0123456789abcdef';
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'stark-ballot-mounted-baseline-'));
  const previousEnv: Record<string, string | undefined> = {
    EXPECTED_ORIGIN_VERIFY_HEADER: process.env['EXPECTED_ORIGIN_VERIFY_HEADER'],
    FINALIZE_CALLBACK_BODY_LIMIT_BYTES: process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES'],
    FINALIZE_CALLBACK_MAX_SKEW_MS: process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'],
    FINALIZE_CALLBACK_SECRET: process.env['FINALIZE_CALLBACK_SECRET'],
    HONO_CORS_ALLOW_ORIGINS: process.env['HONO_CORS_ALLOW_ORIGINS'],
    SESSION_CAPABILITY_SECRET: process.env['SESSION_CAPABILITY_SECRET'],
    TRUSTED_PROXY: process.env['TRUSTED_PROXY'],
    VERIFIER_WORK_DIR: process.env['VERIFIER_WORK_DIR'],
  };
  const globalStore = globalThis as typeof globalThis & {
    __globalStoreInstance?: unknown;
  };
  const previousStore = globalStore.__globalStoreInstance;

  try {
    await prepareProbeArtifacts(artifactRoot, sessionId, finalizationId);
    delete process.env['EXPECTED_ORIGIN_VERIFY_HEADER'];
    process.env['FINALIZE_CALLBACK_BODY_LIMIT_BYTES'] = '8192';
    process.env['FINALIZE_CALLBACK_MAX_SKEW_MS'] = '300000';
    process.env['FINALIZE_CALLBACK_SECRET'] = 'public-contract-callback-baseline-secret-0123456789abcdef';
    process.env['HONO_CORS_ALLOW_ORIGINS'] = 'http://localhost:3000';
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    process.env['TRUSTED_PROXY'] = 'none';
    process.env['VERIFIER_WORK_DIR'] = artifactRoot;
    globalStore.__globalStoreInstance = buildProbeStore(
      sessionId,
      finalizationId,
    ) as unknown as typeof globalStore.__globalStoreInstance;

    const honoModulePath = path.join(repoRoot, 'apps/api/src/server/api/routes/hono.ts');
    const honoModule = (await import(pathToFileURL(honoModulePath).href)) as {
      createHonoApp: (options: {
        basePath: string;
        mode: MountedBehaviorMode;
        runtimeProfile: ResolvedRuntimeProfile;
      }) => {
        request: (
          input: string,
          init?: RequestInit,
          env?: {
            requestContext: {
              requestId: string;
            };
          },
        ) => Promise<Response>;
      };
    };
    const capability = createSessionCapabilityToken({ sessionId: asSessionId(sessionId) }, capabilitySecret);
    const pathCapabilityHeaders = {
      [SESSION_CAPABILITY_HEADER]: capability,
    };
    const probes = buildMountedBehaviorProbes({
      sessionId,
      finalizationId,
      pathCapabilityHeaders,
    });
    const runtimeProfile = resolveRuntimeProfile({ RUNTIME_PROFILE: 'local-demo' });

    const appsByMode = new Map<MountedBehaviorMode, ReturnType<typeof honoModule.createHonoApp>>();
    const resolveApp = (mode: MountedBehaviorMode): ReturnType<typeof honoModule.createHonoApp> => {
      const existing = appsByMode.get(mode);
      if (existing) {
        return existing;
      }
      const app = honoModule.createHonoApp({ basePath: '/api', mode, runtimeProfile });
      appsByMode.set(mode, app);
      return app;
    };

    const snapshots: MountedBehaviorProbeSnapshot[] = [];
    for (const probe of probes) {
      // The reviewed current-finalization variant intentionally has no admitted bitmap sidecar.
      // Focused public-contract tests own the available projection; bitmap endpoint probes keep available evidence.
      globalStore.__globalStoreInstance = buildProbeStore(sessionId, finalizationId, {
        bitmapEvidence:
          probe.probeId === 'lambda.current-finalization.succeeded.no-store' ? 'unavailable' : 'available',
      }) as unknown as typeof globalStore.__globalStoreInstance;
      const app = resolveApp(probe.mode);
      const headers = { ...(probe.headers ?? {}) };
      const requestId = deterministicProbeRequestId(probe.probeId);
      const env = { requestContext: { requestId } };
      if (probe.probeId === 'lambda.bitmap.conditional.no-body') {
        const fresh = await app.request(
          probe.url,
          {
            method: probe.method,
            headers,
          },
          env,
        );
        const etag = fresh.headers.get('etag');
        if (etag) {
          headers['If-None-Match'] = etag;
        }
      }
      snapshots.push(
        await snapshotProbeResponse(
          probe,
          await app.request(
            probe.url,
            {
              method: probe.method,
              headers,
            },
            env,
          ),
          requestId,
        ),
      );
    }
    return sortMountedBehaviorSnapshots(snapshots);
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

function captureMountedBehavior(repoRoot: string): MountedBehaviorProbeSnapshot[] {
  const moduleUrl = pathToFileURL(new URL(import.meta.url).pathname).href;
  return parseMountedBehaviorSnapshots(
    runSourceRootJson(
      repoRoot,
      `
import { captureMountedBehaviorForSourceRoot } from ${JSON.stringify(moduleUrl)};
const result = await captureMountedBehaviorForSourceRoot(process.cwd());
console.log('__PUBLIC_CONTRACT_BASELINE_JSON__' + JSON.stringify(result));
`,
    ),
  );
}

async function readSchemaSourceModules(repoRoot: string): Promise<Map<string, SchemaSourceModule>> {
  const pending = [resolveSchemaEntryPath(repoRoot)];
  const modules = new Map<string, SchemaSourceModule>();

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || modules.has(currentPath)) {
      continue;
    }
    const source = await readFile(currentPath, 'utf8');
    const sourceFile = parseSource(currentPath, source);
    modules.set(currentPath, { source, sourceFile });

    for (const statement of sourceFile.body) {
      if (!isReexport(statement) || !statement.source || !isStringLiteral(statement.source)) {
        continue;
      }
      const resolved = resolveSchemaAuthorityImport(repoRoot, currentPath, staticText(statement.source));
      if (resolved && !modules.has(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return modules;
}

async function readSchemaExports(repoRoot: string): Promise<string[]> {
  const modules = await readSchemaSourceModules(repoRoot);
  return collectSchemaExportNames(modules.values());
}

async function readSchemaFingerprints(repoRoot: string): Promise<Record<string, string>> {
  const modules = await readSchemaSourceModules(repoRoot);
  return buildSchemaDeclarationFingerprints(modules.values());
}

export async function captureSchemaSemanticsForSourceRoot(repoRoot: string): Promise<SchemaSemanticSnapshot> {
  const entryPath = resolveSchemaEntryPath(repoRoot);
  const schemaModule = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
  return buildSchemaSemanticSnapshot(schemaModule);
}

async function readSchemaSemantics(repoRoot: string, isolatedSourceRoot: boolean): Promise<SchemaSemanticSnapshot> {
  if (!isolatedSourceRoot) {
    return captureSchemaSemanticsForSourceRoot(repoRoot);
  }
  const moduleUrl = pathToFileURL(new URL(import.meta.url).pathname).href;
  return parseSchemaSemanticSnapshot(
    runSourceRootJson(
      repoRoot,
      `
import { captureSchemaSemanticsForSourceRoot } from ${JSON.stringify(moduleUrl)};
const result = await captureSchemaSemanticsForSourceRoot(process.cwd());
console.log('__PUBLIC_CONTRACT_BASELINE_JSON__' + JSON.stringify(result));
`,
    ),
    'isolated schema semantic snapshot',
  );
}

function resolveWorkspacePackageExport(packageDir: string, subpath: string | undefined): string | undefined {
  const manifestPath = path.join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  const manifest = parseJsonRecord(readFileSync(manifestPath, 'utf8'), `package manifest ${manifestPath}`);
  const manifestExports = manifest['exports'];
  if (!manifestExports || typeof manifestExports !== 'object' || Array.isArray(manifestExports)) {
    return undefined;
  }
  const exportsMap = requireJsonRecord(manifestExports, `package exports ${manifestPath}`);
  const exportKey = subpath ? `./${subpath}` : '.';
  const exactTarget = exportsMap[exportKey];
  if (typeof exactTarget === 'string') {
    return path.resolve(packageDir, exactTarget);
  }
  for (const [key, target] of Object.entries(exportsMap)) {
    if (!key.includes('*') || typeof target !== 'string' || !target.includes('*')) {
      continue;
    }
    const wildcardIndex = key.indexOf('*');
    const keyPrefix = key.slice(0, wildcardIndex);
    const keySuffix = key.slice(wildcardIndex + 1);
    if (!exportKey.startsWith(keyPrefix) || !exportKey.endsWith(keySuffix)) {
      continue;
    }
    const matched = exportKey.slice(keyPrefix.length, exportKey.length - keySuffix.length);
    return path.resolve(packageDir, target.replace('*', matched));
  }
  return undefined;
}

function resolveSchemaAuthorityImport(repoRoot: string, importerPath: string, moduleName: string): string | undefined {
  let unresolvedPath: string;
  if (moduleName.startsWith('.')) {
    unresolvedPath = path.resolve(path.dirname(importerPath), moduleName);
  } else {
    const workspaceMatch = /^@stark-ballot\/([^/]+)(?:\/(.+))?$/u.exec(moduleName);
    if (!workspaceMatch?.[1]) {
      return undefined;
    }
    const packageDir = path.join(repoRoot, 'packages', workspaceMatch[1]);
    unresolvedPath =
      resolveWorkspacePackageExport(packageDir, workspaceMatch[2]) ??
      path.join(packageDir, 'src', workspaceMatch[2] ?? 'index');
  }

  const candidates = [
    unresolvedPath,
    `${unresolvedPath}.ts`,
    `${unresolvedPath}.tsx`,
    unresolvedPath.replace(/\.[cm]?js$/u, '.ts'),
    path.join(unresolvedPath, 'index.ts'),
  ];
  const normalizedRepoRoot = `${path.resolve(repoRoot)}${path.sep}`;
  return candidates.find((candidate) => {
    const normalizedCandidate = path.resolve(candidate);
    return normalizedCandidate.startsWith(normalizedRepoRoot) && existsSync(normalizedCandidate);
  });
}

async function readSchemaAuthorityFingerprints(repoRoot: string): Promise<Record<string, string>> {
  const entryPath = resolveSchemaEntryPath(repoRoot);
  const pending = [entryPath];
  const visited = new Set<string>();
  const fingerprints: Record<string, string> = {};

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);
    const source = (await readFile(currentPath, 'utf8')).replace(/\r\n?/gu, '\n');
    const relativePath = path.relative(repoRoot, currentPath).split(path.sep).join('/');
    fingerprints[relativePath] = createHash('sha256').update(source).digest('hex');
    if (path.extname(currentPath) === '.json') {
      JSON.parse(source);
      continue;
    }

    const sourceFile = parseSource(currentPath, source);
    for (const statement of sourceFile.body) {
      const moduleSpecifier =
        isNode(statement, 'ImportDeclaration') || isReexport(statement) ? statement.source : undefined;
      if (!moduleSpecifier || !isStringLiteral(moduleSpecifier)) {
        continue;
      }
      const resolved = resolveSchemaAuthorityImport(repoRoot, currentPath, staticText(moduleSpecifier));
      if (resolved && !visited.has(resolved)) {
        pending.push(resolved);
      }
    }
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
    const registrations = await importTypedRouteRegistrations(
      repoRoot,
      isolatedSourceRoot,
      await readFile(path.join(repoRoot, 'apps/api/src/server/api/routes/hono.ts'), 'utf8'),
    );
    const mountedBehavior = captureMountedBehavior(repoRoot);
    const mountedBehaviorCoverage = validateMountedBehaviorCoverage(mountedBehavior);
    const schemaExports = await readSchemaExports(repoRoot);
    const schemaFingerprints = await readSchemaFingerprints(repoRoot);
    const schemaAuthorityFingerprints = await readSchemaAuthorityFingerprints(repoRoot);
    const schemaSemantics = await readSchemaSemantics(repoRoot, isolatedSourceRoot);
    const semanticSchemaExports = Object.keys(schemaSemantics.fingerprints).sort();
    if (stableStringify(semanticSchemaExports) !== stableStringify(schemaExports)) {
      throw new Error(
        `Runtime schema exports do not match the source schema inventory (source: ${schemaExports.join(', ')}; runtime: ${semanticSchemaExports.join(', ')})`,
      );
    }
    return buildPublicContractSnapshot({
      ...(options.sourceRef === undefined ? {} : { sourceRef: options.sourceRef }),
      sourceSha,
      dirtyStatus,
      ...(options.capturedAt === undefined ? {} : { capturedAt: options.capturedAt }),
      routeContracts: contracts,
      mountedRoutes: buildMountedRoutes(contracts, registrations),
      mountedBehavior,
      mountedBehaviorCoverage,
      schemaExports,
      schemaFingerprints,
      schemaAuthorityFingerprints,
      schemaSemantics,
    });
  } finally {
    if (cleanup) {
      await rm(cleanup.tempRoot, { recursive: true, force: true });
    }
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

async function writeSnapshot(outPath: string, snapshot: PublicContractSnapshot): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, await formatSource(outPath, stableStringify(snapshot)));
}

async function main(): Promise<void> {
  const options = parsePublicContractCli(process.argv.slice(2));
  const initialPlan = buildPublicContractCliPlan(options, false);
  const plan =
    initialPlan.command === 'compare'
      ? buildPublicContractCliPlan(options, existsSync(initialPlan.currentPath))
      : initialPlan;
  if (plan.command === 'capture') {
    const snapshot = await capturePublicContractSnapshot(omitUndefinedProperties({ sourceRef: plan.sourceRef }));
    if (plan.requireCleanCurrent && !plan.sourceRef && snapshot.dirtyStatus !== 'clean') {
      throw new Error('Current public-contract capture requires a clean worktree for source-SHA-bound final evidence');
    }
    await writeSnapshot(plan.outPath, snapshot);
    for (const line of renderPublicContractCaptureSuccess(
      snapshot.routeContracts.length,
      plan.outPath,
      snapshot.contractHash,
    )) {
      console.log(line);
    }
    return;
  }

  if (plan.captureCurrent) {
    await writeSnapshot(plan.currentPath, await capturePublicContractSnapshot());
  }
  const baseline = parsePublicContractSnapshot(
    await readJsonFile(plan.baselinePath),
    'Baseline public-contract snapshot',
  );
  const current = parsePublicContractSnapshot(await readJsonFile(plan.currentPath), 'Current public-contract snapshot');
  const classification = plan.classificationPath
    ? parseDriftClassification(await readJsonFile(plan.classificationPath))
    : undefined;
  const drift = comparePublicContractSnapshots(baseline, current, classification);
  if (drift.length > 0) {
    for (const line of renderPublicContractDriftFailure(drift)) {
      console.error(line);
    }
    process.exitCode = 1;
    return;
  }
  console.log(renderPublicContractComparisonSuccess(baseline.sourceSha, current.sourceSha));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

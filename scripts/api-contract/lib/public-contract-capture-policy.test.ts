import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { BaselineApiRouteContract } from '../typed-route-baseline-projection';
import {
  buildMountedRoutes,
  buildPublicContractSnapshot,
  buildSchemaDeclarationFingerprints,
  collectSchemaExportNames,
  normalizeRouteContracts,
  parseTypedMountedRouteKeys,
  projectTypedRouteRegistrations,
  type SchemaSourceModule,
} from './public-contract-capture-policy';
import { computePublicContractHash } from './public-contract-policy';

function route(
  routeId: string,
  method: 'GET' | 'POST',
  path: string,
  overrides: Partial<BaselineApiRouteContract> = {},
): BaselineApiRouteContract {
  return {
    routeId,
    method,
    path,
    kind: 'readonly',
    lifecycle: 'active',
    authScope: 'path-session-capability',
    capabilityScope: 'path',
    request: {},
    responses: [],
    publicErrorShape: 'standard-error-envelope',
    publicErrors: {
      envelope: 'standard-error-envelope',
      codes: [],
      responses: [],
    },
    dataClassification: 'owner-scoped-public-projection',
    admissionControls: [],
    bodySize: { applies: false },
    sourceIp: {
      dependency: 'not-required',
      runtimeEnforcementHandoff: 'none',
    },
    productionBypass: 'not-applicable',
    ...overrides,
  };
}

function schemaSourceModule(source: string): SchemaSourceModule {
  return {
    source,
    sourceFile: ts.createSourceFile('schemas.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

describe('public contract capture policy', () => {
  it('keeps repository policy modules free of filesystem, subprocess, process, and shell dependencies', () => {
    for (const fileName of [
      'public-contract-policy.ts',
      'public-contract-cli.ts',
      'public-contract-capture-policy.ts',
      'public-contract-probe-policy.ts',
    ]) {
      const source = readFileSync(path.join(import.meta.dirname, fileName), 'utf8');
      expect(source, fileName).not.toMatch(/from ['"]node:(?:fs|child_process)['"]/u);
      expect(source, fileName).not.toMatch(/\bprocess\./u);
      expect(source, fileName).not.toMatch(/\bconsole\./u);
      expect(source, fileName).not.toMatch(/from ['"]\.\.\/public-contract-baseline['"]/u);
    }
  });

  it('parses typed Hono mounts in deterministic order and rejects duplicate mounts', () => {
    const source = `
      mountRoute(app, mode, runtimeProfile, API_ROUTES.vote);
      mountArtifactRoute(API_ROUTES.bundle, dependencies);
      mountRoute(app, mode, runtimeProfile, API_ROUTES.session);
    `;

    expect(parseTypedMountedRouteKeys(source)).toEqual(['bundle', 'session', 'vote']);
    expect(() =>
      parseTypedMountedRouteKeys(`${source}\nmountRoute(app, mode, runtimeProfile, API_ROUTES.vote);`),
    ).toThrow('Duplicate typed Hono route mount: vote');
  });

  it('normalizes route and registration order before projecting mounted modes', () => {
    const readonlyRoute = route('readonly.get', 'GET', '/readonly');
    const mutationRoute = route('mutation.post', 'POST', '/mutation', { kind: 'mutation' });
    const retiredRoute = route('retired.get', 'GET', '/retired', { lifecycle: 'internal-operator-only' });
    const contracts = normalizeRouteContracts([retiredRoute, mutationRoute, readonlyRoute]);
    const registrations = projectTypedRouteRegistrations([
      {
        routeId: retiredRoute.routeId,
        method: retiredRoute.method,
        path: retiredRoute.path,
        kind: retiredRoute.kind,
        lifecycle: retiredRoute.lifecycle,
      },
      {
        routeId: mutationRoute.routeId,
        method: mutationRoute.method,
        path: mutationRoute.path,
        kind: mutationRoute.kind,
        lifecycle: mutationRoute.lifecycle,
      },
      {
        routeId: readonlyRoute.routeId,
        method: readonlyRoute.method,
        path: readonlyRoute.path,
        kind: readonlyRoute.kind,
        lifecycle: readonlyRoute.lifecycle,
      },
    ]);

    expect(contracts.map(({ routeId }) => routeId)).toEqual(['readonly.get', 'retired.get', 'mutation.post']);
    expect(registrations.map(({ path }) => path)).toEqual(['/readonly', '/retired', '/mutation']);
    expect(buildMountedRoutes(contracts, registrations).map(({ mode, routeIds }) => ({ mode, routeIds }))).toEqual([
      { mode: 'full', routeIds: ['readonly.get', 'retired.get', 'mutation.post'] },
      { mode: 'lambda', routeIds: ['readonly.get', 'mutation.post'] },
      { mode: 'readonly', routeIds: ['readonly.get'] },
    ]);
  });

  it('rejects a mounted inventory that does not exactly match route contracts', () => {
    expect(() =>
      buildMountedRoutes(
        [route('known.get', 'GET', '/known')],
        [{ method: 'GET', path: '/other', kind: 'readonly', excludeFromLambda: false }],
      ),
    ).toThrow('Route registration inventory does not match active contracts (missing: GET /known; extra: GET /other)');
  });

  it('derives deterministic schema names and declaration fingerprints from source modules', () => {
    const modules = [
      schemaSourceModule(`
        export const ZebraSchema = createSchema({ zebra: true });
        const PrivateSchema = createSchema({ private: true });
      `),
      schemaSourceModule(`
        export const AlphaSchema = createSchema({ alpha: true });
        export const NotAContract = true;
      `),
    ];

    expect(collectSchemaExportNames(modules)).toEqual(['AlphaSchema', 'ZebraSchema']);
    const fingerprints = buildSchemaDeclarationFingerprints(modules);
    expect(Object.keys(fingerprints)).toEqual(['AlphaSchema', 'ZebraSchema']);
    expect(fingerprints['AlphaSchema']).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprints['ZebraSchema']).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('assembles a deterministic snapshot and hashes only the contract payload', () => {
    const snapshot = buildPublicContractSnapshot({
      sourceSha: '0123456789ab',
      dirtyStatus: 'clean',
      routeContracts: [],
      mountedRoutes: [],
      mountedBehavior: [],
      mountedBehaviorCoverage: [],
      schemaExports: [],
      schemaFingerprints: {},
      schemaAuthorityFingerprints: {},
      schemaSemantics: {
        algorithm: 'json-wire-admission',
        fingerprints: {},
      },
    });

    expect(snapshot).toMatchObject({
      comparatorType: 'public-contract-baseline',
      sourceRef: 'HEAD',
      sourceSha: '0123456789ab',
      dirtyStatus: 'clean',
      capturedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(snapshot.contractHash).toBe(computePublicContractHash(snapshot));
  });
});

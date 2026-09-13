import type * as ESTree from 'oxc-parser';
import {
  forEachChild,
  isExported,
  isNode,
  isStaticMember,
  nodeText,
  parseSource,
  staticText,
  topLevelDeclarations,
} from '../../source-analysis/source';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AnySchema } from '@stark-ballot/validation/schema';
import { fingerprintSchemaSemantics, SCHEMA_SEMANTIC_ALGORITHM } from '../schema-semantic-fingerprint';
import type { BaselineApiRouteContract } from '../typed-route-baseline-projection';
import {
  computePublicContractHash,
  PUBLIC_CONTRACT_COMPARATOR_TYPE,
  stableNormalize,
  stableStringify,
  type MountedBehaviorCoverageEntry,
  type MountedBehaviorProbeSnapshot,
  type MountedRouteSnapshot,
  type PublicContractSnapshot,
  type SchemaSemanticSnapshot,
} from './public-contract-policy';

export const DETERMINISTIC_PUBLIC_CONTRACT_CAPTURED_AT = '1970-01-01T00:00:00.000Z';
const SCHEMA_INDEX_RELATIVE_PATH = 'packages/api-contract/src/schemas/index.ts';

export interface ParsedRouteRegistration {
  method: string;
  path: string;
  kind: string;
  excludeFromLambda: boolean;
}

export interface TypedMountedRoute {
  routeId: string;
  method: string;
  path: string;
  kind: string;
  lifecycle: string;
}

export interface SchemaSourceModule {
  source: string;
  sourceFile: ESTree.Program;
}

export interface PublicContractPayload {
  routeContracts: BaselineApiRouteContract[];
  mountedRoutes: MountedRouteSnapshot[];
  mountedBehavior: MountedBehaviorProbeSnapshot[];
  mountedBehaviorCoverage: MountedBehaviorCoverageEntry[];
  schemaExports: string[];
  schemaFingerprints: Record<string, string>;
  schemaAuthorityFingerprints: Record<string, string>;
  schemaSemantics: SchemaSemanticSnapshot;
}

export interface PublicContractSnapshotInput extends PublicContractPayload {
  sourceRef?: string;
  sourceSha: string;
  dirtyStatus: PublicContractSnapshot['dirtyStatus'];
  capturedAt?: string;
}

export function normalizeRouteContracts(
  routeContracts: readonly BaselineApiRouteContract[],
): BaselineApiRouteContract[] {
  return routeContracts
    .map((route) => stableNormalize(route) as BaselineApiRouteContract)
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
}

export function parseTypedMountedRouteKeys(honoSource: string): string[] {
  const sourceFile = parseSource('apps/api/src/server/api/routes/hono.ts', honoSource);
  const routeKeys: string[] = [];

  function visit(node: ESTree.Node): void {
    if (isNode(node, 'CallExpression') && isNode(node.callee, 'Identifier')) {
      const routeArgumentIndex =
        staticText(node.callee) === 'mountRoute'
          ? 3
          : staticText(node.callee) === 'mountArtifactRoute' ||
              staticText(node.callee) === 'defineRouteHandler' ||
              staticText(node.callee) === 'defineRawRouteHandler'
            ? 0
            : undefined;
      const routeArgument = routeArgumentIndex === undefined ? undefined : node.arguments[routeArgumentIndex];
      if (
        routeArgument &&
        isStaticMember(routeArgument) &&
        isNode(routeArgument.object, 'Identifier') &&
        staticText(routeArgument.object) === 'API_ROUTES'
      ) {
        routeKeys.push(staticText(routeArgument.property));
      }
    }
    forEachChild(node, visit);
  }
  visit(sourceFile);

  const uniqueRouteKeys = new Set(routeKeys);
  if (uniqueRouteKeys.size !== routeKeys.length) {
    const duplicates = [...uniqueRouteKeys].filter(
      (key) => routeKeys.filter((candidate) => candidate === key).length > 1,
    );
    throw new Error(`Duplicate typed Hono route mount: ${duplicates.join(', ')}`);
  }
  return [...uniqueRouteKeys].sort();
}

export function projectTypedRouteRegistrations(mountedRoutes: readonly TypedMountedRoute[]): ParsedRouteRegistration[] {
  return mountedRoutes
    .map((route) => ({
      method: route.method,
      path: route.path,
      kind: route.kind,
      excludeFromLambda: route.lifecycle !== 'active',
    }))
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
}

export function buildMountedRoutes(
  contracts: readonly BaselineApiRouteContract[],
  registrations: readonly ParsedRouteRegistration[],
): MountedRouteSnapshot[] {
  const byMethodAndPath = new Map(contracts.map((route) => [`${route.method} ${route.path}`, route]));
  const registeredKeys = registrations.map((registration) => `${registration.method} ${registration.path}`);
  const uniqueRegisteredKeys = new Set(registeredKeys);
  if (uniqueRegisteredKeys.size !== registeredKeys.length) {
    throw new Error('Duplicate route registration in apps/api route definitions');
  }
  const expectedRegisteredKeys = contracts.map((contract) => `${contract.method} ${contract.path}`).sort();
  const actualRegisteredKeys = [...uniqueRegisteredKeys].sort();
  if (stableStringify(actualRegisteredKeys) !== stableStringify(expectedRegisteredKeys)) {
    const missing = expectedRegisteredKeys.filter((key) => !uniqueRegisteredKeys.has(key));
    const extra = actualRegisteredKeys.filter((key) => !expectedRegisteredKeys.includes(key));
    throw new Error(
      `Route registration inventory does not match active contracts (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }

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
          return true;
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

export function exportedSchemaDeclarations(module: SchemaSourceModule): Array<{
  name: string;
  source: string;
}> {
  const declarations: Array<{
    name: string;
    source: string;
  }> = [];
  for (const statement of topLevelDeclarations(module.sourceFile)) {
    if (!isNode(statement, 'VariableDeclaration') || !isExported(statement)) {
      continue;
    }
    for (const declaration of statement.declarations) {
      if (!isNode(declaration.id, 'Identifier') || !/^[A-Z][A-Za-z0-9_]*Schema$/u.test(staticText(declaration.id))) {
        continue;
      }
      declarations.push({
        name: staticText(declaration.id),
        source: nodeText(declaration).replace(/\s+/gu, ' ').trim(),
      });
    }
  }
  return declarations;
}

export function collectSchemaExportNames(modules: Iterable<SchemaSourceModule>): string[] {
  return [
    ...new Set([...modules].flatMap((module) => exportedSchemaDeclarations(module).map(({ name }) => name))),
  ].sort();
}

export function buildSchemaDeclarationFingerprints(modules: Iterable<SchemaSourceModule>): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const module of modules) {
    for (const declaration of exportedSchemaDeclarations(module)) {
      if (Object.hasOwn(fingerprints, declaration.name)) {
        throw new Error(`Duplicate exported API schema declaration: ${declaration.name}`);
      }
      fingerprints[declaration.name] = createHash('sha256').update(declaration.source).digest('hex');
    }
  }
  return Object.fromEntries(Object.entries(fingerprints).sort(([left], [right]) => left.localeCompare(right)));
}

export function buildSchemaSemanticSnapshot(schemaModule: Record<string, unknown>): SchemaSemanticSnapshot {
  const fingerprints = Object.fromEntries(
    Object.entries(schemaModule)
      .filter(([name]) => /^[A-Z][A-Za-z0-9_]*Schema$/u.test(name))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, schema]) => [name, fingerprintSchemaSemantics(schema as AnySchema).fingerprint]),
  );
  return {
    algorithm: SCHEMA_SEMANTIC_ALGORITHM,
    fingerprints,
  };
}

export function resolveSchemaEntryPath(repoRoot: string): string {
  return path.join(repoRoot, SCHEMA_INDEX_RELATIVE_PATH);
}

export function buildPublicContractSnapshot(input: PublicContractSnapshotInput): PublicContractSnapshot {
  const snapshot: PublicContractSnapshot = {
    comparatorType: PUBLIC_CONTRACT_COMPARATOR_TYPE,
    sourceRef: input.sourceRef ?? 'HEAD',
    sourceSha: input.sourceSha,
    dirtyStatus: input.dirtyStatus,
    capturedAt: input.capturedAt ?? DETERMINISTIC_PUBLIC_CONTRACT_CAPTURED_AT,
    contractHash: '',
    routeContracts: input.routeContracts,
    mountedRoutes: input.mountedRoutes,
    mountedBehavior: input.mountedBehavior,
    mountedBehaviorCoverage: input.mountedBehaviorCoverage,
    schemaExports: input.schemaExports,
    schemaFingerprints: input.schemaFingerprints,
    schemaAuthorityFingerprints: input.schemaAuthorityFingerprints,
    schemaSemantics: input.schemaSemantics,
  };
  return {
    ...snapshot,
    contractHash: computePublicContractHash(snapshot),
  };
}

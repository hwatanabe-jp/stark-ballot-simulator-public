import { createHash } from 'node:crypto';
import type { BaselineApiRouteContract } from '../typed-route-baseline-projection';
import { SCHEMA_SEMANTIC_ALGORITHM } from '../schema-semantic-fingerprint';

export const PUBLIC_CONTRACT_COMPARATOR_TYPE = 'public-contract-baseline' as const;
const CLASSIFICATION_TYPE = 'public-contract-drift-classification' as const;

export type RouteMode = 'full' | 'lambda' | 'readonly';

export interface MountedRouteSnapshot {
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

export type MountedBehaviorMode = 'full' | 'lambda' | 'readonly';

export interface MountedBehaviorProbe {
  probeId: string;
  mode: MountedBehaviorMode;
  method: string;
  url: string;
  headers?: Record<string, string>;
  expectCanonicalJson?: boolean;
}

export interface MountedBehaviorProbeSnapshot {
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
    jsonRequestId?: string;
  };
}

export interface MountedBehaviorCoverageEntry {
  caseId: string;
  status: 'probed' | 'exempt';
  probeIds?: string[];
  exemption?: string;
}

export interface SchemaSemanticSnapshot {
  algorithm: typeof SCHEMA_SEMANTIC_ALGORITHM;
  fingerprints: Record<string, string>;
}

export interface PublicContractSnapshot {
  comparatorType: typeof PUBLIC_CONTRACT_COMPARATOR_TYPE;
  sourceRef: string;
  sourceSha: string;
  dirtyStatus: 'clean' | 'dirty' | 'source-ref' | 'source-archive';
  capturedAt: string;
  contractHash: string;
  routeContracts: BaselineApiRouteContract[];
  mountedRoutes: MountedRouteSnapshot[];
  mountedBehavior: MountedBehaviorProbeSnapshot[];
  mountedBehaviorCoverage: MountedBehaviorCoverageEntry[];
  schemaExports: string[];
  schemaFingerprints: Record<string, string>;
  schemaAuthorityFingerprints: Record<string, string>;
  schemaSemantics: SchemaSemanticSnapshot;
}

export interface PublicContractDrift {
  path: string;
  before: unknown;
  after: unknown;
}

export interface DriftClassification {
  comparatorType: typeof CLASSIFICATION_TYPE;
  baselineContractHash: string;
  baselineSourceSha: string;
  allowedDriftPaths: string[];
}

type ComparableMountedRouteSnapshot = Omit<MountedRouteSnapshot, 'routeIds' | 'routes'> & {
  routeIds: Record<string, true>;
  routes: Record<string, MountedRouteSnapshot['routes'][number]>;
};

interface ComparablePublicContractSnapshot {
  routeContracts: Record<string, BaselineApiRouteContract>;
  mountedRoutes: Record<RouteMode, ComparableMountedRouteSnapshot | undefined>;
  mountedBehavior: Record<string, MountedBehaviorProbeSnapshot>;
  mountedBehaviorCoverage: Record<string, MountedBehaviorCoverageEntry>;
  schemaExports: Record<string, true>;
  schemaFingerprints: Record<string, string>;
  schemaAuthorityFingerprints: Record<string, string>;
  schemaSemantics: SchemaSemanticSnapshot;
}

interface ComparableSchemaEvidence {
  schemaFingerprints: Record<string, string>;
  schemaAuthorityFingerprints: Record<string, string>;
  schemaSemantics: SchemaSemanticSnapshot;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(stableNormalize(value), null, 2)}\n`;
}

export function computePublicContractHash(snapshot: PublicContractSnapshot): string {
  return hashStable(contractPayloadFromSnapshot(snapshot));
}

export function comparePublicContractSnapshots(
  baseline: PublicContractSnapshot,
  current: PublicContractSnapshot,
  classification?: DriftClassification,
): PublicContractDrift[] {
  assertValidPublicContractSnapshot(baseline, 'Baseline public-contract snapshot');
  assertValidPublicContractSnapshot(current, 'Current public-contract snapshot');
  const comparableBaseline = toComparableSnapshot(baseline, schemaEvidenceFromSnapshot(baseline));
  const comparableCurrent = toComparableSnapshot(current, schemaEvidenceFromSnapshot(current));
  const observedDrift = collectDrift(comparableBaseline, comparableCurrent);
  if (!classification) {
    return observedDrift;
  }
  if ((classification as { comparatorType: unknown }).comparatorType !== CLASSIFICATION_TYPE) {
    throw new Error(`Unsupported public-contract drift classification type: ${String(classification.comparatorType)}`);
  }
  if (
    classification.baselineContractHash !== baseline.contractHash ||
    classification.baselineSourceSha !== baseline.sourceSha
  ) {
    throw new Error('Public-contract drift classification is not bound to the reviewed baseline');
  }
  const allowed = new Set(classification.allowedDriftPaths);
  if (allowed.size !== classification.allowedDriftPaths.length) {
    throw new Error('Public-contract drift classification contains duplicate paths');
  }
  const observedPaths = new Set(observedDrift.map((drift) => drift.path));
  const unusedPaths = [...allowed].filter((allowedPath) => !observedPaths.has(allowedPath));
  if (unusedPaths.length > 0) {
    throw new Error(`Public-contract drift classification contains unused paths: ${unusedPaths.join(', ')}`);
  }

  return observedDrift.filter((drift) => !allowed.has(drift.path));
}

export function stableNormalize(value: unknown): unknown {
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

function assertSha256Map(values: Record<string, string>, label: string): void {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-f0-9]{64}$/u.test(value)) {
      throw new Error(`${label}.${key} is not a SHA-256 fingerprint`);
    }
  }
}

function contractPayloadFromSnapshot(
  snapshot: PublicContractSnapshot,
): Omit<
  PublicContractSnapshot,
  'comparatorType' | 'sourceRef' | 'sourceSha' | 'dirtyStatus' | 'capturedAt' | 'contractHash'
> {
  return {
    routeContracts: snapshot.routeContracts,
    mountedRoutes: snapshot.mountedRoutes,
    mountedBehavior: snapshot.mountedBehavior,
    mountedBehaviorCoverage: snapshot.mountedBehaviorCoverage,
    schemaExports: snapshot.schemaExports,
    schemaFingerprints: snapshot.schemaFingerprints,
    schemaAuthorityFingerprints: snapshot.schemaAuthorityFingerprints,
    schemaSemantics: snapshot.schemaSemantics,
  };
}

function assertValidPublicContractSnapshot(snapshot: PublicContractSnapshot, label: string): void {
  if ((snapshot as { comparatorType: unknown }).comparatorType !== PUBLIC_CONTRACT_COMPARATOR_TYPE) {
    throw new Error(`${label} has unsupported comparatorType: ${String(snapshot.comparatorType)}`);
  }
  const computedHash = computePublicContractHash(snapshot);
  if (snapshot.contractHash !== computedHash) {
    throw new Error(`${label} contractHash does not match its contract payload`);
  }
  assertSha256Map(snapshot.schemaFingerprints, `${label}.schemaFingerprints`);
  assertSha256Map(snapshot.schemaAuthorityFingerprints, `${label}.schemaAuthorityFingerprints`);
  if (Object.keys(snapshot.schemaAuthorityFingerprints).length === 0) {
    throw new Error(`${label} has no schema authority provenance`);
  }
  const schemaSemantics = (snapshot as { schemaSemantics?: SchemaSemanticSnapshot }).schemaSemantics;
  if (!schemaSemantics) {
    throw new Error(`${label} has no schema semantic evidence`);
  }
  const semanticAlgorithm = (schemaSemantics as { algorithm: unknown }).algorithm;
  if (semanticAlgorithm !== SCHEMA_SEMANTIC_ALGORITHM) {
    throw new Error(`${label} has unsupported schema semantic algorithm: ${String(semanticAlgorithm)}`);
  }
  assertSha256Map(schemaSemantics.fingerprints, `${label}.schemaSemantics.fingerprints`);
  const exportedNames = Object.keys(keySet(snapshot.schemaExports)).sort();
  const declarationNames = Object.keys(snapshot.schemaFingerprints).sort();
  const semanticNames = Object.keys(schemaSemantics.fingerprints).sort();
  if (stableStringify(declarationNames) !== stableStringify(exportedNames)) {
    throw new Error(`${label} schema declaration provenance does not cover every exported schema`);
  }
  if (stableStringify(semanticNames) !== stableStringify(exportedNames)) {
    throw new Error(`${label} schema semantics do not cover every exported schema`);
  }
}

function toComparableSnapshot(
  snapshot: PublicContractSnapshot,
  schemaEvidence: ComparableSchemaEvidence,
): ComparablePublicContractSnapshot {
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
    ...schemaEvidence,
  };
}

function schemaEvidenceFromSnapshot(snapshot: PublicContractSnapshot): ComparableSchemaEvidence {
  return {
    schemaFingerprints: snapshot.schemaFingerprints,
    schemaAuthorityFingerprints: snapshot.schemaAuthorityFingerprints,
    schemaSemantics: snapshot.schemaSemantics,
  };
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

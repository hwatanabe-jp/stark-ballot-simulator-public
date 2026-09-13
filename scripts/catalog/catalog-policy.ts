import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  apiEntityV1alpha1Validator,
  componentEntityV1alpha1Validator,
  entitySchemaValidator,
  systemEntityV1alpha1Validator,
  userEntityV1alpha1Validator,
  type Entity,
  type KindValidator,
} from '@backstage/catalog-model';
import { parse, parseAllDocuments } from 'yaml';

const CATALOG_PATH = 'catalog-info.yaml';
const API_DEFINITION_PATH = 'openapi/stark-ballot-api.openapi.json';
const TECHDOCS_CONFIG_PATH = 'techdocs/mkdocs.yml';
const TECHDOCS_SOURCE_PATH = 'techdocs/docs';
const EXPECTED_ENTITY_REFS = [
  'api:default/stark-ballot-api',
  'component:default/api',
  'component:default/prover',
  'component:default/release-ledger',
  'component:default/verifier-service',
  'component:default/web',
  'component:default/zkvm-guest',
  'system:default/stark-ballot-simulator',
  'user:default/hwatanabe-jp',
] as const;
function expectedCatalogGraph(repositoryAnnotation: string) {
  return {
    'api:default/stark-ballot-api': {
      annotations: { 'github.com/project-slug': repositoryAnnotation },
      spec: {
        type: 'openapi',
        lifecycle: 'experimental',
        owner: 'user:default/hwatanabe-jp',
        system: 'system:default/stark-ballot-simulator',
      },
    },
    'component:default/api': {
      annotations: { 'github.com/project-slug': repositoryAnnotation },
      spec: {
        type: 'service',
        lifecycle: 'experimental',
        owner: 'user:default/hwatanabe-jp',
        system: 'system:default/stark-ballot-simulator',
        dependsOn: [
          'component:default/prover',
          'component:default/release-ledger',
          'component:default/verifier-service',
        ],
        providesApis: ['api:default/stark-ballot-api'],
      },
    },
    'component:default/prover': {
      annotations: { 'github.com/project-slug': repositoryAnnotation },
      spec: {
        type: 'service',
        lifecycle: 'experimental',
        owner: 'user:default/hwatanabe-jp',
        system: 'system:default/stark-ballot-simulator',
        dependsOn: ['component:default/release-ledger', 'component:default/zkvm-guest'],
      },
    },
    'component:default/release-ledger': {
      annotations: { 'github.com/project-slug': repositoryAnnotation },
      spec: {
        type: 'library',
        lifecycle: 'experimental',
        owner: 'user:default/hwatanabe-jp',
        system: 'system:default/stark-ballot-simulator',
      },
    },
    'component:default/verifier-service': {
      annotations: { 'github.com/project-slug': repositoryAnnotation },
      spec: {
        type: 'service',
        lifecycle: 'experimental',
        owner: 'user:default/hwatanabe-jp',
        system: 'system:default/stark-ballot-simulator',
      },
    },
    'component:default/web': {
      annotations: { 'github.com/project-slug': repositoryAnnotation },
      spec: {
        type: 'website',
        lifecycle: 'experimental',
        owner: 'user:default/hwatanabe-jp',
        system: 'system:default/stark-ballot-simulator',
        consumesApis: ['api:default/stark-ballot-api'],
      },
    },
    'component:default/zkvm-guest': {
      annotations: { 'github.com/project-slug': repositoryAnnotation },
      spec: {
        type: 'library',
        lifecycle: 'experimental',
        owner: 'user:default/hwatanabe-jp',
        system: 'system:default/stark-ballot-simulator',
      },
    },
    'system:default/stark-ballot-simulator': {
      annotations: {
        'backstage.io/techdocs-ref': 'dir:./techdocs',
        'github.com/project-slug': repositoryAnnotation,
      },
      spec: { owner: 'user:default/hwatanabe-jp', type: 'product' },
    },
    'user:default/hwatanabe-jp': {
      annotations: { 'github.com/user-login': 'hwatanabe-jp' },
      spec: { memberOf: [] },
    },
  } as const;
}
const FORBIDDEN_PORTAL_COORDINATES = [
  { label: 'AWS ARN', pattern: /\barn:(?:aws|aws-cn|aws-us-gov):/iu },
  { label: 'AWS account ID', pattern: /\b(?!000000000000\b)\d{12}\b/u },
  { label: 'deployment target', pattern: /\bstark-(?:dev|prod)(?:\/|\b)/iu },
  { label: 'AWS resource URL', pattern: /(?:amazonaws\.com|s3:\/\/|\.dkr\.ecr\.)/iu },
  { label: 'private hostname', pattern: /(?:\blocalhost\b|\b[a-z0-9.-]+\.(?:internal|local)\b)/iu },
  { label: 'approval coordinate', pattern: /\b(?:pipeline[_ -]?execution[_ -]?id|approval[_ -]?token)\b/iu },
] as const;

export interface CatalogCheckResult {
  readonly apiDefinitionPath: typeof API_DEFINITION_PATH;
  readonly catalogGraph: Readonly<Record<string, unknown>>;
  readonly entityRefs: readonly string[];
  readonly techDocsPages: readonly string[];
}

export function assertGuestSafePortalText(text: string, label: string): void {
  for (const coordinate of FORBIDDEN_PORTAL_COORDINATES) {
    if (coordinate.pattern.test(text)) {
      throw new Error(`${label} contains a prohibited ${coordinate.label}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function entityRef(entity: Entity): string {
  return `${entity.kind.toLowerCase()}:${entity.metadata.namespace ?? 'default'}/${entity.metadata.name}`;
}

function requireFullEntityRef(value: unknown, label: string): string {
  const reference = requireString(value, label).toLowerCase();
  if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(reference)) {
    throw new Error(`${label} must be a full entity reference`);
  }
  return reference;
}

function collectPlaceholderKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholderKeys(item, keys);
    return keys;
  }
  if (!isRecord(value)) return keys;
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$')) keys.push(key);
    collectPlaceholderKeys(item, keys);
  }
  return keys;
}

async function assertRegularFileInside(root: string, target: string, label: string): Promise<string> {
  const resolvedRoot = await realpath(root);
  const resolvedTarget = path.resolve(root, target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its allowed root`);
  }
  const segments = relative.split(path.sep);
  let cursor = resolvedRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink()) throw new Error(`${label} may not traverse a symbolic link`);
  }
  const stats = await lstat(resolvedTarget);
  if (!stats.isFile()) throw new Error(`${label} must resolve to a regular file`);
  return resolvedTarget;
}

async function parseCatalog(repoRoot: string): Promise<{ entities: Entity[]; materialized: Entity[] }> {
  const catalogText = await readFile(path.join(repoRoot, CATALOG_PATH), 'utf8');
  assertGuestSafePortalText(catalogText, 'Catalog');
  const documents = parseAllDocuments(catalogText);
  const entities: Entity[] = [];
  for (const [index, document] of documents.entries()) {
    const [parseError] = document.errors;
    if (parseError !== undefined) throw new Error(`catalog document ${index}: ${parseError.message}`);
    const value: unknown = document.toJSON();
    entities.push(entitySchemaValidator()(value));
    if (!isRecord(value)) throw new Error(`catalog document ${index} must be an entity object`);
  }
  const placeholderKeys = collectPlaceholderKeys(entities);
  if (placeholderKeys.length !== 1 || placeholderKeys[0] !== '$text') {
    throw new Error('Catalog must contain only the one reviewed API $text substitution');
  }

  const materialized = structuredClone(entities);
  const api = materialized.find((entity) => entityRef(entity) === 'api:default/stark-ballot-api');
  if (api === undefined) throw new Error('Catalog API entity is missing');
  const definition = requireRecord(requireRecord(api.spec, 'API spec')['definition'], 'API definition');
  if (definition['$text'] !== `./${API_DEFINITION_PATH}` || Object.keys(definition).length !== 1) {
    throw new Error(`Catalog API definition must reference ./${API_DEFINITION_PATH}`);
  }
  const definitionPath = await assertRegularFileInside(repoRoot, API_DEFINITION_PATH, 'Catalog API definition');
  const definitionText = await readFile(definitionPath, 'utf8');
  assertGuestSafePortalText(definitionText, 'OpenAPI definition');
  requireRecord(api.spec, 'API spec')['definition'] = definitionText;
  return { entities, materialized };
}

function validatorForKind(kind: string): KindValidator {
  switch (kind) {
    case 'User':
      return userEntityV1alpha1Validator;
    case 'System':
      return systemEntityV1alpha1Validator;
    case 'Component':
      return componentEntityV1alpha1Validator;
    case 'API':
      return apiEntityV1alpha1Validator;
    default:
      throw new Error(`Unexpected catalog kind: ${kind}`);
  }
}

async function validateEntities(entities: readonly Entity[]): Promise<void> {
  for (const entity of entities) {
    if (!(await validatorForKind(entity.kind).check(entity))) {
      throw new Error(`Catalog validator did not handle ${entityRef(entity)}`);
    }
  }
}

function collectRelationshipRefs(entity: Entity): string[] {
  const spec = requireRecord(entity.spec, `${entityRef(entity)} spec`);
  const relationships: string[] = [];
  for (const singular of ['owner', 'system'] as const) {
    if (spec[singular] !== undefined) {
      relationships.push(requireFullEntityRef(spec[singular], `${entityRef(entity)} spec.${singular}`));
    }
  }
  for (const plural of ['dependsOn', 'providesApis', 'consumesApis', 'memberOf'] as const) {
    const values = spec[plural];
    if (values === undefined) continue;
    if (!Array.isArray(values)) throw new Error(`${entityRef(entity)} spec.${plural} must be an array`);
    relationships.push(
      ...values.map((value, index) => requireFullEntityRef(value, `${entityRef(entity)} spec.${plural}[${index}]`)),
    );
  }
  return relationships;
}

function catalogGraphProjection(entity: Entity): {
  annotations: Record<string, unknown>;
  spec: Record<string, unknown>;
} {
  const reference = entityRef(entity);
  const metadata = requireRecord(entity.metadata, `${reference} metadata`);
  const spec = requireRecord(entity.spec, `${reference} spec`);
  const projectedSpec: Record<string, unknown> = {};
  for (const key of ['type', 'lifecycle', 'owner', 'system', 'dependsOn', 'providesApis', 'consumesApis', 'memberOf']) {
    if (spec[key] !== undefined) projectedSpec[key] = spec[key];
  }
  return {
    annotations: requireRecord(metadata['annotations'], `${reference} metadata.annotations`),
    spec: projectedSpec,
  };
}

function validateCatalogGraph(
  entities: readonly Entity[],
  repositoryAnnotation: string,
): {
  refs: readonly string[];
  graph: Readonly<Record<string, unknown>>;
} {
  const refs = entities.map(entityRef).sort();
  if (new Set(refs).size !== refs.length) throw new Error('Catalog contains duplicate entity references');
  if (JSON.stringify(refs) !== JSON.stringify(EXPECTED_ENTITY_REFS)) {
    throw new Error(`Catalog entity set differs from the reviewed set: ${refs.join(', ')}`);
  }
  const refSet = new Set(refs);
  const graph: Record<string, unknown> = {};
  for (const entity of entities) {
    const metadata = requireRecord(entity.metadata, `${entityRef(entity)} metadata`);
    const tags = metadata['tags'];
    if (!Array.isArray(tags) || JSON.stringify(tags) !== JSON.stringify(['guest-visible'])) {
      throw new Error(`${entityRef(entity)} must be explicitly guest-visible`);
    }
    if ('relations' in entity || 'status' in entity) {
      throw new Error(`${entityRef(entity)} may not declare processor-owned relations or status`);
    }
    graph[entityRef(entity)] = catalogGraphProjection(entity);
    for (const relationship of collectRelationshipRefs(entity)) {
      if (!refSet.has(relationship)) throw new Error(`${entityRef(entity)} references missing entity ${relationship}`);
    }
  }
  const sortedGraph = Object.fromEntries(Object.entries(graph).sort(([left], [right]) => left.localeCompare(right)));
  if (!isDeepStrictEqual(sortedGraph, expectedCatalogGraph(repositoryAnnotation))) {
    throw new Error('Catalog ownership, lifecycle, annotation, or relationship graph differs from the reviewed graph');
  }
  return { refs, graph: sortedGraph };
}

async function repositoryAnnotationForRoot(repoRoot: string): Promise<string> {
  try {
    const marker = await readFile(path.join(repoRoot, '.public-repository'), 'utf8');
    if (!marker.split(/\r?\n/u).includes('PUBLIC_REPOSITORY_SNAPSHOT=1')) {
      throw new Error('Public repository marker is malformed');
    }
    return 'hwatanabe-jp/stark-ballot-simulator-public';
  } catch (error: unknown) {
    if (isRecord(error) && error['code'] === 'ENOENT') return 'hwatanabe-jp/stark-ballot-simulator';
    if (error instanceof Error) throw error;
    throw new Error('Unable to inspect the public repository marker');
  }
}

async function walkRegularMarkdownFiles(root: string, directory = root): Promise<string[]> {
  const pages: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('TechDocs source may not contain symbolic links');
    if (entry.isDirectory()) {
      pages.push(...(await walkRegularMarkdownFiles(root, entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      pages.push(path.relative(root, entryPath).split(path.sep).join('/'));
    } else {
      throw new Error(`TechDocs source contains unsupported entry ${path.relative(root, entryPath)}`);
    }
  }
  return pages.sort();
}

function collectNavTargets(value: unknown, targets: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectNavTargets(item, targets);
    return targets;
  }
  if (!isRecord(value)) throw new Error('TechDocs nav must contain labeled entries');
  for (const target of Object.values(value)) {
    if (typeof target === 'string') targets.push(target);
    else collectNavTargets(target, targets);
  }
  return targets;
}

async function validateTechDocs(repoRoot: string): Promise<readonly string[]> {
  const configText = await readFile(path.join(repoRoot, TECHDOCS_CONFIG_PATH), 'utf8');
  const config: unknown = parse(configText);
  const record = requireRecord(config, 'TechDocs configuration');
  const configKeys = Object.keys(record).sort();
  const expectedConfigKeys = ['docs_dir', 'nav', 'plugins', 'site_description', 'site_name', 'strict', 'theme'];
  if (JSON.stringify(configKeys) !== JSON.stringify(expectedConfigKeys)) {
    throw new Error('TechDocs configuration contains a path or behavior outside the reviewed isolated key set');
  }
  if (record['docs_dir'] !== 'docs' || record['strict'] !== true || record['INHERIT'] !== undefined) {
    throw new Error('TechDocs must use its isolated docs directory in strict mode without INHERIT');
  }
  if (JSON.stringify(record['plugins']) !== JSON.stringify(['techdocs-core'])) {
    throw new Error('TechDocs must use only the techdocs-core plugin');
  }
  if (!isDeepStrictEqual(record['theme'], { name: 'material', font: false })) {
    throw new Error('TechDocs must use the reviewed Material theme without external fonts');
  }
  const sourceRoot = path.join(repoRoot, TECHDOCS_SOURCE_PATH);
  const pages = await walkRegularMarkdownFiles(sourceRoot);
  const navTargets = collectNavTargets(record['nav']).sort();
  if (JSON.stringify(navTargets) !== JSON.stringify(pages)) {
    throw new Error('Every TechDocs Markdown page must appear exactly once in navigation');
  }
  for (const page of pages) {
    const pagePath = await assertRegularFileInside(sourceRoot, page, `TechDocs page ${page}`);
    const content = await readFile(pagePath, 'utf8');
    assertGuestSafePortalText(content, `TechDocs page ${page}`);
    if (/docs\/(?:internal|runbooks)\//u.test(content) || /\.\.\//u.test(content) || /\bfile:/iu.test(content)) {
      throw new Error(`TechDocs page ${page} crosses the guest-safe source boundary`);
    }
  }
  return pages;
}

export async function checkCatalogInputs(repoRoot: string): Promise<CatalogCheckResult> {
  const { entities, materialized } = await parseCatalog(repoRoot);
  await validateEntities(materialized);
  const repositoryAnnotation = await repositoryAnnotationForRoot(repoRoot);
  const { refs: entityRefs, graph: catalogGraph } = validateCatalogGraph(entities, repositoryAnnotation);
  const techDocsPages = await validateTechDocs(repoRoot);
  return { apiDefinitionPath: API_DEFINITION_PATH, catalogGraph, entityRefs, techDocsPages };
}

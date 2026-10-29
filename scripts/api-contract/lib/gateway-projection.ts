import { TARGET_API_ROUTE_CONTRACTS, type ApiRouteContract } from '@stark-ballot/api-contract/routes';
import { hex32Schema } from '@stark-ballot/api-contract/schemas';
import { getSchemaDescriptor, type AnySchema, type SchemaDescriptor } from '@stark-ballot/validation/schema';
import { getOpenApiEffectMetadata } from '@stark-ballot/validation/schema-openapi';

type Model = Record<string, unknown>;
const BODY_MODELS: Readonly<Record<string, string>> = {
  'vote.post': 'VoteRequest',
  'sessions.finalizations.post': 'FinalizationCreateRequest',
  'sessions.finalizations.cancel.post': 'FinalizationCancelRequest',
  'sessions.finalizations.verification.post': 'VerificationRunRequest',
  'sessions.finalizations.verification.observations.post': 'VerificationObservationRequest',
};

function projectGatewayObject(
  descriptor: Extract<SchemaDescriptor, { kind: 'ObjectSchema' }>,
  path: string,
  runtime: string[],
): Model {
  if (descriptor.unknownKeys !== 'strict' || getSchemaDescriptor(descriptor.catchall).kind !== 'NeverSchema') {
    throw new Error(`${path}: only strict request objects are admitted`);
  }
  const properties: Record<string, Model> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(descriptor.shape).sort(([a], [b]) => a.localeCompare(b))) {
    properties[key] = projectGatewaySchema(value, `${path}.${key}`, runtime);
    if (getSchemaDescriptor(value).kind !== 'OptionalSchema') required.push(key);
  }
  return { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}

function projectGatewayString(
  descriptor: Extract<SchemaDescriptor, { kind: 'StringSchema' }>,
  path: string,
  runtime: string[],
): Model {
  const result: Model = { type: 'string' };
  for (const constraint of descriptor.constraints) {
    if (constraint.kind === 'minLength' || constraint.kind === 'maxLength') {
      runtime.push(`${path}: ${constraint.kind} ${constraint.value} UTF-16 code units (Hono only)`);
    } else if (constraint.kind === 'pattern' && constraint.flags === '' && result['pattern'] === undefined) {
      result['pattern'] = constraint.source;
    } else {
      throw new Error(`${path}: unsupported string constraint ${constraint.kind}`);
    }
  }
  return result;
}

function projectGatewayRefinement(
  schema: AnySchema,
  descriptor: Extract<SchemaDescriptor, { kind: 'EffectsSchema' }>,
  path: string,
  runtime: string[],
): Model {
  // Only this exact shared refinement has a reviewed equivalent Gateway pattern.
  if (schema !== hex32Schema) throw new Error(`${path}: unreviewed ${descriptor.effect}`);
  const metadata = getOpenApiEffectMetadata(schema);
  if (metadata?.kind !== 'refinement' || typeof metadata.overlay['pattern'] !== 'string') {
    throw new Error(`${path}: missing declared hex32 pattern`);
  }
  return { ...projectGatewaySchema(descriptor.inner, path, runtime), pattern: metadata.overlay['pattern'] };
}

/** Deliberately bounded draft-4 projection. New schema kinds require review. */
export function projectGatewaySchema(schema: AnySchema, path: string, runtime: string[]): Model {
  const descriptor = getSchemaDescriptor(schema);
  switch (descriptor.kind) {
    case 'ObjectSchema':
      return projectGatewayObject(descriptor, path, runtime);
    case 'OptionalSchema':
      return projectGatewaySchema(descriptor.inner, path, runtime);
    case 'StringSchema':
      return projectGatewayString(descriptor, path, runtime);
    case 'EnumSchema':
      return { type: 'string', enum: [...descriptor.values] };
    case 'EffectsSchema':
      return projectGatewayRefinement(schema, descriptor, path, runtime);
    case 'ArraySchema':
    case 'BooleanSchema':
    case 'CustomSchema':
    case 'LiteralSchema':
    case 'NeverSchema':
    case 'NullableSchema':
    case 'NumberSchema':
    case 'TupleSchema':
    case 'UndefinedSchema':
    case 'UnionSchema':
    case 'UnknownSchema':
      throw new Error(`${path}: unsupported Gateway schema ${descriptor.kind}`);
  }
}

type GatewayResources = Record<string, { parent: string; part: string; depth: number }>;
type GatewayMethods = Record<string, { method: string; path: string; model: string | null }>;

function addGatewayResource(resources: GatewayResources, path: string): void {
  const parts = path.split('/').filter(Boolean);
  parts.forEach((part, index) => {
    const resourcePath = `/${parts.slice(0, index + 1).join('/')}`;
    resources[resourcePath] = {
      parent: index === 0 ? '/' : `/${parts.slice(0, index).join('/')}`,
      part,
      depth: index + 1,
    };
  });
}

function registerGatewayBodyModel(
  route: ApiRouteContract,
  models: Record<string, Model>,
  honoConstraints: string[],
): string | null {
  const model = BODY_MODELS[route.routeId] ?? null;
  if (route.request.body !== undefined && model === null && route.routeId !== 'session.post') {
    throw new Error(`${route.routeId}: body validation policy must be reviewed`);
  }
  if (model !== null) {
    if (!route.request.body || models[model] || !/^[A-Za-z][A-Za-z0-9]*$/.test(model))
      throw new Error(`Invalid or duplicate model ${model}`);
    models[model] = {
      $schema: 'http://json-schema.org/draft-04/schema#',
      ...projectGatewaySchema(route.request.body, model, honoConstraints),
    };
  }
  return model;
}

function addGatewayStaticSiblings(
  route: GatewayMethods[string],
  path: string,
  resource: GatewayResources[string],
  resources: GatewayResources,
  methods: GatewayMethods,
): void {
  for (const [sibling, candidate] of Object.entries(resources)) {
    if (candidate.parent !== resource.parent || candidate.part.startsWith('{')) continue;
    const shadow = route.path.replace(`${path}/`, `${sibling}/`);
    addGatewayResource(resources, shadow);
    methods[`${route.method} ${shadow}`] ??= { ...route, path: shadow };
  }
}

function addGatewayShadowRoutes(resources: GatewayResources, methods: GatewayMethods): void {
  // REST stops at a matching static sibling. Materialize the parameter route
  // under that sibling too, so e.g. finalizationId=current cannot bypass a POST
  // validator by falling into ANY (or lose a valid dynamic child altogether).
  for (const route of Object.values(methods)) {
    for (const [path, resource] of Object.entries(resources)) {
      if (!resource.part.startsWith('{') || !route.path.startsWith(`${path}/`)) continue;
      addGatewayStaticSiblings(route, path, resource, resources, methods);
    }
  }
}

function addGatewayFallbackMethods(resources: GatewayResources, methods: GatewayMethods): void {
  // Unknown descendants of an explicit resource do not fall back to /api's
  // proxy. Every branch needs its own proxy to preserve Hono's 404/CORS policy.
  for (const path of Object.keys(resources)) {
    const hasParameterChild = Object.values(resources).some(
      (resource) => resource.parent === path && resource.part.startsWith('{'),
    );
    if (!hasParameterChild) addGatewayResource(resources, `${path}/{proxy+}`);
  }
  for (const path of Object.keys(resources).sort()) {
    if (resources[path]?.depth === undefined || resources[path].depth > 9)
      throw new Error('Gateway resource depth needs reviewed Terraform support');
    methods[`ANY ${path}`] = { method: 'ANY', path, model: null };
  }
}

export function buildGatewayContract(routes: readonly ApiRouteContract[] = TARGET_API_ROUTE_CONTRACTS) {
  const resources: GatewayResources = {};
  const methods: GatewayMethods = {};
  const models: Record<string, Model> = {};
  const honoConstraints: string[] = [];

  for (const route of routes) {
    const path = `/api${route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}')}`;
    const model = registerGatewayBodyModel(route, models, honoConstraints);
    addGatewayResource(resources, path);
    methods[`${route.method} ${path}`] = { method: route.method, path, model };
  }
  if (Object.keys(models).length !== Object.keys(BODY_MODELS).length)
    throw new Error('Gateway body route inventory changed');
  addGatewayShadowRoutes(resources, methods);
  addGatewayFallbackMethods(resources, methods);
  return { resources, methods, models, honoConstraints };
}

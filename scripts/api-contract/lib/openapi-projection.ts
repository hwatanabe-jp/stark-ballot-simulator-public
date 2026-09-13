import { isDeepStrictEqual } from 'node:util';
import {
  StandardErrorResponseSchema,
  VerificationResourceResponseSchema,
  apiResponseSchema,
  availableVerificationResourceSchema,
} from '@stark-ballot/api-contract/schemas';
import type {
  ApiContractPublicErrorResponse,
  ApiRouteContract,
  RouteResponse,
} from '@stark-ballot/api-contract/routes';
import { verifierServiceWireReportSchema } from '@stark-ballot/verification/verifier-service-report';
import { getSchemaDescriptor, type AnySchema } from '@stark-ballot/validation/schema';
import { openApiSchemaAcceptsUndefined, projectSchemaForOpenApi, type OpenApiSchema } from './openapi-reference-policy';
import { getOpenApiRouteReference, type OpenApiRouteReference } from './openapi-route-reference';

export type OpenApiDocument = Readonly<Record<string, unknown>>;

const mountedAvailableVerificationResponseSchema = apiResponseSchema(availableVerificationResourceSchema);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
}

function schemaFields(schema: AnySchema, path: string): readonly [string, AnySchema, boolean][] {
  const descriptor = getSchemaDescriptor(schema);
  if (descriptor.kind !== 'ObjectSchema') {
    throw new Error(`${path} must be an object schema`);
  }
  return Object.entries(descriptor.shape)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, fieldSchema]) => {
      const optional = openApiSchemaAcceptsUndefined(fieldSchema, `${path}.${name}`);
      return [name, fieldSchema, optional] as const;
    });
}

function parameterDescription(name: string, location: 'header' | 'path' | 'query'): string {
  if (location === 'path') return `${name} path value admitted by the mounted route.`;
  if (location === 'header') return `${name} request header admitted by the mounted route.`;
  return `${name} query value admitted from its documented wire representation.`;
}

function mergeParameterOverlay(
  route: ApiRouteContract,
  key: string,
  projection: OpenApiSchema,
  overlay: Readonly<Record<string, unknown>> | undefined,
): OpenApiSchema {
  if (overlay === undefined) return projection;
  for (const [name, value] of Object.entries(overlay)) {
    if (Object.hasOwn(projection, name) && !isDeepStrictEqual(projection[name], value)) {
      throw new Error(`Route ${route.routeId} parameter overlay ${key}.${name} contradicts its schema projection`);
    }
  }
  return { ...projection, ...overlay };
}

function projectParameters(route: ApiRouteContract, reference: OpenApiRouteReference): readonly OpenApiDocument[] {
  const parameters: OpenApiDocument[] = [];
  const usedOverlays = new Set<string>();
  const locations = [
    ['params', 'path'],
    ['query', 'query'],
    ['headers', 'header'],
  ] as const;
  for (const [requestKey, location] of locations) {
    const requestSchema = route.request[requestKey];
    if (requestSchema === undefined) continue;
    for (const [name, fieldSchema, optional] of schemaFields(requestSchema, `${route.routeId}.${requestKey}`)) {
      if (location === 'header' && name.toLowerCase() === 'x-session-capability') {
        continue;
      }
      const overlayKey: `${typeof location}:${string}` = `${location}:${name}`;
      const overlay = reference.parameterOverlays?.[overlayKey];
      if (overlay !== undefined) usedOverlays.add(overlayKey);
      parameters.push({
        name,
        in: location,
        required: location === 'path' || !optional,
        description: parameterDescription(name, location),
        schema: mergeParameterOverlay(
          route,
          overlayKey,
          projectSchemaForOpenApi(fieldSchema, `${route.routeId}.${requestKey}.${name}`, 'input'),
          overlay,
        ),
      });
    }
  }
  const unusedOverlays = Object.keys(reference.parameterOverlays ?? {}).filter((key) => !usedOverlays.has(key));
  if (unusedOverlays.length > 0) {
    throw new Error(`Route ${route.routeId} has unused parameter overlays: ${unusedOverlays.join(', ')}`);
  }
  return parameters;
}

function successMediaType(route: ApiRouteContract, response: RouteResponse): string {
  if (response.content === 'binary') {
    if (route.routeId !== 'sessions.finalizations.artifacts.bundle.get') {
      throw new Error(`Route ${route.routeId} has an undocumented binary response`);
    }
    return 'application/zip';
  }
  if (response.content === 'json') return 'application/json';
  return 'text/plain';
}

function successSchema(route: ApiRouteContract, response: RouteResponse): OpenApiSchema | undefined {
  if (route.routeId === 'sessions.finalizations.verification.get' && response.status === 200) {
    if (!('schema' in response) || response.schema !== VerificationResourceResponseSchema) {
      throw new Error(`${route.routeId} no longer matches its reviewed mounted-success projection`);
    }
    return projectSchemaForOpenApi(
      mountedAvailableVerificationResponseSchema,
      `${route.routeId}.mounted-response.${response.status}`,
      'output',
    );
  }
  if ('schema' in response) {
    return projectSchemaForOpenApi(response.schema, `${route.routeId}.response.${response.status}`, 'output');
  }
  if (response.content === 'binary') {
    return { type: 'string', format: 'binary' };
  }
  if (response.status === 304 && response.exemptReason === 'conditional-request-not-modified') {
    return undefined;
  }
  throw new Error(`Route ${route.routeId} response ${response.status} lacks a reviewed OpenAPI projection`);
}

function projectSuccessResponse(route: ApiRouteContract, response: RouteResponse): OpenApiDocument {
  if (
    route.routeId === 'sessions.finalizations.artifacts.report.get' &&
    response.status === 200 &&
    response.content === 'json' &&
    'exemptReason' in response &&
    response.exemptReason === 'protected-report-artifact-download'
  ) {
    return {
      description:
        'Successful retained report bytes. The mounted route preserves the stored JSON representation without revalidating it.',
      content: {
        'application/json': {},
      },
      'x-stark-ballot-response-exemption': response.exemptReason,
      'x-stark-ballot-runtime-validation': 'retained-bytes-not-revalidated',
      'x-stark-ballot-expected-retained-schema': projectSchemaForOpenApi(
        verifierServiceWireReportSchema,
        `${route.routeId}.expected-retained-response.${response.status}`,
        'output',
      ),
    };
  }
  const schema = successSchema(route, response);
  return {
    description: response.status === 304 ? 'The selected representation has not changed.' : 'Successful response.',
    ...(schema === undefined
      ? {}
      : {
          content: {
            [successMediaType(route, response)]: { schema },
          },
        }),
    ...(!('exemptReason' in response) ? {} : { 'x-stark-ballot-response-exemption': response.exemptReason }),
    ...(route.routeId === 'sessions.finalizations.verification.get' && response.status === 200
      ? { 'x-stark-ballot-mounted-success-projection': 'available-only' }
      : {}),
  };
}

function errorResponseKey(error: ApiContractPublicErrorResponse): string {
  return error.status === 'upstream-response-status' ? 'default' : String(error.status);
}

function projectErrorResponses(route: ApiRouteContract): Readonly<Record<string, OpenApiDocument>> {
  const grouped = new Map<string, ApiContractPublicErrorResponse[]>();
  const upstreamSelected: ApiContractPublicErrorResponse[] = [];
  for (const error of route.publicErrors.responses) {
    if (error.contentType !== 'application/json' || error.envelope !== 'standard-error-envelope') {
      throw new Error(
        `Route ${route.routeId} error ${error.code ?? error.case} uses unsupported ${error.contentType}/${error.envelope}`,
      );
    }
    const key = errorResponseKey(error);
    if (key === 'default') upstreamSelected.push(error);
    grouped.set(key, [...(grouped.get(key) ?? []), error]);
  }
  if (upstreamSelected.length > 0) {
    for (const [status, errors] of grouped) {
      if (status !== 'default') grouped.set(status, [...errors, ...upstreamSelected]);
    }
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([status, errors]) => [
        status,
        {
          description:
            status === 'default'
              ? 'The upstream service selects the HTTP status for this documented error.'
              : `Documented error response (${errors.map((error) => error.code ?? error.case).join(', ')}).`,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/StandardErrorResponse' },
            },
          },
          'x-stark-ballot-errors': errors,
        },
      ]),
  );
}

function projectResponses(route: ApiRouteContract): Readonly<Record<string, OpenApiDocument>> {
  const responses: Record<string, OpenApiDocument> = { ...projectErrorResponses(route) };
  for (const response of [...route.responses].sort((left, right) => left.status - right.status)) {
    const key = String(response.status);
    if (responses[key] !== undefined) {
      throw new Error(`Route ${route.routeId} declares success and error response ${key}`);
    }
    responses[key] = projectSuccessResponse(route, response);
  }
  return Object.fromEntries(Object.entries(responses).sort(([left], [right]) => compareText(left, right)));
}

function projectRequestBody(route: ApiRouteContract): OpenApiDocument | undefined {
  if (route.request.rawBody !== undefined) {
    throw new Error(`Route ${route.routeId} uses an authenticated raw body without a reviewed OpenAPI projection`);
  }
  if (route.request.body === undefined) return undefined;
  return {
    required: route.request.emptyBody !== 'empty-object',
    content: {
      'application/json': {
        schema: projectSchemaForOpenApi(route.request.body, `${route.routeId}.request.body`, 'input'),
      },
    },
  };
}

function projectSecurity(route: ApiRouteContract): readonly OpenApiDocument[] {
  if (route.lifecycle !== 'active') {
    throw new Error(`Route ${route.routeId} is not an active guest-safe route`);
  }
  if (route.routeId === 'session.post') {
    if (
      route.authScope !== 'public-mutation' ||
      route.capabilityScope !== 'none' ||
      route.dataClassification !== 'public-session-issued'
    ) {
      throw new Error(`Route ${route.routeId} does not match the reviewed public session-creation boundary`);
    }
    return [];
  }
  if (
    route.authScope !== 'path-session-capability' ||
    route.capabilityScope !== 'path' ||
    !['owner-scoped-public-projection', 'owner-scoped-private-report'].includes(route.dataClassification)
  ) {
    throw new Error(`Route ${route.routeId} does not match the reviewed session-capability boundary`);
  }
  return [{ sessionCapability: [] }];
}

function projectOperation(route: ApiRouteContract): OpenApiDocument {
  const reference = getOpenApiRouteReference(route.routeId);
  if (reference === undefined) {
    throw new Error(`Route ${route.routeId} lacks guest-safe OpenAPI reference metadata`);
  }
  const parameters = projectParameters(route, reference);
  const requestBody = projectRequestBody(route);
  const security = projectSecurity(route);
  return {
    operationId: route.routeId,
    summary: reference.summary,
    description: reference.description,
    tags: [reference.tag],
    security,
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(requestBody === undefined ? {} : { requestBody }),
    responses: projectResponses(route),
    'x-stark-ballot-lifecycle': route.lifecycle,
    'x-stark-ballot-data-classification': route.dataClassification,
    'x-stark-ballot-admission-controls': [...route.admissionControls, ...(reference.additionalAdmissionControls ?? [])],
    'x-stark-ballot-body-size': route.bodySize,
    'x-stark-ballot-source-ip': { dependency: route.sourceIp.dependency },
    ...(route.rateLimit === undefined ? {} : { 'x-stark-ballot-rate-limit': route.rateLimit }),
    ...(route.turnstile === undefined ? {} : { 'x-stark-ballot-turnstile': route.turnstile }),
    'x-stark-ballot-production-bypass': route.productionBypass,
    'x-stark-ballot-errors': route.publicErrors.responses,
  };
}

export function buildOpenApiDocument(routes: readonly ApiRouteContract[]): OpenApiDocument {
  const operationIds = new Set<string>();
  const paths: Record<string, Record<string, OpenApiDocument>> = {};
  for (const route of [...routes].sort((left, right) => {
    const pathDifference = compareText(openApiPath(left.path), openApiPath(right.path));
    return pathDifference === 0 ? compareText(left.method, right.method) : pathDifference;
  })) {
    if (operationIds.has(route.routeId)) throw new Error(`Duplicate OpenAPI operationId: ${route.routeId}`);
    operationIds.add(route.routeId);
    const path = openApiPath(route.path);
    const method = route.method.toLowerCase();
    const pathItem = paths[path] ?? {};
    if (pathItem[method] !== undefined) throw new Error(`Duplicate OpenAPI operation: ${route.method} ${path}`);
    pathItem[method] = projectOperation(route);
    paths[path] = pathItem;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'STARK Ballot Simulator API',
      version: 'unversioned',
      description:
        'Generated guest-safe reference for the current public Hono routes. Protected operations still require their documented session capability.',
    },
    servers: [{ url: '/api' }],
    tags: ['Artifacts', 'Bulletin', 'Finalization', 'Sessions', 'Verification', 'Voting'].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        sessionCapability: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Session-Capability',
          description: 'Capability token scoped to the session path.',
        },
      },
      schemas: {
        StandardErrorResponse: projectSchemaForOpenApi(StandardErrorResponseSchema, 'StandardErrorResponse', 'output'),
      },
    },
  };
}

export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

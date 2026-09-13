import { type Infer, type SchemaShape, type AnySchema } from '@stark-ballot/validation/schema';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface AuthenticatedRawBodyPolicy<TLimitPath extends string = string> {
  readonly kind: 'authenticated-raw-body';
  readonly limitPath: TLimitPath;
  readonly authenticateBeforeParse: true;
}

export type RouteRequestSchemas =
  | {
      readonly params?: AnySchema;
      readonly query?: AnySchema;
      readonly headers?: AnySchema;
      readonly body?: never;
      readonly emptyBody?: never;
      readonly rawBody?: never;
    }
  | {
      readonly params?: AnySchema;
      readonly query?: AnySchema;
      readonly headers?: AnySchema;
      readonly body: AnySchema;
      readonly emptyBody?: 'empty-object';
      readonly rawBody?: never;
    }
  | {
      readonly params?: AnySchema;
      readonly query?: AnySchema;
      readonly headers?: AnySchema;
      readonly body?: never;
      readonly emptyBody?: never;
      readonly rawBody: AuthenticatedRawBodyPolicy;
    };

export interface JsonRouteResponse<TStatus extends number = number, TSchema extends AnySchema = AnySchema> {
  readonly status: TStatus;
  readonly content: 'json';
  readonly schema: TSchema;
}

export interface ExemptJsonRouteResponse<TStatus extends number = number> {
  readonly status: TStatus;
  readonly content: 'json';
  readonly exemptReason: string;
}

export interface BinaryRouteResponse<TStatus extends number = number> {
  readonly status: TStatus;
  readonly content: 'binary';
  readonly exemptReason: string;
}

export interface TextRouteResponse<TStatus extends number = number> {
  readonly status: TStatus;
  readonly content: 'text';
  readonly exemptReason: string;
}

export type RouteResponse = JsonRouteResponse | ExemptJsonRouteResponse | BinaryRouteResponse | TextRouteResponse;

export interface RouteLike {
  readonly routeId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly request: RouteRequestSchemas;
  readonly responses: readonly RouteResponse[];
  readonly serializeQuery?: (query: never) => Readonly<Record<string, QueryWireValue>>;
}

export type OrdinaryJsonRoute = RouteLike & {
  readonly request: Exclude<RouteRequestSchemas, { readonly rawBody: AuthenticatedRawBodyPolicy }>;
  readonly responses: readonly JsonRouteResponse[];
};

type QueryWirePrimitive = string | number | boolean;
export type QueryWireValue = QueryWirePrimitive | readonly QueryWirePrimitive[] | null | undefined;

type SegmentParameter<TSegment extends string> = TSegment extends `:${infer TParameter}` ? TParameter : never;

export type RoutePathParameter<TPath extends string> = TPath extends `${infer THead}/${infer TTail}`
  ? SegmentParameter<THead> | RoutePathParameter<TTail>
  : SegmentParameter<TPath>;

type ShapeKeys<TSchema extends AnySchema> = TSchema extends {
  readonly shape: infer TShape extends SchemaShape;
}
  ? keyof TShape
  : keyof Infer<TSchema>;

type RequestParamsSchema<TRequest extends RouteRequestSchemas> = TRequest extends {
  readonly params: infer TSchema extends AnySchema;
}
  ? TSchema
  : never;

type RequestQuerySchema<TRequest extends RouteRequestSchemas> = TRequest extends {
  readonly query: infer TSchema extends AnySchema;
}
  ? TSchema
  : never;

type PathSchemaKeys<TRequest extends RouteRequestSchemas> =
  RequestParamsSchema<TRequest> extends never ? never : ShapeKeys<RequestParamsSchema<TRequest>>;

type PathParameterDifference<TPath extends string, TRequest extends RouteRequestSchemas> =
  | Exclude<RoutePathParameter<TPath>, PathSchemaKeys<TRequest>>
  | Exclude<PathSchemaKeys<TRequest>, RoutePathParameter<TPath>>;

interface RouteDefinitionShape {
  readonly routeId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly request: RouteRequestSchemas;
  readonly responses: readonly RouteResponse[];
  readonly serializeQuery?: (...arguments_: never[]) => Readonly<Record<string, QueryWireValue>>;
}

type QuerySerializerMismatch<TDefinition extends RouteDefinitionShape> = TDefinition extends {
  readonly serializeQuery: infer TSerializer;
}
  ? RequestQuerySchema<TDefinition['request']> extends never
    ? 'query serializer requires a declared query schema'
    : TSerializer extends (
          query: Infer<RequestQuerySchema<TDefinition['request']>>,
        ) => Readonly<Record<string, QueryWireValue>>
      ? never
      : 'query serializer input must match the parsed query schema'
  : never;

type RouteDefinitionMismatch<TDefinition extends RouteDefinitionShape> =
  | PathParameterDifference<TDefinition['path'], TDefinition['request']>
  | QuerySerializerMismatch<TDefinition>;

type RouteDefinitionValidation<TDefinition extends RouteDefinitionShape> =
  RouteDefinitionMismatch<TDefinition> extends never
    ? readonly []
    : readonly [
        mismatch: {
          readonly routeDefinitionMismatch: RouteDefinitionMismatch<TDefinition>;
        },
      ];

export function defineRoute<const TDefinition extends RouteDefinitionShape>(
  definition: TDefinition,
  ..._validation: RouteDefinitionValidation<TDefinition>
): TDefinition {
  void _validation;
  return definition;
}

export function createQuerySerializer<
  const TSchema extends AnySchema,
  const TSerializer extends (query: Infer<TSchema>) => Readonly<Record<string, QueryWireValue>>,
>(_schema: TSchema, serializer: TSerializer): TSerializer {
  return serializer;
}

export function jsonResponse<const TStatus extends number, const TSchema extends AnySchema>(
  status: TStatus,
  schema: TSchema,
): JsonRouteResponse<TStatus, TSchema> {
  return { status, content: 'json', schema };
}

export function jsonResponseExempt<const TStatus extends number>(
  status: TStatus,
  exemptReason: string,
): ExemptJsonRouteResponse<TStatus> {
  return { status, content: 'json', exemptReason };
}

export function binaryResponse<const TStatus extends number>(
  status: TStatus,
  exemptReason: string,
): BinaryRouteResponse<TStatus> {
  return { status, content: 'binary', exemptReason };
}

export function textResponse<const TStatus extends number>(
  status: TStatus,
  exemptReason: string,
): TextRouteResponse<TStatus> {
  return { status, content: 'text', exemptReason };
}

type Simplify<TValue> = { [TKey in keyof TValue]: TValue[TKey] };

type InputLocation<TRequest extends RouteRequestSchemas, TLocation extends 'params' | 'query' | 'headers' | 'body'> =
  TRequest extends Record<TLocation, infer TSchema extends AnySchema>
    ? { [TKey in TLocation]: Infer<TSchema> }
    : Record<never, never>;

type RawBodyInput<TRequest extends RouteRequestSchemas> = TRequest extends {
  readonly rawBody: AuthenticatedRawBodyPolicy;
}
  ? { rawBody: Uint8Array }
  : Record<never, never>;

export type RouteInput<TRoute extends Pick<RouteLike, 'request'>> = Simplify<
  InputLocation<TRoute['request'], 'params'> &
    InputLocation<TRoute['request'], 'query'> &
    InputLocation<TRoute['request'], 'headers'> &
    InputLocation<TRoute['request'], 'body'> &
    RawBodyInput<TRoute['request']>
>;

type ResponseBody<TResponse extends RouteResponse> =
  TResponse extends JsonRouteResponse<number, infer TSchema extends AnySchema>
    ? Infer<TSchema>
    : TResponse extends TextRouteResponse
      ? string
      : TResponse extends BinaryRouteResponse
        ? ArrayBuffer | Uint8Array
        : unknown;

type RouteResponseOutput<TResponse extends RouteResponse> = TResponse extends RouteResponse
  ? {
      status: TResponse['status'];
      content: TResponse['content'];
      body: ResponseBody<TResponse>;
    }
  : never;

export type RouteOutput<TRoute extends Pick<RouteLike, 'responses'>> =
  TRoute['responses'][number] extends infer TResponse extends RouteResponse ? RouteResponseOutput<TResponse> : never;

type RouteStatus<TRoute extends Pick<RouteLike, 'responses'>> = TRoute['responses'][number]['status'];

type ResponseAtStatus<TRoute extends Pick<RouteLike, 'responses'>, TStatus extends RouteStatus<TRoute>> = Extract<
  TRoute['responses'][number],
  { status: TStatus }
>;

type OutputAtStatus<
  TRoute extends Pick<RouteLike, 'responses'>,
  TStatus extends RouteStatus<TRoute>,
> = RouteResponseOutput<ResponseAtStatus<TRoute, TStatus>>;

export function declaredResponse<const TRoute extends RouteLike, const TStatus extends RouteStatus<TRoute>>(
  route: TRoute,
  status: TStatus,
  body: ResponseBody<ResponseAtStatus<TRoute, TStatus>>,
): OutputAtStatus<TRoute, TStatus> {
  const candidates = route.responses.filter((response) => response.status === status);
  if (candidates.length === 0) {
    throw new Error(`Route ${route.routeId} does not declare response status ${status}`);
  }

  for (const response of candidates) {
    if ('schema' in response) {
      const parsed = response.schema.safeParse(body);
      if (parsed.success) {
        return {
          status,
          content: response.content,
          body: parsed.data,
        } as OutputAtStatus<TRoute, TStatus>;
      }
      continue;
    }
    if (response.content === 'text' && typeof body !== 'string') {
      continue;
    }
    if (response.content === 'binary' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
      continue;
    }
    return {
      status,
      content: response.content,
      body,
    } as OutputAtStatus<TRoute, TStatus>;
  }

  throw new Error(`Route ${route.routeId} response body does not match status ${status}`);
}

type RouteParams<TRoute extends Pick<RouteLike, 'request'>> = TRoute['request'] extends {
  readonly params: infer TSchema extends AnySchema;
}
  ? Infer<TSchema>
  : never;

type BuildPathArguments<TRoute extends Pick<RouteLike, 'path' | 'request'>> =
  RoutePathParameter<TRoute['path']> extends never ? readonly [] : readonly [params: RouteParams<TRoute>];

function replacePathParameters(path: string, params: Readonly<Record<string, unknown>>): string {
  return path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) {
        return segment;
      }
      const parameter = segment.slice(1);
      if (!Object.hasOwn(params, parameter) || params[parameter] === undefined) {
        throw new Error(`Missing route path parameter: ${parameter}`);
      }
      const value = params[parameter] as string | number | boolean;
      return encodeURIComponent(String(value));
    })
    .join('/');
}

function isReadonlyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildRoutePath<const TRoute extends RouteLike>(
  route: TRoute,
  ...arguments_: BuildPathArguments<TRoute>
): string {
  const params = arguments_[0] ?? {};
  return replacePathParameters(route.path, params);
}

type RouteQuery<TRoute extends Pick<RouteLike, 'request'>> = TRoute['request'] extends {
  readonly query: infer TSchema extends AnySchema;
}
  ? Infer<TSchema>
  : never;

type BuildUrlOptions<TRoute extends RouteLike> = (RoutePathParameter<TRoute['path']> extends never
  ? { params?: never }
  : { params: RouteParams<TRoute> }) &
  (RouteQuery<TRoute> extends never ? { query?: never } : { query?: RouteQuery<TRoute> });

type BuildUrlArguments<TRoute extends RouteLike> =
  RoutePathParameter<TRoute['path']> extends never
    ? readonly [options?: BuildUrlOptions<TRoute>]
    : readonly [options: BuildUrlOptions<TRoute>];

function serializeDefaultQuery(query: Readonly<Record<string, unknown>>): Readonly<Record<string, QueryWireValue>> {
  return query as Readonly<Record<string, QueryWireValue>>;
}

function appendQueryValue(search: URLSearchParams, key: string, value: QueryWireValue): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      search.append(key, String(item));
    }
    return;
  }
  search.append(key, String(value));
}

function buildRouteUrlWithBasePath<const TRoute extends RouteLike>(
  route: TRoute,
  options: BuildUrlOptions<TRoute> | undefined,
  basePath: string,
): string {
  let pathParams: Readonly<Record<string, unknown>> = {};
  if (options && 'params' in options && options.params !== undefined) {
    if (!isReadonlyRecord(options.params)) {
      throw new Error(`Route ${route.routeId} path parameters must be an object`);
    }
    pathParams = options.params;
  }
  const routePath = replacePathParameters(route.path, pathParams);
  const normalizedBasePath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const path = `${normalizedBasePath}${routePath}`;
  if (!options || !('query' in options) || options.query === undefined) {
    return path;
  }

  const serializer = route.serializeQuery as
    | ((query: RouteQuery<TRoute>) => Readonly<Record<string, QueryWireValue>>)
    | undefined;
  const wireQuery = serializer
    ? serializer(options.query)
    : serializeDefaultQuery(options.query as Readonly<Record<string, unknown>>);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(wireQuery)) {
    appendQueryValue(search, key, value);
  }
  const queryString = search.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export function buildRouteUrl<const TRoute extends RouteLike>(
  route: TRoute,
  ...arguments_: BuildUrlArguments<TRoute>
): string {
  return buildRouteUrlWithBasePath(route, arguments_[0], '');
}

export function buildApiRouteUrl<const TRoute extends RouteLike>(
  route: TRoute,
  ...arguments_: BuildUrlArguments<TRoute>
): string {
  return buildRouteUrlWithBasePath(route, arguments_[0], '/api');
}

export function buildApiRouteUrlFromInput<const TRoute extends RouteLike>(
  route: TRoute,
  input: RouteInput<TRoute>,
): string {
  // Both types derive their params/query members from this route. The request
  // input additionally carries headers/body, which URL construction ignores.
  return buildRouteUrlWithBasePath(route, input as unknown as BuildUrlOptions<TRoute>, '/api');
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function matchRoutePath<const TRoute extends RouteLike>(
  route: TRoute,
  pathname: string,
): RouteParams<TRoute> | (RoutePathParameter<TRoute['path']> extends never ? Record<never, never> : never) | null {
  const candidatePath = pathname.split(/[?#]/, 1)[0] ?? '';
  const templateSegments = route.path.split('/');
  const candidateSegments = candidatePath.split('/');
  if (templateSegments.length !== candidateSegments.length) {
    return null;
  }

  const rawParams: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const templateSegment = templateSegments[index];
    const candidateSegment = candidateSegments[index];
    if (templateSegment === undefined || candidateSegment === undefined) {
      return null;
    }
    if (!templateSegment.startsWith(':')) {
      if (templateSegment !== candidateSegment) {
        return null;
      }
      continue;
    }
    const decoded = decodePathSegment(candidateSegment);
    if (decoded === null) {
      return null;
    }
    rawParams[templateSegment.slice(1)] = decoded;
  }

  if (!('params' in route.request)) {
    return {} as RouteParams<TRoute> &
      (RoutePathParameter<TRoute['path']> extends never ? Record<never, never> : never);
  }
  const parsed = route.request.params.safeParse(rawParams);
  return parsed.success ? (parsed.data as RouteParams<TRoute>) : null;
}

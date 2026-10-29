import { Hono } from 'hono';
import { requireTurnstileToken } from '../middleware/turnstile';
import type { Context } from 'hono';
import { type ApiRouteContract, type RouteInput } from '@stark-ballot/api-contract/routes';
import type { AnySchema } from '@stark-ballot/validation/schema';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import { type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import type { ApiHandlerContext, ApiContextStore } from '../context';
import {
  admitBodylessRouteInput,
  admitJsonBodyRouteInput,
  admitRouteFinalizationId,
  admitRouteHead,
  admitRouteLocation,
  admitRouteSessionId,
  type RouteHead,
  type RouteLocation,
} from './honoRouteAdapter';
import { validateSessionById, validateSessionCapabilityForSession } from '../middleware/session';
import { parseJsonBody, parseSessionCreateRequest } from '../middleware/validation';
import { isExpectedTargetOriginVerified, isOperatorGatedDevelopRequest } from '../security/developOperatorGate';
import { errorResponse } from '../../http/response';
import { toApiHandlerContext } from '../../http/adapters/hono';
import { handleApiError } from '../../http/errorHandler';
import { admitPublicRouteErrorResponse } from '../utils/publicErrorAdmission';
import { getApiRouteDefinitions, type ApiRouteMode } from './definitions';
import type { RouteHandlerBinding } from './honoBindings';

interface ParsedRequestHead {
  locations: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface RoutePreparationState<TRoute extends ApiRouteContract> {
  route: TRoute;
  request: Request;
  store: ApiContextStore;
  baseContext: ApiHandlerContext;
  head: ParsedRequestHead;
}

type PreparedRoute<TRoute extends ApiRouteContract, TContext extends ApiHandlerContext> =
  | {
      input: RouteInput<TRoute>;
      context: TContext;
    }
  | Response;

type RoutePreparation<TRoute extends ApiRouteContract, TContext extends ApiHandlerContext> = (
  state: RoutePreparationState<TRoute>,
) => Promise<PreparedRoute<TRoute, TContext>> | PreparedRoute<TRoute, TContext>;

export interface ApiHonoEnv {
  Variables: {
    trustedRequestId: string;
  };
}

export type ApiHonoApp = Hono<ApiHonoEnv>;

function collectQueryParams(requestUrl: string): Record<string, unknown> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(requestUrl).searchParams) {
    if (!Object.hasOwn(params, key)) {
      params[key] = value;
      continue;
    }
    const existing = params[key];
    if (Array.isArray(existing)) {
      params[key] = [...existing, value];
    } else if (typeof existing === 'string') {
      params[key] = [existing, value];
    }
  }
  return params;
}

function schemaShapeKeys(schema: AnySchema): string[] {
  if (!('shape' in schema) || typeof schema.shape !== 'object' || schema.shape === null) {
    throw new Error('Declared header schema must expose an object shape');
  }
  return Object.keys(schema.shape);
}

function collectDeclaredHeaders(route: ApiRouteContract, request: Request): Record<string, string> {
  if (route.request.headers === undefined) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const name of schemaShapeKeys(route.request.headers)) {
    const value = request.headers.get(name);
    if (value !== null) {
      values[name] = value;
    }
  }
  return values;
}

function parseRequestHead(
  route: ApiRouteContract,
  request: Request,
  params: Record<string, string>,
): ParsedRequestHead | Response {
  const locations: Record<string, unknown> = {};
  if (route.request.params !== undefined) {
    const parsed = route.request.params.safeParse(params);
    if (!parsed.success) {
      return errorResponse(ErrorCode.INVALID_REQUEST, { issues: parsed.error.flatten() });
    }
    locations['params'] = parsed.data;
  }

  const query = collectQueryParams(request.url);
  if (route.request.query !== undefined) {
    const parsed = route.request.query.safeParse(query);
    if (!parsed.success) {
      return errorResponse(ErrorCode.INVALID_REQUEST, { issues: parsed.error.flatten() });
    }
    locations['query'] = parsed.data;
  } else if (Object.keys(query).length > 0) {
    return errorResponse(ErrorCode.INVALID_REQUEST, {
      issues: {
        formErrors: ['Unexpected query parameter'],
        fieldErrors: Object.fromEntries(Object.keys(query).map((key) => [key, ['Unexpected query parameter']])),
      },
    });
  }

  return {
    locations,
    headers: collectDeclaredHeaders(route, request),
  };
}

export function parseDeclaredHeaders<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
): RouteHead<TRoute> | Response {
  const values = { ...state.head.locations };
  if (state.route.request.headers !== undefined) {
    const parsed = state.route.request.headers.safeParse(state.head.headers);
    if (!parsed.success) {
      return errorResponse(ErrorCode.INVALID_REQUEST, { issues: parsed.error.flatten() });
    }
    values['headers'] = parsed.data;
  }
  return admitRouteHead(state.route, values);
}

async function parseDeclaredBody<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
  head: RouteHead<TRoute>,
): Promise<RouteInput<TRoute> | Response> {
  if (state.route.request.body === undefined) {
    return admitBodylessRouteInput(state.route, head);
  }
  const parsed =
    'emptyBody' in state.route.request
      ? await parseSessionCreateRequest(state.request)
      : await parseJsonBody(state.request, state.route.request.body);
  if (parsed instanceof Response) {
    return parsed;
  }
  return admitJsonBodyRouteInput(state.route, head, parsed.data);
}

/** Parse the declared body only after its headers have been admitted. */
export async function parseDeclaredInput<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
): Promise<RouteInput<TRoute> | Response> {
  const head = parseDeclaredHeaders(state);
  return head instanceof Response ? head : parseDeclaredBody(state, head);
}

/** Session read routes share capability admission, loading, and header validation. */
export async function prepareSessionRead<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
  sessionId: string,
) {
  const admitted = await authenticateAndLoadSession(state, sessionId);
  if (admitted instanceof Response) return admitted;
  const input = parseDeclaredHeaders(state);
  if (input instanceof Response) return input;
  return { input, context: { ...state.baseContext, ...admitted } };
}

/** Admit a path-bound finalization before authenticating and loading its session. */
export async function authenticateFinalizationSession<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
  params: { sessionId: string; finalizationId: string },
) {
  const finalizationId = admitFinalizationIdentity(params.finalizationId);
  if (finalizationId instanceof Response) return finalizationId;
  const admitted = await authenticateAndLoadSession(state, params.sessionId);
  if (admitted instanceof Response) return admitted;
  return { ...admitted, finalizationId };
}

/** Mutation input is parsed only after capability admission and session loading. */
export async function prepareSessionWrite<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
  sessionId: string,
  profile: ResolvedRuntimeProfile,
  rate: { clientIp: string },
  action: 'vote' | 'finalize',
) {
  const admitted = await authenticateAndLoadSession(state, sessionId);
  if (admitted instanceof Response) return admitted;
  const input = await parseDeclaredInput(state);
  if (input instanceof Response) return input;
  if (!('body' in input)) throw new Error('Session mutation routes must declare a request body');
  if (!state.baseContext.operatorGatedDevelop) {
    await requireTurnstileToken(profile, input, rate, action);
  }
  return { input, admitted };
}

/** Header-only routes authenticate without loading or touching persisted session state. */
export function authenticateDeclaredHeaders<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
  profile: ResolvedRuntimeProfile,
  wireSessionId: string,
) {
  const sessionId = authenticateSessionIdentity(profile, state.head.headers, wireSessionId);
  if (sessionId instanceof Response) return sessionId;
  const input = parseDeclaredHeaders(state);
  if (input instanceof Response) return input;
  return { input, sessionId };
}

function normalizedHeaders(values: Record<string, string>): Headers {
  return new Headers(values);
}

export function parsedLocation<TRoute extends ApiRouteContract, TLocation extends 'params' | 'query'>(
  state: RoutePreparationState<TRoute>,
  location: TLocation,
): RouteLocation<TRoute, TLocation> {
  return admitRouteLocation(state.route, state.head.locations, location);
}

function authenticateSessionIdentity(
  profile: ResolvedRuntimeProfile,
  headerValues: Record<string, string>,
  wireSessionId: string,
): SessionId | Response {
  const sessionId = admitRouteSessionId(wireSessionId);
  if (!sessionId) {
    return errorResponse(ErrorCode.INVALID_REQUEST);
  }
  const headers = normalizedHeaders(headerValues);
  const capability = validateSessionCapabilityForSession(profile, headers, sessionId);
  return capability instanceof Response ? capability : sessionId;
}

function admitFinalizationIdentity(wireFinalizationId: string): FinalizationId | Response {
  return admitRouteFinalizationId(wireFinalizationId) ?? errorResponse(ErrorCode.INVALID_REQUEST);
}

async function authenticateAndLoadSession<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
  sessionId: string,
): Promise<{ sessionId: SessionId; session: SessionReadModel } | Response> {
  const authenticatedSessionId = authenticateSessionIdentity(
    state.baseContext.runtimeProfile,
    state.head.headers,
    sessionId,
  );
  if (authenticatedSessionId instanceof Response) {
    return authenticatedSessionId;
  }
  const result = await validateSessionById(authenticatedSessionId, state.store, { updateActivity: false });
  if (result instanceof Response) {
    return result;
  }
  return result;
}

export function requireSameOrigin(headers: Record<string, string>, requestOrigin: string): Response | null {
  const origin = headers['Origin']?.trim();
  if (origin) {
    try {
      if (new URL(origin).origin !== requestOrigin) {
        return errorResponse(ErrorCode.SAME_ORIGIN_REQUIRED);
      }
    } catch {
      return errorResponse(ErrorCode.SAME_ORIGIN_REQUIRED);
    }
  }
  const site = headers['Sec-Fetch-Site']?.trim().toLowerCase();
  return site && site !== 'same-origin' && site !== 'none' ? errorResponse(ErrorCode.SAME_ORIGIN_REQUIRED) : null;
}

function validateTargetOriginVerifyHeader(profile: ResolvedRuntimeProfile, request: Request): Response | null {
  if (profile.target.kind !== 'aws') {
    return null;
  }
  const expected = process.env['EXPECTED_ORIGIN_VERIFY_HEADER']?.trim();
  if (!expected) {
    return null;
  }
  return isExpectedTargetOriginVerified(profile, request)
    ? null
    : errorResponse(ErrorCode.SAME_ORIGIN_REQUIRED, {
        details: 'Target API requests must arrive through the authorized CloudFront origin path',
      });
}

function currentRequestId(context: Context<ApiHonoEnv>): string {
  const value = context.get('trustedRequestId');
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Trusted request ID missing from Hono context');
  }
  return value;
}

function isRouteEnabled(route: ApiRouteContract, mode: ApiRouteMode): boolean {
  return getApiRouteDefinitions(mode).some((candidate) => candidate.routeId === route.routeId);
}

export function mountRoute<TRoute extends ApiRouteContract, TContext extends ApiHandlerContext>(
  registration: RouteRegistration,
  app: ApiHonoApp,
  binding: RouteHandlerBinding<TRoute, TContext>,
  prepare: RoutePreparation<TRoute, TContext>,
): void {
  const { mode, runtimeProfile, mountedRouteIds, getStore } = registration;
  const { route, handler } = binding;
  if (!isRouteEnabled(route, mode)) {
    return;
  }
  if (mountedRouteIds.has(route.routeId)) {
    throw new Error(`Duplicate API route mount: ${route.routeId}`);
  }
  mountedRouteIds.add(route.routeId);
  app.on(route.method, route.path, async (honoContext) => {
    const admit = (response: Response): Promise<Response> => admitPublicRouteErrorResponse(route, response);
    try {
      const request = honoContext.req.raw;
      const originFailure = validateTargetOriginVerifyHeader(runtimeProfile, request);
      if (originFailure) {
        return await admit(originFailure);
      }

      const store = getStore();
      const rawParams = honoContext.req.param();
      const parsedHead = parseRequestHead(route, request, rawParams);
      if (parsedHead instanceof Response) {
        return await admit(parsedHead);
      }
      const baseContext = toApiHandlerContext({
        context: honoContext,
        runtimeProfile,
        store,
        requestId: currentRequestId(honoContext),
        operatorGatedDevelop: isOperatorGatedDevelopRequest(runtimeProfile, request),
      });
      const prepared = await prepare({
        route,
        request,
        store,
        baseContext,
        head: parsedHead,
      });
      const response = prepared instanceof Response ? prepared : await handler(prepared);
      return await admit(response);
    } catch (error) {
      return await admit(handleApiError(error));
    }
  });
}

export interface RouteRegistration {
  mode: ApiRouteMode;
  runtimeProfile: ResolvedRuntimeProfile;
  mountedRouteIds: Set<string>;
  getStore: () => ApiContextStore;
}

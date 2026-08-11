import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { API_ROUTES, type ApiRouteContract, type RouteInput } from '@stark-ballot/api-contract/routes';
import type { SchemaTypeAny } from '@stark-ballot/validation/schema';
import { ErrorCode, ApiError } from '@stark-ballot/api-contract/errors/apiErrors';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import type { ApiHandler, ApiHandlerContext, ApiContextStore } from '../context';
import { enforceFinalizeRateLimit, enforceSessionCreateRateLimit, enforceVoteRateLimit } from '../middleware/rateLimit';
import { validateSessionById, validateSessionCapabilityForSession } from '../middleware/session';
import { parseJsonBody, parseSessionCreateRequest } from '../middleware/validation';
import { requireTurnstileToken } from '../middleware/turnstile';
import { extractTurnstileToken } from '../security/turnstile';
import { isExpectedTargetOriginVerified, isOperatorGatedDevelopRequest } from '../security/developOperatorGate';
import { errorResponse } from '../../http/response';
import { resolveAwsRequestContextSourceIp, resolveAwsRequestId, toApiHandlerContext } from '../../http/adapters/hono';
import { handleApiError } from '../../http/errorHandler';
import {
  logRequestSummary,
  resolveUntrustedClientRequestId,
  withRequestLogContext,
  withTrustedRequestIdHeader,
} from '../../http/requestLogging';
import { getCurrentFinalizationBitmapProofHandler } from '../handlers/bitmapProof';
import {
  getSessionBulletinConsistencyProofHandler,
  getSessionBulletinHandler,
  getSessionVoteInclusionProofHandler,
  isValidBulletinVoteId,
} from '../handlers/bulletin';
import { finalizeSessionHandler } from '../handlers/finalize';
import { admitFinalizationCallbackRequest, finalizeCallbackHandler } from '../handlers/finalizeCallback';
import { cancelFinalizationHandler } from '../handlers/finalizeCancel';
import { getProgressHandler } from '../handlers/progress';
import {
  createSessionHandler,
  shouldBlockTargetPublicSessionCreate,
  shouldRequireSessionCreateTurnstile,
} from '../handlers/session';
import { getCurrentFinalizationHandler } from '../handlers/currentFinalization';
import { getSessionBulletinSthHandler } from '../handlers/sth';
import { getVerificationBundleHandler, getVerificationReportHandler } from '../handlers/verificationBundles';
import { submitVerificationObservationHandler } from '../handlers/verificationObservation';
import { runVerificationHandler } from '../handlers/verificationRun';
import { getVerifyHandler } from '../handlers/verify';
import { submitVoteHandler } from '../handlers/vote';
import { getCurrentFinalizationInputCommitmentHandler } from '../handlers/inputCommitment';
import { admitPublicRouteErrorResponse } from '../utils/publicErrorAdmission';
import { getApiRouteDefinitions, type ApiMethod, type ApiRouteMode } from './definitions';
import {
  createArtifactDeliveryDependencies,
  type ArtifactDeliveryDependencies,
  type ArtifactDeliveryDependencyOverrides,
} from '../../composition/artifactDeliveryDependencies';
import {
  createFinalizationDependencies,
  type FinalizationDependencies,
  type FinalizationDependencyOverrides,
} from '../../composition/finalizationDependencies';

export { ORIGIN_VERIFY_HEADER } from '../security/developOperatorGate';

type RouteHead<TRoute extends ApiRouteContract> = Omit<RouteInput<TRoute>, 'body' | 'rawBody'>;

interface ParsedRequestHead {
  locations: Record<string, unknown>;
  headers: Record<string, string>;
}

interface RoutePreparationState<TRoute extends ApiRouteContract> {
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

const mountedRouteIdsByApp = new WeakMap<Hono, Set<string>>();

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

function schemaShapeKeys(schema: SchemaTypeAny): string[] {
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

function parseDeclaredHeaders<TRoute extends ApiRouteContract>(
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
  // Each location above was admitted by the corresponding declaration. TypeScript
  // cannot reconstruct the conditional RouteInput intersection from dynamic keys.
  return values as RouteHead<TRoute>;
}

async function parseDeclaredBody<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
  head: RouteHead<TRoute>,
): Promise<RouteInput<TRoute> | Response> {
  if (state.route.request.body === undefined) {
    // For bodyless declarations RouteInput and the admitted request head coincide.
    return head as RouteInput<TRoute>;
  }
  const parsed =
    'emptyBody' in state.route.request
      ? await parseSessionCreateRequest(state.request)
      : await parseJsonBody(state.request, state.route.request.body);
  if (parsed instanceof Response) {
    return parsed;
  }
  // The declared body schema supplies the conditional body member of RouteInput.
  return { ...head, body: parsed.data } as unknown as RouteInput<TRoute>;
}

function normalizedHeaders(values: Record<string, string>): Headers {
  return new Headers(values);
}

type RouteLocation<TRoute extends ApiRouteContract, TLocation extends 'params' | 'query'> =
  RouteInput<TRoute> extends Record<TLocation, infer TValue> ? TValue : never;

function parsedLocation<TRoute extends ApiRouteContract, TLocation extends 'params' | 'query'>(
  state: RoutePreparationState<TRoute>,
  location: TLocation,
): RouteLocation<TRoute, TLocation> {
  // parseRequestHead populated this value through the route's location schema.
  return state.head.locations[location] as RouteLocation<TRoute, TLocation>;
}

function authenticateSessionIdentity(
  profile: ResolvedRuntimeProfile,
  headerValues: Record<string, string>,
  sessionId: string,
): string | Response {
  const headers = normalizedHeaders(headerValues);
  const capability = validateSessionCapabilityForSession(profile, headers, sessionId);
  return capability instanceof Response ? capability : sessionId;
}

async function authenticateAndLoadSession<TRoute extends ApiRouteContract>(
  state: RoutePreparationState<TRoute>,
  sessionId: string,
): Promise<{ sessionId: string; session: SessionReadModel } | Response> {
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

function requireSameOrigin(headers: Record<string, string>, requestOrigin: string): Response | null {
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

function currentRequestId(context: Context<{ Variables: { trustedRequestId: string } }>): string {
  const value = context.get('trustedRequestId');
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Trusted request ID missing from Hono context');
  }
  return value;
}

function isRouteEnabled(route: ApiRouteContract, mode: ApiRouteMode): boolean {
  return getApiRouteDefinitions(mode).some((candidate) => candidate.routeId === route.routeId);
}

function mountRoute<TRoute extends ApiRouteContract, TContext extends ApiHandlerContext>(
  app: Hono,
  mode: ApiRouteMode,
  runtimeProfile: ResolvedRuntimeProfile,
  route: TRoute,
  handler: ApiHandler<TRoute, TContext>,
  prepare: RoutePreparation<TRoute, TContext>,
): void {
  if (!isRouteEnabled(route, mode)) {
    return;
  }
  const mountedRouteIds = mountedRouteIdsByApp.get(app);
  if (!mountedRouteIds) {
    throw new Error('Route registration was not initialized');
  }
  if (mountedRouteIds.has(route.routeId)) {
    throw new Error(`Duplicate API route mount: ${route.routeId}`);
  }
  mountedRouteIds.add(route.routeId);
  const method = route.method.toLowerCase() as Lowercase<ApiMethod>;
  app[method](route.path, async (honoContext) => {
    const admit = (response: Response): Promise<Response> => admitPublicRouteErrorResponse(route, response);
    try {
      const request = honoContext.req.raw;
      const originFailure = validateTargetOriginVerifyHeader(runtimeProfile, request);
      if (originFailure) {
        return await admit(originFailure);
      }

      const store = getGlobalStore(runtimeProfile);
      const rawParams = honoContext.req.param();
      const parsedHead = parseRequestHead(route, request, rawParams);
      if (parsedHead instanceof Response) {
        return await admit(parsedHead);
      }
      const baseContext = toApiHandlerContext({
        context: honoContext,
        runtimeProfile,
        store,
        requestId: currentRequestId(honoContext as unknown as Context<{ Variables: { trustedRequestId: string } }>),
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

function registerRoutes(
  app: Hono,
  mode: ApiRouteMode,
  runtimeProfile: ResolvedRuntimeProfile,
  finalizationDependencies: FinalizationDependencies,
  artifactDeliveryDependencies: ArtifactDeliveryDependencies,
): void {
  const mountedRouteIds = new Set<string>();
  mountedRouteIdsByApp.set(app, mountedRouteIds);
  mountRoute(app, mode, runtimeProfile, API_ROUTES.progress, getProgressHandler, (state) => {
    const params = parsedLocation(state, 'params');
    const sessionId = authenticateSessionIdentity(runtimeProfile, state.head.headers, params.sessionId);
    if (sessionId instanceof Response) return sessionId;
    const input = parseDeclaredHeaders(state);
    if (input instanceof Response) return input;
    return { input: input, context: { ...state.baseContext, sessionId } };
  });

  mountRoute(app, mode, runtimeProfile, API_ROUTES.verification, getVerifyHandler, async (state) => {
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateAndLoadSession(state, params.sessionId);
    if (admitted instanceof Response) return admitted;
    const input = parseDeclaredHeaders(state);
    if (input instanceof Response) return input;
    return { input: input, context: { ...state.baseContext, ...admitted } };
  });

  mountRoute(
    app,
    mode,
    runtimeProfile,
    API_ROUTES.currentFinalization,
    getCurrentFinalizationHandler,
    async (state) => {
      const params = parsedLocation(state, 'params');
      const admitted = await authenticateAndLoadSession(state, params.sessionId);
      if (admitted instanceof Response) return admitted;
      const input = parseDeclaredHeaders(state);
      if (input instanceof Response) return input;
      return {
        input: input,
        context: { ...state.baseContext, ...admitted, finalizationDependencies },
      };
    },
  );

  mountRoute(
    app,
    mode,
    runtimeProfile,
    API_ROUTES.finalizationArtifactBundle,
    getVerificationBundleHandler,
    (state) => {
      const params = parsedLocation(state, 'params');
      if (!isSafeVerifierSegment(params.sessionId) || !isSafeVerifierSegment(params.finalizationId)) {
        return errorResponse(new ApiError(ErrorCode.INVALID_BUNDLE_REFERENCE, 400, 'Invalid bundle reference'));
      }
      const sessionId = authenticateSessionIdentity(runtimeProfile, state.head.headers, params.sessionId);
      if (sessionId instanceof Response) return sessionId;
      const input = parseDeclaredHeaders(state);
      if (input instanceof Response) return input;
      return {
        input,
        context: { ...state.baseContext, sessionId, artifactDeliveryDependencies },
      };
    },
  );

  mountRoute(
    app,
    mode,
    runtimeProfile,
    API_ROUTES.finalizationArtifactReport,
    getVerificationReportHandler,
    (state) => {
      const params = parsedLocation(state, 'params');
      if (!isSafeVerifierSegment(params.sessionId) || !isSafeVerifierSegment(params.finalizationId)) {
        return errorResponse(new ApiError(ErrorCode.INVALID_BUNDLE_REFERENCE, 400, 'Invalid bundle reference'));
      }
      const sessionId = authenticateSessionIdentity(runtimeProfile, state.head.headers, params.sessionId);
      if (sessionId instanceof Response) return sessionId;
      const input = parseDeclaredHeaders(state);
      if (input instanceof Response) return input;
      return {
        input,
        context: { ...state.baseContext, sessionId, artifactDeliveryDependencies },
      };
    },
  );

  mountRoute(app, mode, runtimeProfile, API_ROUTES.sessionBulletin, getSessionBulletinHandler, async (state) => {
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateAndLoadSession(state, params.sessionId);
    if (admitted instanceof Response) return admitted;
    const input = parseDeclaredHeaders(state);
    if (input instanceof Response) return input;
    return { input: input, context: { ...state.baseContext, ...admitted } };
  });

  mountRoute(
    app,
    mode,
    runtimeProfile,
    API_ROUTES.sessionBulletinConsistencyProof,
    getSessionBulletinConsistencyProofHandler,
    async (state) => {
      const params = parsedLocation(state, 'params');
      const admitted = await authenticateAndLoadSession(state, params.sessionId);
      if (admitted instanceof Response) return admitted;
      const input = parseDeclaredHeaders(state);
      if (input instanceof Response) return input;
      return {
        input: input,
        context: { ...state.baseContext, ...admitted },
      };
    },
  );

  mountRoute(
    app,
    mode,
    runtimeProfile,
    API_ROUTES.sessionVoteInclusionProof,
    getSessionVoteInclusionProofHandler,
    async (state) => {
      const params = parsedLocation(state, 'params');
      if (!isValidBulletinVoteId(params.voteId)) {
        return errorResponse(ErrorCode.INVALID_VOTE_ID);
      }
      const admitted = await authenticateAndLoadSession(state, params.sessionId);
      if (admitted instanceof Response) return admitted;
      const input = parseDeclaredHeaders(state);
      if (input instanceof Response) return input;
      return {
        input: input,
        context: { ...state.baseContext, ...admitted },
      };
    },
  );

  mountRoute(
    app,
    mode,
    runtimeProfile,
    API_ROUTES.currentFinalizationBitmapProof,
    getCurrentFinalizationBitmapProofHandler,
    async (state) => {
      const params = parsedLocation(state, 'params');
      const admitted = await authenticateAndLoadSession(state, params.sessionId);
      if (admitted instanceof Response) return admitted;
      const input = parseDeclaredHeaders(state);
      if (input instanceof Response) return input;
      return {
        input: input,
        context: { ...state.baseContext, ...admitted },
      };
    },
  );

  mountRoute(app, mode, runtimeProfile, API_ROUTES.sessionBulletinSth, getSessionBulletinSthHandler, async (state) => {
    const originFailure = requireSameOrigin(state.head.headers, state.baseContext.requestOrigin);
    if (originFailure) return originFailure;
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateAndLoadSession(state, params.sessionId);
    if (admitted instanceof Response) return admitted;
    const input = parseDeclaredHeaders(state);
    if (input instanceof Response) return input;
    return { input: input, context: { ...state.baseContext, ...admitted } };
  });

  mountRoute(
    app,
    mode,
    runtimeProfile,
    API_ROUTES.currentFinalizationInputCommitment,
    getCurrentFinalizationInputCommitmentHandler,
    async (state) => {
      const params = parsedLocation(state, 'params');
      const admitted = await authenticateAndLoadSession(state, params.sessionId);
      if (admitted instanceof Response) return admitted;
      const input = parseDeclaredHeaders(state);
      if (input instanceof Response) return input;
      return {
        input: input,
        context: { ...state.baseContext, ...admitted },
      };
    },
  );

  mountRoute(app, mode, runtimeProfile, API_ROUTES.createSession, createSessionHandler, async (state) => {
    if (
      shouldBlockTargetPublicSessionCreate(state.baseContext.runtimeProfile, state.baseContext.operatorGatedDevelop)
    ) {
      return errorResponse(ErrorCode.SESSION_NOT_FOUND, {
        details:
          'Target public session creation requires explicit public enablement with server-side Turnstile or the operator-gated develop exception',
      });
    }
    const rate = await enforceSessionCreateRateLimit(runtimeProfile, state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const head = parseDeclaredHeaders(state);
    if (head instanceof Response) return head;
    const input = await parseDeclaredBody(state, head);
    if (input instanceof Response) return input;
    if (shouldRequireSessionCreateTurnstile(state.baseContext.runtimeProfile)) {
      await requireTurnstileToken(runtimeProfile, {
        payload: input.body,
        ...omitUndefinedProperties({ explicitToken: extractTurnstileToken(input.body) }),
        clientIp: rate.clientIp,
        expectedAction: 'session',
      });
    }
    return {
      input,
      context: { ...state.baseContext, rateLimitClientIp: rate.clientIp },
    };
  });

  mountRoute(app, mode, runtimeProfile, API_ROUTES.submitVote, submitVoteHandler, async (state) => {
    const rate = await enforceVoteRateLimit(runtimeProfile, state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateAndLoadSession(state, params.sessionId);
    if (admitted instanceof Response) return admitted;
    const head = parseDeclaredHeaders(state);
    if (head instanceof Response) return head;
    const input = await parseDeclaredBody(state, head);
    if (input instanceof Response) return input;
    if (!state.baseContext.operatorGatedDevelop) {
      await requireTurnstileToken(runtimeProfile, {
        payload: input.body,
        ...omitUndefinedProperties({ explicitToken: extractTurnstileToken(input.body) }),
        clientIp: rate.clientIp,
        expectedAction: 'vote',
      });
    }
    return {
      input,
      context: { ...state.baseContext, ...admitted, rateLimitClientIp: rate.clientIp },
    };
  });

  mountRoute(app, mode, runtimeProfile, API_ROUTES.createFinalization, finalizeSessionHandler, async (state) => {
    const rate = await finalizationDependencies.enforceFinalizeRateLimit(state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateAndLoadSession(state, params.sessionId);
    if (admitted instanceof Response) return admitted;
    const head = parseDeclaredHeaders(state);
    if (head instanceof Response) return head;
    const input = await parseDeclaredBody(state, head);
    if (input instanceof Response) return input;
    if (!state.baseContext.operatorGatedDevelop) {
      await requireTurnstileToken(runtimeProfile, {
        payload: input.body,
        ...omitUndefinedProperties({ explicitToken: extractTurnstileToken(input.body) }),
        clientIp: rate.clientIp,
        expectedAction: 'finalize',
      });
    }
    return {
      input,
      context: {
        ...state.baseContext,
        ...admitted,
        finalizeRateLimit: rate,
        finalizationDependencies,
      },
    };
  });

  mountRoute(app, mode, runtimeProfile, API_ROUTES.cancelFinalization, cancelFinalizationHandler, async (state) => {
    if (runtimeProfile.finalization.mode !== 'async') {
      return errorResponse(new ApiError(ErrorCode.ASYNC_FINALIZATION_DISABLED, 404, 'Async finalization disabled'));
    }
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateAndLoadSession(state, params.sessionId);
    if (admitted instanceof Response) return admitted;
    const rate = await finalizationDependencies.enforceFinalizeCancelRateLimit(state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const head = parseDeclaredHeaders(state);
    if (head instanceof Response) return head;
    const input = await parseDeclaredBody(state, head);
    if (input instanceof Response) return input;
    return {
      input,
      context: {
        ...state.baseContext,
        ...admitted,
        rateLimitClientIp: rate.clientIp,
        finalizationDependencies,
      },
    };
  });

  mountRoute(
    app,
    mode,
    runtimeProfile,
    API_ROUTES.recordVerificationObservation,
    submitVerificationObservationHandler,
    async (state) => {
      const params = parsedLocation(state, 'params');
      const admitted = await authenticateAndLoadSession(state, params.sessionId);
      if (admitted instanceof Response) return admitted;
      const head = parseDeclaredHeaders(state);
      if (head instanceof Response) return head;
      const input = await parseDeclaredBody(state, head);
      if (input instanceof Response) return input;
      return { input, context: { ...state.baseContext, ...admitted } };
    },
  );

  mountRoute(app, mode, runtimeProfile, API_ROUTES.runVerification, runVerificationHandler, async (state) => {
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateAndLoadSession(state, params.sessionId);
    if (admitted instanceof Response) return admitted;
    if (admitted.session.finalization?.state.status !== 'succeeded') {
      return errorResponse(ErrorCode.SESSION_NOT_FINALIZED);
    }
    const rate = await enforceFinalizeRateLimit(runtimeProfile, state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const head = parseDeclaredHeaders(state);
    if (head instanceof Response) return head;
    const input = await parseDeclaredBody(state, head);
    if (input instanceof Response) return input;
    return {
      input,
      context: { ...state.baseContext, ...admitted, finalizeRateLimit: rate },
    };
  });

  const expectedRouteIds = new Set(getApiRouteDefinitions(mode).map((route) => route.routeId));
  const missingRouteIds = [...expectedRouteIds].filter((routeId) => !mountedRouteIds.has(routeId));
  const unexpectedRouteIds = [...mountedRouteIds].filter((routeId) => !expectedRouteIds.has(routeId));
  if (missingRouteIds.length > 0 || unexpectedRouteIds.length > 0) {
    throw new Error(
      `API route mount mismatch: missing=[${missingRouteIds.join(',')}], unexpected=[${unexpectedRouteIds.join(',')}]`,
    );
  }
}

export interface HonoAppOptions {
  basePath?: string;
  mode?: ApiRouteMode;
  runtimeProfile?: ResolvedRuntimeProfile;
  finalizationDependencyOverrides?: FinalizationDependencyOverrides;
  artifactDeliveryDependencyOverrides?: ArtifactDeliveryDependencyOverrides;
}

function getCorsOrigins(): string[] {
  const envOrigins = process.env['HONO_CORS_ALLOW_ORIGINS'];
  return envOrigins ? envOrigins.split(',').map((origin) => origin.trim()) : ['http://localhost:3000'];
}

export function createHonoApp(options: HonoAppOptions = {}): Hono {
  const { basePath = '/api', mode = 'full' } = options;
  const runtimeProfile = options.runtimeProfile ?? resolveRuntimeProfile(process.env);
  validateEnv(runtimeProfile);
  const app = new Hono().basePath(basePath);
  const finalizationDependencies = createFinalizationDependencies(
    runtimeProfile,
    options.finalizationDependencyOverrides,
  );
  const artifactDeliveryDependencies = createArtifactDeliveryDependencies(
    runtimeProfile,
    options.artifactDeliveryDependencyOverrides,
  );

  app.use('*', async (context, next) => {
    const startedAt = Date.now();
    const request = context.req.raw;
    const requestId = resolveAwsRequestId(context) ?? randomUUID();
    (context as unknown as Context<{ Variables: { trustedRequestId: string } }>).set('trustedRequestId', requestId);
    const clientRequestId = resolveUntrustedClientRequestId(request.headers);
    const matchedRoutePath = context.req.matchedRoutes.at(-1)?.path;
    const safeRoutePath = matchedRoutePath && matchedRoutePath !== '*' ? matchedRoutePath : `${basePath}/*`;

    await withRequestLogContext(
      runtimeProfile,
      request,
      async () => {
        try {
          await next();
        } catch (error) {
          context.res = handleApiError(error);
        }
        context.res = withTrustedRequestIdHeader(context.res, requestId);
        logRequestSummary(context.res, Date.now() - startedAt, omitUndefinedProperties({ clientRequestId }));
      },
      {
        service: 'public-api',
        fallbackIp: resolveAwsRequestContextSourceIp(context),
        routePath: safeRoutePath,
        requestId,
      },
    );
  });

  app.onError((error) => handleApiError(error));
  if (mode === 'full') {
    app.post('/internal/sessions/:sessionId/finalizations/:finalizationId/callback', async (context) => {
      try {
        const admitted = await admitFinalizationCallbackRequest(context.req.raw);
        if (admitted instanceof Response) {
          return admitted;
        }
        return await finalizeCallbackHandler({
          rawBody: admitted.rawBody,
          sessionId: context.req.param('sessionId'),
          finalizationId: context.req.param('finalizationId'),
          store: getGlobalStore(runtimeProfile),
        });
      } catch (error) {
        return handleApiError(error);
      }
    });
  }
  app.all('/internal/*', (context) => context.notFound());
  app.use(
    '*',
    cors({
      origin: getCorsOrigins(),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', SESSION_CAPABILITY_HEADER, 'Range', 'If-None-Match'],
      exposeHeaders: [
        'Content-Range',
        'Accept-Ranges',
        'ETag',
        'X-Amz-Version-Id',
        'X-Stark-Bundle-Range-Chunk-Size',
        'x-request-id',
      ],
    }),
  );

  registerRoutes(app, mode, runtimeProfile, finalizationDependencies, artifactDeliveryDependencies);
  return app;
}

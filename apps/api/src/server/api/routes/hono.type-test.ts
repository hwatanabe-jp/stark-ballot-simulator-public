import type { Context } from 'hono';
import {
  API_ROUTES,
  defineRoute,
  jsonResponse,
  type ApiContractRouteId,
  type RouteInput,
} from '@stark-ballot/api-contract/routes';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { s } from '@stark-ballot/validation/schema';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type {
  ApiHandlerContext,
  RouteBoundResponse,
  SessionAdmittedContext,
  SessionFinalizationAdmittedContext,
} from '../context';
import { respondWithRoute, respondWithRouteError } from '../utils/responseSchema';
import { defineRouteHandler, type ApiHonoEnv, type routeMountRegistry } from './hono';

declare const honoContext: Context<ApiHonoEnv>;
void (honoContext.get('trustedRequestId') satisfies string);
// @ts-expect-error Only declared trusted context variables are readable.
honoContext.get('clientSuppliedRequestId');

declare const sessionContext: SessionAdmittedContext;
void (sessionContext.sessionId satisfies SessionId);
declare const finalizationContext: SessionFinalizationAdmittedContext;
void (finalizationContext.finalizationId satisfies FinalizationId);

const progressHandler = defineRouteHandler(
  API_ROUTES.progress,
  ({ input }: { input: RouteInput<typeof API_ROUTES.progress>; context: ApiHandlerContext }) =>
    respondWithRouteError(API_ROUTES.progress, {
      code: ErrorCode.SESSION_NOT_FOUND,
      status: input.params.sessionId.length > 0 ? 404 : 404,
    }),
);
void progressHandler;

const declaredError = respondWithRouteError(API_ROUTES.progress, {
  code: ErrorCode.SESSION_NOT_FOUND,
  status: 404,
});
void (declaredError satisfies RouteBoundResponse<typeof API_ROUTES.progress>);

// @ts-expect-error Error codes and statuses remain coupled to the selected route.
respondWithRouteError(API_ROUTES.progress, { code: ErrorCode.DUPLICATE_VOTE, status: 409 });

// @ts-expect-error Error statuses remain coupled to the selected route and code.
respondWithRouteError(API_ROUTES.progress, {
  code: ErrorCode.SESSION_NOT_FOUND,
  status: 409,
});

// @ts-expect-error A handler cannot return a response branded for a different route.
defineRouteHandler(API_ROUTES.progress, () =>
  respondWithRouteError(API_ROUTES.createSession, {
    code: ErrorCode.SESSION_LIMIT_EXCEEDED,
    status: 503,
  }),
);

defineRouteHandler(
  API_ROUTES.progress,
  // @ts-expect-error Ordinary JSON handlers cannot return an unadmitted native Response.
  () => new Response('{}', { status: 200 }),
);

const bodyRoute = defineRoute({
  routeId: 'handler-output-type-test',
  method: 'GET',
  path: '/handler-output-type-test',
  request: {},
  responses: [jsonResponse(200, s.object({ value: s.string() }))],
});

respondWithRoute(bodyRoute, {
  status: 200,
  content: 'json',
  body: {
    // @ts-expect-error Success bodies remain coupled to their route schema.
    value: 42,
  },
});

const invalidVoteInput: RouteInput<typeof API_ROUTES.submitVote> = {
  params: { sessionId: 'session-1' },
  headers: { 'X-Session-Capability': 'capability-token' },
  // @ts-expect-error Request bodies remain coupled to their route schema.
  body: { scenarioId: 'S0' },
};
void invalidVoteInput;

type RegisteredRouteId = keyof typeof routeMountRegistry;
const allRouteIdsRegistered: [ApiContractRouteId] extends [RegisteredRouteId]
  ? [RegisteredRouteId] extends [ApiContractRouteId]
    ? true
    : false
  : false = true;
void allRouteIdsRegistered;

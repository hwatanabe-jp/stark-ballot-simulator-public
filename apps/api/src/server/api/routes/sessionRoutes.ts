import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { enforceSessionCreateRateLimit, enforceVoteRateLimit } from '../middleware/rateLimit';
import { requireTurnstileToken } from '../middleware/turnstile';
import { errorResponse } from '../../http/response';
import { shouldBlockTargetPublicSessionCreate, shouldRequireSessionCreateTurnstile } from '../handlers/session';
import { routeMountRegistry } from './honoBindings';
import {
  mountRoute,
  parsedLocation,
  authenticateDeclaredHeaders,
  prepareSessionWrite,
  parseDeclaredInput,
  type RouteRegistration,
  type ApiHonoApp,
} from './honoRegistration';

export function registerSessionRoutes(app: ApiHonoApp, registration: RouteRegistration): void {
  const { runtimeProfile } = registration;
  mountRoute(registration, app, routeMountRegistry[API_ROUTES.progress.routeId], (state) => {
    const params = parsedLocation(state, 'params');
    const admitted = authenticateDeclaredHeaders(state, runtimeProfile, params.sessionId);
    if (admitted instanceof Response) return admitted;
    const { input, sessionId } = admitted;
    return { input: input, context: { ...state.baseContext, sessionId } };
  });

  mountRoute(registration, app, routeMountRegistry[API_ROUTES.createSession.routeId], async (state) => {
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
    const input = await parseDeclaredInput(state);
    if (input instanceof Response) return input;
    if (shouldRequireSessionCreateTurnstile(state.baseContext.runtimeProfile)) {
      await requireTurnstileToken(runtimeProfile, input, rate, 'session');
    }
    return {
      input,
      context: { ...state.baseContext, rateLimitClientIp: rate.clientIp },
    };
  });

  mountRoute(registration, app, routeMountRegistry[API_ROUTES.submitVote.routeId], async (state) => {
    const rate = await enforceVoteRateLimit(runtimeProfile, state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const params = parsedLocation(state, 'params');
    const prepared = await prepareSessionWrite(state, params.sessionId, runtimeProfile, rate, 'vote');
    if (prepared instanceof Response) return prepared;
    const { input, admitted } = prepared;
    return {
      input,
      context: { ...state.baseContext, ...admitted, rateLimitClientIp: rate.clientIp },
    };
  });
}

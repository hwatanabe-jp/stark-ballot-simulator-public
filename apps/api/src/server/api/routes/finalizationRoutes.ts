import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import { type FinalizationDependencies } from '../../composition/finalizationDependencies';
import { routeMountRegistry } from './honoBindings';
import {
  mountRoute,
  prepareSessionRead,
  parsedLocation,
  prepareSessionWrite,
  authenticateFinalizationSession,
  parseDeclaredInput,
  type RouteRegistration,
  type ApiHonoApp,
} from './honoRegistration';

export function registerFinalizationRoutes(
  app: ApiHonoApp,
  registration: RouteRegistration,
  finalizationDependencies: FinalizationDependencies,
): void {
  const { runtimeProfile } = registration;
  mountRoute(registration, app, routeMountRegistry[API_ROUTES.currentFinalization.routeId], async (state) => {
    const params = parsedLocation(state, 'params');
    return prepareSessionRead(state, params.sessionId);
  });

  mountRoute(
    registration,
    app,
    routeMountRegistry[API_ROUTES.currentFinalizationBitmapProof.routeId],
    async (state) => {
      const params = parsedLocation(state, 'params');
      return prepareSessionRead(state, params.sessionId);
    },
  );

  mountRoute(
    registration,
    app,
    routeMountRegistry[API_ROUTES.currentFinalizationInputCommitment.routeId],
    async (state) => {
      const params = parsedLocation(state, 'params');
      return prepareSessionRead(state, params.sessionId);
    },
  );

  mountRoute(registration, app, routeMountRegistry[API_ROUTES.createFinalization.routeId], async (state) => {
    const rate = await finalizationDependencies.enforceFinalizeRateLimit(state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const params = parsedLocation(state, 'params');
    const prepared = await prepareSessionWrite(state, params.sessionId, runtimeProfile, rate, 'finalize');
    if (prepared instanceof Response) return prepared;
    const { input, admitted } = prepared;
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

  mountRoute(registration, app, routeMountRegistry[API_ROUTES.cancelFinalization.routeId], async (state) => {
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateFinalizationSession(state, params);
    if (admitted instanceof Response) return admitted;
    const rate = await finalizationDependencies.enforceFinalizeCancelRateLimit(state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const input = await parseDeclaredInput(state);
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
}

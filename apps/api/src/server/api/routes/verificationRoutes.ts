import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import { ErrorCode, ApiError } from '@stark-ballot/api-contract/errors/apiErrors';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import { admitRouteFinalizationId } from './honoRouteAdapter';
import { enforceFinalizeRateLimit } from '../middleware/rateLimit';
import { errorResponse } from '../../http/response';
import { type ArtifactDeliveryDependencies } from '../../composition/artifactDeliveryDependencies';
import { routeMountRegistry } from './honoBindings';
import {
  mountRoute,
  parsedLocation,
  authenticateDeclaredHeaders,
  authenticateFinalizationSession,
  parseDeclaredHeaders,
  parseDeclaredInput,
  type RouteRegistration,
  type RoutePreparationState,
  type ApiHonoApp,
} from './honoRegistration';

export function registerVerificationRoutes(
  app: ApiHonoApp,
  registration: RouteRegistration,
  artifactDeliveryDependencies: ArtifactDeliveryDependencies,
): void {
  const { runtimeProfile } = registration;
  mountRoute(registration, app, routeMountRegistry[API_ROUTES.verification.routeId], async (state) => {
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateFinalizationSession(state, params);
    if (admitted instanceof Response) return admitted;
    const input = parseDeclaredHeaders(state);
    if (input instanceof Response) return input;
    return { input: input, context: { ...state.baseContext, ...admitted } };
  });

  const prepareArtifact = (
    state: RoutePreparationState<
      typeof API_ROUTES.finalizationArtifactBundle | typeof API_ROUTES.finalizationArtifactReport
    >,
  ) => {
    const params = parsedLocation(state, 'params');
    if (!isSafeVerifierSegment(params.sessionId) || !isSafeVerifierSegment(params.finalizationId)) {
      return errorResponse(new ApiError(ErrorCode.INVALID_BUNDLE_REFERENCE, 400, 'Invalid bundle reference'));
    }
    const finalizationId = admitRouteFinalizationId(params.finalizationId);
    if (!finalizationId) {
      return errorResponse(new ApiError(ErrorCode.INVALID_BUNDLE_REFERENCE, 400, 'Invalid bundle reference'));
    }
    const admitted = authenticateDeclaredHeaders(state, runtimeProfile, params.sessionId);
    if (admitted instanceof Response) return admitted;
    const { input, sessionId } = admitted;
    return {
      input,
      context: { ...state.baseContext, sessionId, finalizationId, artifactDeliveryDependencies },
    };
  };
  mountRoute(registration, app, routeMountRegistry[API_ROUTES.finalizationArtifactBundle.routeId], prepareArtifact);
  mountRoute(registration, app, routeMountRegistry[API_ROUTES.finalizationArtifactReport.routeId], prepareArtifact);

  mountRoute(registration, app, routeMountRegistry[API_ROUTES.recordVerificationObservation.routeId], async (state) => {
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateFinalizationSession(state, params);
    if (admitted instanceof Response) return admitted;
    const input = await parseDeclaredInput(state);
    if (input instanceof Response) return input;
    return { input, context: { ...state.baseContext, ...admitted } };
  });

  mountRoute(registration, app, routeMountRegistry[API_ROUTES.runVerification.routeId], async (state) => {
    const params = parsedLocation(state, 'params');
    const admitted = await authenticateFinalizationSession(state, params);
    if (admitted instanceof Response) return admitted;
    if (admitted.session.finalization?.state.status !== 'succeeded') {
      return errorResponse(ErrorCode.SESSION_NOT_FINALIZED);
    }
    const rate = await enforceFinalizeRateLimit(runtimeProfile, state.baseContext.clientIp);
    if (rate instanceof Response) return rate;
    const input = await parseDeclaredInput(state);
    if (input instanceof Response) return input;
    return {
      input,
      context: { ...state.baseContext, ...admitted, finalizeRateLimit: rate },
    };
  });
}

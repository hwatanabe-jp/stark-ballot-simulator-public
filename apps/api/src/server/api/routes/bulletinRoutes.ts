import { API_ROUTES } from '@stark-ballot/api-contract/routes';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { errorResponse } from '../../http/response';
import { isValidBulletinVoteId } from '../handlers/bulletin';
import { routeMountRegistry } from './honoBindings';
import {
  mountRoute,
  prepareSessionRead,
  parsedLocation,
  requireSameOrigin,
  type RouteRegistration,
  type ApiHonoApp,
} from './honoRegistration';

export function registerBulletinRoutes(app: ApiHonoApp, registration: RouteRegistration): void {
  mountRoute(registration, app, routeMountRegistry[API_ROUTES.sessionBulletin.routeId], async (state) => {
    const params = parsedLocation(state, 'params');
    return prepareSessionRead(state, params.sessionId);
  });

  mountRoute(
    registration,
    app,
    routeMountRegistry[API_ROUTES.sessionBulletinConsistencyProof.routeId],
    async (state) => {
      const params = parsedLocation(state, 'params');
      return prepareSessionRead(state, params.sessionId);
    },
  );

  mountRoute(registration, app, routeMountRegistry[API_ROUTES.sessionVoteInclusionProof.routeId], async (state) => {
    const params = parsedLocation(state, 'params');
    if (!isValidBulletinVoteId(params.voteId)) {
      return errorResponse(ErrorCode.INVALID_VOTE_ID);
    }
    return prepareSessionRead(state, params.sessionId);
  });

  mountRoute(registration, app, routeMountRegistry[API_ROUTES.sessionBulletinSth.routeId], async (state) => {
    const originFailure = requireSameOrigin(state.head.headers, state.baseContext.requestOrigin);
    if (originFailure) return originFailure;
    const params = parsedLocation(state, 'params');
    return prepareSessionRead(state, params.sessionId);
  });
}

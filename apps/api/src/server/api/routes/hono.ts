import { Hono } from 'hono';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';
import { validateEnv } from '@stark-ballot/runtime-config/env/validate';
import { handleApiError } from '../../http/errorHandler';
import { admitFinalizationCallbackRequest, finalizeCallbackHandler } from '../handlers/finalizeCallback';
import { getApiRouteDefinitions, type ApiRouteMode } from './definitions';
import {
  createArtifactDeliveryDependencies,
  type ArtifactDeliveryDependencyOverrides,
} from '../../composition/artifactDeliveryDependencies';
import {
  createFinalizationDependencies,
  type FinalizationDependencyOverrides,
} from '../../composition/finalizationDependencies';
import { registerRequestMiddleware, registerPublicCors } from './honoMiddleware';
import type { ApiHonoApp, ApiHonoEnv, RouteRegistration } from './honoRegistration';
export type { ApiHonoApp, ApiHonoEnv } from './honoRegistration';
export { defineRouteHandler, routeMountRegistry } from './honoBindings';
export { ORIGIN_VERIFY_HEADER } from '../security/developOperatorGate';
import { registerSessionRoutes } from './sessionRoutes';
import { registerFinalizationRoutes } from './finalizationRoutes';
import { registerVerificationRoutes } from './verificationRoutes';
import { registerBulletinRoutes } from './bulletinRoutes';

export interface HonoAppOptions {
  basePath?: string;
  mode?: ApiRouteMode;
  runtimeProfile?: ResolvedRuntimeProfile;
  finalizationDependencyOverrides?: FinalizationDependencyOverrides;
  artifactDeliveryDependencyOverrides?: ArtifactDeliveryDependencyOverrides;
}

export function createHonoApp(options: HonoAppOptions = {}): ApiHonoApp {
  const { basePath = '/api', mode = 'full' } = options;
  const runtimeProfile = options.runtimeProfile ?? resolveRuntimeProfile(process.env);
  validateEnv(runtimeProfile);
  const app = new Hono<ApiHonoEnv>().basePath(basePath);
  const finalizationDependencies = createFinalizationDependencies(
    runtimeProfile,
    options.finalizationDependencyOverrides,
  );
  const artifactDeliveryDependencies = createArtifactDeliveryDependencies(
    runtimeProfile,
    options.artifactDeliveryDependencyOverrides,
  );

  registerRequestMiddleware(app, runtimeProfile, basePath);
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
  registerPublicCors(app);
  // HEAD is not a public method; Hono must not dispatch it through GET handlers.
  app.use('*', async (context, next) => {
    if (context.req.method === 'HEAD') return context.notFound();
    return next();
  });

  const registration: RouteRegistration = {
    mode,
    runtimeProfile,
    mountedRouteIds: new Set(),
    getStore: () => getGlobalStore(runtimeProfile),
  };
  const sessions = new Hono<ApiHonoEnv>();
  registerSessionRoutes(sessions, registration);
  const finalizations = new Hono<ApiHonoEnv>();
  registerFinalizationRoutes(finalizations, registration, finalizationDependencies);
  const verification = new Hono<ApiHonoEnv>();
  registerVerificationRoutes(verification, registration, artifactDeliveryDependencies);
  const bulletin = new Hono<ApiHonoEnv>();
  registerBulletinRoutes(bulletin, registration);
  for (const child of [sessions, finalizations, verification, bulletin]) app.route('/', child);
  const expectedRouteIds = new Set(getApiRouteDefinitions(mode).map((route) => route.routeId));
  const missingRouteIds = [...expectedRouteIds].filter((routeId) => !registration.mountedRouteIds.has(routeId));
  const unexpectedRouteIds = [...registration.mountedRouteIds].filter((routeId) => !expectedRouteIds.has(routeId));
  if (missingRouteIds.length > 0 || unexpectedRouteIds.length > 0) {
    throw new Error(
      `API route mount mismatch: missing=[${missingRouteIds.join(',')}], unexpected=[${unexpectedRouteIds.join(',')}]`,
    );
  }
  return app;
}

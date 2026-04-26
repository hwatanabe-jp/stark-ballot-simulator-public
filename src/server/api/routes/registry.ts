import type { ApiHandler, ApiParams } from '@/server/api/context';
import { createNextRoute } from '@/server/api/routes/next';
import { getBitmapProofHandler } from '@/server/api/handlers/bitmapProof';
import { getBotDataHandler } from '@/server/api/handlers/botdata';
import {
  getBulletinHandler,
  getBulletinVoteProofHandler,
  getConsistencyProofHandler,
} from '@/server/api/handlers/bulletin';
import { cancelFinalizationHandler } from '@/server/api/handlers/finalizeCancel';
import { finalizeCallbackHandler } from '@/server/api/handlers/finalizeCallback';
import { finalizeSessionHandler } from '@/server/api/handlers/finalize';
import { getProgressHandler } from '@/server/api/handlers/progress';
import { createSessionHandler } from '@/server/api/handlers/session';
import { getSessionStatusHandler } from '@/server/api/handlers/sessionStatus';
import { getSthHandler } from '@/server/api/handlers/sth';
import { enableDebugLogHandler } from '@/server/api/handlers/debugLog';
import { getVerificationBundleHandler, getVerificationReportHandler } from '@/server/api/handlers/verificationBundles';
import { getVerifyHandler } from '@/server/api/handlers/verify';
import { runVerificationHandler } from '@/server/api/handlers/verificationRun';
import { submitVoteHandler } from '@/server/api/handlers/vote';
import { getZkvmInputHashHandler } from '@/server/api/handlers/zkvmInputHash';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export type ApiRouteKind = 'readonly' | 'mutation';
export type ApiRouteMode = 'full' | 'readonly' | 'lambda';

export interface ApiRouteDefinition {
  method: ApiMethod;
  path: string;
  kind: ApiRouteKind;
  handler: ApiHandler<ApiParams>;
  excludeFromLambda?: boolean;
}

function defineRoute<TParams extends ApiParams>(
  definition: Omit<ApiRouteDefinition, 'handler'> & {
    handler: ApiHandler<TParams>;
  },
): ApiRouteDefinition {
  return definition as ApiRouteDefinition;
}

const apiRoutes: ApiRouteDefinition[] = [
  defineRoute({ method: 'GET', path: '/debug/enable', kind: 'readonly', handler: enableDebugLogHandler }),
  defineRoute({ method: 'GET', path: '/progress', kind: 'readonly', handler: getProgressHandler }),
  defineRoute({ method: 'GET', path: '/verify', kind: 'readonly', handler: getVerifyHandler }),
  defineRoute({
    method: 'GET',
    path: '/sessions/:sessionId/status',
    kind: 'readonly',
    handler: getSessionStatusHandler,
  }),
  defineRoute({
    method: 'GET',
    path: '/verification/bundles/:sessionId/:executionId',
    kind: 'readonly',
    handler: getVerificationBundleHandler,
  }),
  defineRoute({
    method: 'GET',
    path: '/verification/bundles/:sessionId/:executionId/report',
    kind: 'readonly',
    handler: getVerificationReportHandler,
  }),
  defineRoute({ method: 'GET', path: '/bulletin', kind: 'readonly', handler: getBulletinHandler }),
  defineRoute({
    method: 'GET',
    path: '/bulletin/consistency-proof',
    kind: 'readonly',
    handler: getConsistencyProofHandler,
  }),
  defineRoute({
    method: 'GET',
    path: '/bulletin/:voteId/proof',
    kind: 'readonly',
    handler: getBulletinVoteProofHandler,
  }),
  defineRoute({ method: 'GET', path: '/botdata/:id', kind: 'readonly', handler: getBotDataHandler }),
  defineRoute({ method: 'GET', path: '/bitmap-proof', kind: 'readonly', handler: getBitmapProofHandler }),
  defineRoute({ method: 'GET', path: '/sth', kind: 'readonly', handler: getSthHandler }),
  defineRoute({ method: 'GET', path: '/zkvm-input-hash', kind: 'readonly', handler: getZkvmInputHashHandler }),
  defineRoute({ method: 'POST', path: '/session', kind: 'mutation', handler: createSessionHandler }),
  defineRoute({ method: 'POST', path: '/vote', kind: 'mutation', handler: submitVoteHandler }),
  defineRoute({ method: 'POST', path: '/finalize', kind: 'mutation', handler: finalizeSessionHandler }),
  defineRoute({ method: 'POST', path: '/finalize/cancel', kind: 'mutation', handler: cancelFinalizationHandler }),
  defineRoute({
    method: 'POST',
    path: '/finalize/callback',
    kind: 'mutation',
    handler: finalizeCallbackHandler,
    excludeFromLambda: true,
  }),
  defineRoute({ method: 'POST', path: '/verification/run', kind: 'mutation', handler: runVerificationHandler }),
];

export function getApiRouteDefinitions(mode: ApiRouteMode = 'full'): ApiRouteDefinition[] {
  if (mode === 'full') {
    return [...apiRoutes];
  }
  if (mode === 'lambda') {
    return apiRoutes.filter((route) => !route.excludeFromLambda);
  }
  return apiRoutes.filter((route) => route.kind === 'readonly');
}

export function findApiRoute(method: ApiMethod, path: string): ApiRouteDefinition {
  const match = apiRoutes.find((route) => route.method === method && route.path === path);
  if (!match) {
    throw new Error(`API route not registered: ${method} ${path}`);
  }
  return match;
}

export function createNextRouteFor(method: ApiMethod, path: string): ReturnType<typeof createNextRoute> {
  const route = findApiRoute(method, path);
  return createNextRoute(route.handler);
}

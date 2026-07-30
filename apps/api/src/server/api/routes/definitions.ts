import type { ApiHandler, ApiParams } from '../context';
import {
  getApiRouteContract,
  TARGET_API_ROUTE_CONTRACTS,
  type ApiRouteContract,
} from '@stark-ballot/api-contract/api-contract/routes';
import { getBitmapProofHandler } from '../handlers/bitmapProof';
import { getBulletinHandler, getBulletinVoteProofHandler, getConsistencyProofHandler } from '../handlers/bulletin';
import { cancelFinalizationHandler } from '../handlers/finalizeCancel';
import { finalizeCallbackHandler } from '../handlers/finalizeCallback';
import { finalizeSessionHandler } from '../handlers/finalize';
import { getProgressHandler } from '../handlers/progress';
import { createSessionHandler } from '../handlers/session';
import { getSessionStatusHandler } from '../handlers/sessionStatus';
import { getSthHandler } from '../handlers/sth';
import { getVerificationBundleHandler, getVerificationReportHandler } from '../handlers/verificationBundles';
import { getVerifyHandler } from '../handlers/verify';
import { submitVerificationObservationHandler } from '../handlers/verificationObservation';
import { runVerificationHandler } from '../handlers/verificationRun';
import { submitVoteHandler } from '../handlers/vote';
import { getZkvmInputHashHandler } from '../handlers/zkvmInputHash';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export type ApiRouteKind = 'readonly' | 'mutation';
export type ApiRouteMode = 'full' | 'readonly' | 'lambda';

export interface ApiRouteDefinition extends ApiRouteContract {
  handler: ApiHandler<ApiParams>;
  excludeFromLambda?: boolean;
}

type ApiRouteRegistration<TParams extends ApiParams> = {
  method: ApiMethod;
  path: string;
  kind: ApiRouteKind;
  handler: ApiHandler<TParams>;
  excludeFromLambda?: boolean;
};

function defineRoute<TParams extends ApiParams>(definition: ApiRouteRegistration<TParams>): ApiRouteDefinition {
  const contract = getApiRouteContract(definition.method, definition.path);
  return {
    ...contract,
    ...definition,
    handler: definition.handler as unknown as ApiHandler<ApiParams>,
  };
}

const apiRoutes: ApiRouteDefinition[] = [
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
  defineRoute({
    method: 'POST',
    path: '/verification/observation',
    kind: 'mutation',
    handler: submitVerificationObservationHandler,
  }),
];

export function getApiRouteDefinitions(mode: ApiRouteMode = 'full'): ApiRouteDefinition[] {
  if (mode === 'full') {
    return apiRoutes.filter((route) => route.lifecycle !== 'retired');
  }
  if (mode === 'lambda') {
    return apiRoutes.filter((route) => route.lifecycle === 'active' && !route.excludeFromLambda);
  }
  return apiRoutes.filter((route) => route.kind === 'readonly' && route.lifecycle === 'active');
}

export function getTargetApiRouteContracts(): ApiRouteContract[] {
  return [...TARGET_API_ROUTE_CONTRACTS];
}

export function findApiRoute(method: ApiMethod, path: string): ApiRouteDefinition {
  const match = apiRoutes.find((route) => route.method === method && route.path === path);
  if (!match) {
    throw new Error(`API route not registered: ${method} ${path}`);
  }
  return match;
}

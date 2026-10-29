import { API_ROUTES, type ApiRoute, type ApiRouteContract } from '@stark-ballot/api-contract/routes';
import type { ApiHandler, ApiHandlerContext, RawApiHandler } from '../context';
import { getCurrentFinalizationBitmapProofHandler } from '../handlers/bitmapProof';
import {
  getSessionBulletinConsistencyProofHandler,
  getSessionBulletinHandler,
  getSessionVoteInclusionProofHandler,
} from '../handlers/bulletin';
import { finalizeSessionHandler } from '../handlers/finalize';
import { cancelFinalizationHandler } from '../handlers/finalizeCancel';
import { getProgressHandler } from '../handlers/progress';
import { createSessionHandler } from '../handlers/session';
import { getCurrentFinalizationHandler } from '../handlers/currentFinalization';
import { getSessionBulletinSthHandler } from '../handlers/sth';
import { getVerificationBundleHandler, getVerificationReportHandler } from '../handlers/verificationBundles';
import { submitVerificationObservationHandler } from '../handlers/verificationObservation';
import { runVerificationHandler } from '../handlers/verificationRun';
import { getVerifyHandler } from '../handlers/verify';
import { submitVoteHandler } from '../handlers/vote';
import { getCurrentFinalizationInputCommitmentHandler } from '../handlers/inputCommitment';

export interface RouteHandlerBinding<TRoute extends ApiRouteContract, TContext extends ApiHandlerContext> {
  readonly route: TRoute;
  readonly handler: RawApiHandler<TRoute, TContext>;
}

export function defineRouteHandler<TRoute extends ApiRouteContract, TContext extends ApiHandlerContext>(
  route: TRoute,
  handler: ApiHandler<TRoute, TContext>,
): RouteHandlerBinding<TRoute, TContext> {
  return { route, handler };
}

function defineRawRouteHandler<TRoute extends ApiRouteContract, TContext extends ApiHandlerContext>(
  route: TRoute,
  handler: RawApiHandler<TRoute, TContext>,
): RouteHandlerBinding<TRoute, TContext> {
  return { route, handler };
}

export type RouteMountRegistry = {
  readonly [TRoute in ApiRoute as TRoute['routeId']]: {
    readonly route: TRoute;
    readonly handler: unknown;
  };
};

export const routeMountRegistry = {
  [API_ROUTES.progress.routeId]: defineRouteHandler(API_ROUTES.progress, getProgressHandler),
  [API_ROUTES.verification.routeId]: defineRouteHandler(API_ROUTES.verification, getVerifyHandler),
  [API_ROUTES.currentFinalization.routeId]: defineRouteHandler(
    API_ROUTES.currentFinalization,
    getCurrentFinalizationHandler,
  ),
  [API_ROUTES.finalizationArtifactBundle.routeId]: defineRawRouteHandler(
    API_ROUTES.finalizationArtifactBundle,
    getVerificationBundleHandler,
  ),
  [API_ROUTES.finalizationArtifactReport.routeId]: defineRawRouteHandler(
    API_ROUTES.finalizationArtifactReport,
    getVerificationReportHandler,
  ),
  [API_ROUTES.sessionBulletin.routeId]: defineRouteHandler(API_ROUTES.sessionBulletin, getSessionBulletinHandler),
  [API_ROUTES.sessionBulletinConsistencyProof.routeId]: defineRouteHandler(
    API_ROUTES.sessionBulletinConsistencyProof,
    getSessionBulletinConsistencyProofHandler,
  ),
  [API_ROUTES.sessionVoteInclusionProof.routeId]: defineRouteHandler(
    API_ROUTES.sessionVoteInclusionProof,
    getSessionVoteInclusionProofHandler,
  ),
  [API_ROUTES.currentFinalizationBitmapProof.routeId]: defineRawRouteHandler(
    API_ROUTES.currentFinalizationBitmapProof,
    getCurrentFinalizationBitmapProofHandler,
  ),
  [API_ROUTES.sessionBulletinSth.routeId]: defineRouteHandler(
    API_ROUTES.sessionBulletinSth,
    getSessionBulletinSthHandler,
  ),
  [API_ROUTES.currentFinalizationInputCommitment.routeId]: defineRouteHandler(
    API_ROUTES.currentFinalizationInputCommitment,
    getCurrentFinalizationInputCommitmentHandler,
  ),
  [API_ROUTES.createSession.routeId]: defineRouteHandler(API_ROUTES.createSession, createSessionHandler),
  [API_ROUTES.submitVote.routeId]: defineRouteHandler(API_ROUTES.submitVote, submitVoteHandler),
  [API_ROUTES.createFinalization.routeId]: defineRouteHandler(API_ROUTES.createFinalization, finalizeSessionHandler),
  [API_ROUTES.cancelFinalization.routeId]: defineRouteHandler(API_ROUTES.cancelFinalization, cancelFinalizationHandler),
  [API_ROUTES.recordVerificationObservation.routeId]: defineRouteHandler(
    API_ROUTES.recordVerificationObservation,
    submitVerificationObservationHandler,
  ),
  [API_ROUTES.runVerification.routeId]: defineRouteHandler(API_ROUTES.runVerification, runVerificationHandler),
} as const satisfies RouteMountRegistry;

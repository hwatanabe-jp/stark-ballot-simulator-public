import type { VerificationResultStore } from '@stark-ballot/application/finalize/finalization-result-store';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import type { ApplicationVoteStore } from '@stark-ballot/application/session/session-vote-store';
import type { RouteInput, RouteLike, RouteOutput } from '@stark-ballot/api-contract/routes';
import type { AwsFinalizationDeliveryMetadataStore } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type { AwsFinalizationRuntimeMetadataStore } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

declare const routeResponseBrand: unique symbol;

export type ApiContextStore = ApplicationVoteStore &
  FinalizationStore &
  VerificationResultStore &
  AwsFinalizationDeliveryMetadataStore &
  AwsFinalizationRuntimeMetadataStore;

/**
 * Trusted transport metadata and services supplied after route admission.
 *
 * Request data belongs in RouteInput. Keeping it out of this context prevents
 * handlers from reaching around the route contract to read undeclared values.
 */
export interface ApiHandlerContext {
  runtimeProfile: ResolvedRuntimeProfile;
  store: ApiContextStore;
  requestId: string;
  requestOrigin: string;
  clientIp?: string;
  operatorGatedDevelop: boolean;
}

export interface SessionAdmittedContext extends ApiHandlerContext {
  sessionId: SessionId;
  session: SessionReadModel;
}

export interface SessionIdentityContext extends ApiHandlerContext {
  sessionId: SessionId;
}

export interface SessionFinalizationAdmittedContext extends SessionAdmittedContext {
  finalizationId: FinalizationId;
}

export interface SessionFinalizationIdentityContext extends SessionIdentityContext {
  finalizationId: FinalizationId;
}

export interface ClientRateLimitedContext extends ApiHandlerContext {
  rateLimitClientIp: string;
}

export interface ApiHandlerArguments<TRoute extends RouteLike, TContext extends ApiHandlerContext = ApiHandlerContext> {
  input: RouteInput<TRoute>;
  context: TContext;
}

/** A response admitted against the exact route that produced it. */
export type RouteBoundResponse<TRoute extends RouteLike> = Response & {
  readonly [routeResponseBrand]: {
    readonly routeId: TRoute['routeId'];
    readonly output: RouteOutput<TRoute>;
  };
};

export type ApiHandler<TRoute extends RouteLike, TContext extends ApiHandlerContext = ApiHandlerContext> = (
  arguments_: ApiHandlerArguments<TRoute, TContext>,
) => Promise<RouteBoundResponse<TRoute>> | RouteBoundResponse<TRoute>;

/** Dedicated escape for artifact and conditional handlers with raw wire behavior. */
export type RawApiHandler<TRoute extends RouteLike, TContext extends ApiHandlerContext = ApiHandlerContext> = (
  arguments_: ApiHandlerArguments<TRoute, TContext>,
) => Promise<Response> | Response;

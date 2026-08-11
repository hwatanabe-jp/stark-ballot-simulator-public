import type { VerificationResultStore } from '@stark-ballot/application/finalize/finalization-result-store';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import type { SessionReadModel } from '@stark-ballot/application/session/session-read-model';
import type { RouteInput, RouteLike } from '@stark-ballot/api-contract/routes';
import type { AwsFinalizationDeliveryMetadataStore } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type { AwsFinalizationRuntimeMetadataStore } from '@stark-ballot/aws-adapters/finalize/finalizationRuntimeStore';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

export type ApiContextStore = VoteStore &
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
  sessionId: string;
  session: SessionReadModel;
}

export interface SessionIdentityContext extends ApiHandlerContext {
  sessionId: string;
}

export interface ClientRateLimitedContext extends ApiHandlerContext {
  rateLimitClientIp: string;
}

export interface ApiHandlerArguments<TRoute extends RouteLike, TContext extends ApiHandlerContext = ApiHandlerContext> {
  input: RouteInput<TRoute>;
  context: TContext;
}

export type ApiHandler<TRoute extends RouteLike, TContext extends ApiHandlerContext = ApiHandlerContext> = (
  arguments_: ApiHandlerArguments<TRoute, TContext>,
) => Promise<Response> | Response;

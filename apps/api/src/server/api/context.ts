import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationResultStore } from '@stark-ballot/application/finalize/finalization-result-store';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import type { AwsFinalizationDeliveryMetadataStore } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import type { HttpRequest } from '../http/types';

/**
 * Route params passed to API handlers.
 */
export type ApiParams = Record<string, string | string[]>;
export type ApiContextStore = VoteStore &
  FinalizationStore &
  FinalizationResultStore &
  AwsFinalizationDeliveryMetadataStore;

/**
 * Context injected into API handlers.
 */
export interface ApiContext<TParams extends ApiParams = ApiParams> {
  request: HttpRequest;
  store: ApiContextStore;
  params?: TParams;
  clientIp?: string;
}

/**
 * Framework-agnostic API handler signature.
 */
export type ApiHandler<TParams extends ApiParams = ApiParams> = (
  context: ApiContext<TParams>,
) => Promise<Response> | Response;

import { TARGET_API_ROUTE_CONTRACTS, type ApiRouteContract } from '@stark-ballot/api-contract/routes';

export type ApiRouteMode = 'full' | 'readonly' | 'lambda';

export function getApiRouteDefinitions(mode: ApiRouteMode = 'full'): ApiRouteContract[] {
  if (mode === 'full' || mode === 'lambda') {
    return [...TARGET_API_ROUTE_CONTRACTS];
  }
  return TARGET_API_ROUTE_CONTRACTS.filter((route) => route.kind === 'readonly');
}

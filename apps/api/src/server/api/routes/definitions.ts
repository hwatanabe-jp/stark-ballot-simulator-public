import {
  TARGET_API_ROUTE_CONTRACTS,
  getApiRouteContract,
  type ApiContractMethod,
  type ApiRouteContract,
} from '@stark-ballot/api-contract/routes';

export type ApiMethod = ApiContractMethod;
export type ApiRouteMode = 'full' | 'readonly' | 'lambda';

export function getApiRouteDefinitions(mode: ApiRouteMode = 'full'): ApiRouteContract[] {
  if (mode === 'full' || mode === 'lambda') {
    return [...TARGET_API_ROUTE_CONTRACTS];
  }
  return TARGET_API_ROUTE_CONTRACTS.filter((route) => route.kind === 'readonly');
}

export function getTargetApiRouteContracts(): ApiRouteContract[] {
  return [...TARGET_API_ROUTE_CONTRACTS];
}

export function findApiRoute(method: ApiMethod, path: string): ApiRouteContract {
  return getApiRouteContract(method, path);
}

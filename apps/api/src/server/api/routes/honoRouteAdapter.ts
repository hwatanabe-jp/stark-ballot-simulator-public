import type { ApiRouteContract, RouteInput, RouteLike } from '@stark-ballot/api-contract/routes';
import { parseFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { FinalizationId } from '@stark-ballot/application/finalize/finalization-types';
import { parseSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';
import type { RouteBoundResponse } from '../context';

export type RouteHead<TRoute extends ApiRouteContract> = Omit<RouteInput<TRoute>, 'body' | 'rawBody'>;

export type RouteLocation<TRoute extends ApiRouteContract, TLocation extends 'params' | 'query'> =
  RouteInput<TRoute> extends Record<TLocation, infer TValue> ? TValue : never;

/** Admit wire identifiers before they enter domain/application ports. */
export function admitRouteSessionId(value: unknown): SessionId | undefined {
  return parseSessionId(value);
}

export function admitRouteFinalizationId(value: unknown): FinalizationId | undefined {
  return parseFinalizationId(value);
}

/**
 * Audited assertion boundary for request parts already admitted by hono.ts.
 * Re-parsing is intentionally avoided because route schemas may transform wire
 * strings (for example a path vote index) into a different admitted type.
 */
export function admitRouteHead<TRoute extends ApiRouteContract>(
  route: TRoute,
  candidate: Readonly<Record<string, unknown>>,
): RouteHead<TRoute> {
  const admitted: Record<string, unknown> = {};
  for (const location of ['params', 'query', 'headers'] as const) {
    if (route.request[location] !== undefined) {
      if (!Object.hasOwn(candidate, location)) {
        throw new Error(`Route ${route.routeId} is missing admitted request ${location}`);
      }
      admitted[location] = candidate[location];
    }
  }
  return admitted as RouteHead<TRoute>;
}

export function admitBodylessRouteInput<TRoute extends ApiRouteContract>(
  route: TRoute,
  head: RouteHead<TRoute>,
): RouteInput<TRoute> {
  if (route.request.body !== undefined || route.request.rawBody !== undefined) {
    throw new Error(`Route ${route.routeId} requires a declared request body`);
  }
  return head as RouteInput<TRoute>;
}

export function admitJsonBodyRouteInput<TRoute extends ApiRouteContract>(
  route: TRoute,
  head: RouteHead<TRoute>,
  body: unknown,
): RouteInput<TRoute> {
  if (route.request.body === undefined) {
    throw new Error(`Route ${route.routeId} does not declare a JSON request body`);
  }
  return { ...head, body } as unknown as RouteInput<TRoute>;
}

export function admitRouteLocation<TRoute extends ApiRouteContract, TLocation extends 'params' | 'query'>(
  route: TRoute,
  locations: Readonly<Record<string, unknown>>,
  location: TLocation,
): RouteLocation<TRoute, TLocation> {
  if (route.request[location] === undefined || !Object.hasOwn(locations, location)) {
    throw new Error(`Route ${route.routeId} is missing admitted request ${location}`);
  }
  return locations[location] as RouteLocation<TRoute, TLocation>;
}

export function bindAdmittedRouteResponse<TRoute extends RouteLike>(
  route: TRoute,
  response: Response,
): RouteBoundResponse<TRoute> {
  if (!route.routeId || !(response instanceof Response)) {
    throw new Error('Cannot bind an invalid admitted route response');
  }
  return response as RouteBoundResponse<TRoute>;
}

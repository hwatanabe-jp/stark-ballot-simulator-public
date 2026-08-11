import { describe, expect, it } from 'vitest';
import { API_ROUTES, TARGET_API_ROUTE_CONTRACTS, buildApiRouteUrl, matchApiRoute } from '../routes';
import {
  CurrentFinalizationResponseSchema,
  FinalizationCancelRequestSchema,
  FinalizationResourceSchema,
  FinalizationResponseSchema,
} from './index';

const META = { requestId: 'request-finalization-contract' };
const FINALIZATION_ID = '01K19W7ZQK5PK0TQZDXJX1GJ5J';

const pendingResource = {
  finalizationId: FINALIZATION_ID,
  status: 'pending',
  queuedAtMs: 1_754_000_000_000,
  runtimeDiagnostics: {
    asyncMode: 'enabled',
    queue: {
      concurrencyLimit: 1,
      estimatedDurationMs: 30_000,
    },
  },
} as const;

describe('finalization resource contract', () => {
  it('uses one strict resource for create, current, and cancel responses', () => {
    expect(FinalizationResourceSchema.safeParse(pendingResource).success).toBe(true);
    expect(FinalizationResponseSchema.safeParse({ data: pendingResource, meta: META }).success).toBe(true);
    expect(CurrentFinalizationResponseSchema.safeParse({ data: null, meta: META }).success).toBe(true);
    expect(CurrentFinalizationResponseSchema.safeParse({ data: pendingResource, meta: META }).success).toBe(true);
  });

  it('rejects legacy identity, timestamp, locator, and aggregate fields', () => {
    for (const legacy of [
      { ...pendingResource, executionId: FINALIZATION_ID },
      { ...pendingResource, queuedAt: pendingResource.queuedAtMs },
      { ...pendingResource, statusUrl: '/api/sessions/session-1/status' },
      { ...pendingResource, executionArn: 'arn:aws:states:example' },
      { ...pendingResource, finalizationState: pendingResource },
    ]) {
      expect(FinalizationResourceSchema.safeParse(legacy).success).toBe(false);
    }
  });

  it('uses the finalization path identity for cancellation', () => {
    expect(FinalizationCancelRequestSchema.safeParse({}).success).toBe(true);
    expect(FinalizationCancelRequestSchema.safeParse({ reason: 'operator request' }).success).toBe(true);
    expect(
      FinalizationCancelRequestSchema.safeParse({
        finalizationId: FINALIZATION_ID,
      }).success,
    ).toBe(false);
    expect(
      FinalizationCancelRequestSchema.safeParse({
        executionId: FINALIZATION_ID,
      }).success,
    ).toBe(false);
  });

  it('exposes only resource-scoped finalization routes and keeps the callback out of the public inventory', () => {
    expect(API_ROUTES.createFinalization.routeId).toBe('sessions.finalizations.post');
    expect(API_ROUTES.currentFinalization.routeId).toBe('sessions.finalizations.current.get');
    expect(API_ROUTES.cancelFinalization.routeId).toBe('sessions.finalizations.cancel.post');
    expect(TARGET_API_ROUTE_CONTRACTS.some((route) => route.routeId.includes('Callback'))).toBe(false);
    expect(TARGET_API_ROUTE_CONTRACTS.some((route) => route.path.startsWith('/internal/'))).toBe(false);

    expect(
      buildApiRouteUrl(API_ROUTES.createFinalization, {
        params: { sessionId: 'session/one' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations');
    expect(
      buildApiRouteUrl(API_ROUTES.currentFinalization, {
        params: { sessionId: 'session/one' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations/current');
    expect(
      buildApiRouteUrl(API_ROUTES.cancelFinalization, {
        params: { sessionId: 'session/one', finalizationId: FINALIZATION_ID },
      }),
    ).toBe(`/api/sessions/session%2Fone/finalizations/${FINALIZATION_ID}/cancel`);

    for (const [method, path] of [
      ['POST', '/api/finalize'],
      ['POST', '/api/finalize/cancel'],
      ['GET', '/api/sessions/session-1/status'],
      ['POST', '/api/finalize/callback'],
    ] as const) {
      expect(matchApiRoute(method, path)).toBeNull();
    }
  });

  it('declares capability-only path admission', () => {
    for (const route of [
      API_ROUTES.createFinalization,
      API_ROUTES.currentFinalization,
      API_ROUTES.cancelFinalization,
    ]) {
      expect(route.authScope).toBe('path-session-capability');
      expect(route.capabilityScope).toBe('path');
      expect(Object.keys(route.request.headers.shape)).toEqual(['X-Session-Capability']);
      expect(
        route.request.headers.safeParse({
          'X-Session-Capability': 'capability-token',
          'X-Session-ID': 'session-1',
        }).success,
      ).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { FinalizationArtifactParamsSchema } from './artifacts';
import { API_ROUTES, buildApiRouteUrl, matchApiRoute } from '../routes';

describe('artifact delivery contract', () => {
  it('owns only the finalization-scoped bundle and report resources', () => {
    expect(API_ROUTES.finalizationArtifactBundle).toMatchObject({
      routeId: 'sessions.finalizations.artifacts.bundle.get',
      method: 'GET',
      path: '/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle',
      authScope: 'path-session-capability',
      capabilityScope: 'path',
    });
    expect(API_ROUTES.finalizationArtifactReport).toMatchObject({
      routeId: 'sessions.finalizations.artifacts.report.get',
      method: 'GET',
      path: '/sessions/:sessionId/finalizations/:finalizationId/artifacts/report',
      authScope: 'path-session-capability',
      capabilityScope: 'path',
    });

    expect(
      buildApiRouteUrl(API_ROUTES.finalizationArtifactBundle, {
        params: { sessionId: 'session/one', finalizationId: 'finalization/one' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations/finalization%2Fone/artifacts/bundle');
    expect(
      buildApiRouteUrl(API_ROUTES.finalizationArtifactReport, {
        params: { sessionId: 'session/one', finalizationId: 'finalization/one' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations/finalization%2Fone/artifacts/report');

    for (const oldPath of [
      '/api/verification/bundles/session-1/finalization-1',
      '/api/verification/bundles/session-1/finalization-1/report',
    ]) {
      expect(matchApiRoute('GET', oldPath)).toBeNull();
    }
  });

  it('uses exact path identity and capability-only request headers', () => {
    expect(
      FinalizationArtifactParamsSchema.parse({
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
      }),
    ).toEqual({
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
    });

    expect(Object.keys(API_ROUTES.finalizationArtifactBundle.request.headers.shape)).toEqual([
      'X-Session-Capability',
      'Range',
    ]);
    expect(Object.keys(API_ROUTES.finalizationArtifactReport.request.headers.shape)).toEqual(['X-Session-Capability']);
  });
});

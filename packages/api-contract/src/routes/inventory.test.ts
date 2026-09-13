import { describe, expect, it } from 'vitest';
import { s } from '@stark-ballot/validation/schema';
import {
  BulletinQuerySchema,
  FinalizationCancelRequestSchema,
  SessionResponseSchema,
  VerificationObservationRequestSchema,
  VerificationObservationResponseSchema,
  VerificationResourceResponseSchema,
} from '../schemas';
import {
  API_ROUTES,
  TARGET_API_ROUTE_CONTRACTS,
  buildApiRouteUrl,
  getApiRouteContract,
  jsonResponse,
  matchApiRoute,
  type ApiRouteContract,
} from './index';

const routeKey = (method: string, path: string): string => `${method} ${path}`;
const partialRouteKey = (route: Partial<ApiRouteContract>): string =>
  `${route.method ?? 'UNKNOWN'} ${route.path ?? 'UNKNOWN'}`;

function schemasFor(route: ApiRouteContract): unknown[] {
  const schemas: unknown[] = [];
  const requestSchemas: readonly unknown[] = [
    route.request.params,
    route.request.query,
    route.request.headers,
    route.request.body,
  ];
  for (const schema of requestSchemas) {
    if (schema !== undefined) {
      schemas.push(schema);
    }
  }
  for (const response of route.responses) {
    if ('schema' in response) {
      const schema: unknown = response.schema;
      schemas.push(schema);
    }
  }
  return schemas;
}

describe('typed API route inventory', () => {
  it('owns each target route once under a semantic registry key', () => {
    expect(Object.keys(API_ROUTES)).toEqual([
      'progress',
      'verification',
      'currentFinalization',
      'finalizationArtifactBundle',
      'finalizationArtifactReport',
      'sessionBulletin',
      'sessionBulletinConsistencyProof',
      'sessionVoteInclusionProof',
      'currentFinalizationBitmapProof',
      'sessionBulletinSth',
      'currentFinalizationInputCommitment',
      'createSession',
      'submitVote',
      'createFinalization',
      'cancelFinalization',
      'recordVerificationObservation',
      'runVerification',
    ]);
  });

  it('carries schema objects rather than schema export names', () => {
    for (const route of TARGET_API_ROUTE_CONTRACTS) {
      for (const [location, schema] of Object.entries(route.request)) {
        if (location !== 'rawBody' && location !== 'emptyBody') {
          expect(schema).toBeInstanceOf(s.Schema);
        }
      }
      for (const response of route.responses) {
        if ('schema' in response) {
          expect(response.schema).toBeInstanceOf(s.Schema);
        }
      }
    }
  });

  it('keeps the internal callback outside the public contract inventory', () => {
    expect('finalizationCallback' in API_ROUTES).toBe(false);
    expect(matchApiRoute('POST', '/api/internal/sessions/session-1/finalizations/finalization-1/callback')).toBeNull();
  });

  it('declares the session route empty-body admission as an empty object', () => {
    expect(API_ROUTES.createSession.request.body).toBeInstanceOf(s.Schema);
    expect(API_ROUTES.createSession.request.emptyBody).toBe('empty-object');
  });

  it('declares route-specific headers used by request admission and handlers', () => {
    expect(Object.keys(API_ROUTES.finalizationArtifactBundle.request.headers.shape)).toEqual([
      'X-Session-Capability',
      'Range',
    ]);
    expect(Object.keys(API_ROUTES.currentFinalizationBitmapProof.request.headers.shape)).toEqual([
      'X-Session-Capability',
      'If-None-Match',
    ]);
    expect(Object.keys(API_ROUTES.sessionBulletinSth.request.headers.shape)).toEqual([
      'X-Session-Capability',
      'Origin',
      'Sec-Fetch-Site',
    ]);
    expect(Object.keys(API_ROUTES.createFinalization.request.headers.shape)).toEqual(['X-Session-Capability']);
    expect(Object.keys(API_ROUTES.currentFinalization.request.headers.shape)).toEqual(['X-Session-Capability']);
    expect(Object.keys(API_ROUTES.progress.request.headers.shape)).toEqual(['X-Session-Capability']);
    expect(Object.keys(API_ROUTES.submitVote.request.headers.shape)).toEqual(['X-Session-Capability']);
  });

  it('builds browser paths and serializes parsed query values to the current wire', () => {
    expect(
      buildApiRouteUrl(API_ROUTES.currentFinalization, {
        params: { sessionId: 'session/one' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations/current');
    expect(
      buildApiRouteUrl(API_ROUTES.verification, {
        params: { sessionId: 'session/one', finalizationId: 'finalization/one' },
        query: { include: 'journal' },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations/finalization%2Fone/verification?include=journal');
    expect(
      buildApiRouteUrl(API_ROUTES.sessionBulletin, {
        params: { sessionId: 'session/one' },
        query: { offset: 2, limit: 50 },
      }),
    ).toBe('/api/sessions/session%2Fone/bulletin?offset=2&limit=50');
    expect(
      buildApiRouteUrl(API_ROUTES.currentFinalizationBitmapProof, {
        params: { sessionId: 'session/one', kind: 'seen', voteIndex: 7 },
      }),
    ).toBe('/api/sessions/session%2Fone/finalizations/current/bitmap-proofs/seen/7');
  });

  it('matches static routes before parameterized siblings', () => {
    expect(matchApiRoute('GET', '/api/sessions/session-1/bulletin/consistency-proof')).toMatchObject({
      route: API_ROUTES.sessionBulletinConsistencyProof,
      params: { sessionId: 'session-1' },
    });
    expect(matchApiRoute('GET', '/api/sessions/session-1/votes/vote-1/inclusion-proof')).toMatchObject({
      route: API_ROUTES.sessionVoteInclusionProof,
      params: { sessionId: 'session-1', voteId: 'vote-1' },
    });
    expect(matchApiRoute('GET', '/api/sessions/session-1/finalizations/finalization-1/artifacts/report')).toMatchObject(
      {
        route: API_ROUTES.finalizationArtifactReport,
        params: { sessionId: 'session-1', finalizationId: 'finalization-1' },
      },
    );
    expect(matchApiRoute('GET', '/api/sessions/session-1/finalizations/finalization-1/artifacts/bundle')).toMatchObject(
      {
        route: API_ROUTES.finalizationArtifactBundle,
        params: { sessionId: 'session-1', finalizationId: 'finalization-1' },
      },
    );
  });

  it('looks up the canonical object without duplicating method and path', () => {
    expect(getApiRouteContract('POST', '/sessions/:sessionId/votes')).toBe(API_ROUTES.submitVote);
    expect(() => getApiRouteContract('POST', '/missing')).toThrow('API contract route not registered: POST /missing');
  });

  it('exposes all six evidence resources without route aliases', () => {
    expect(API_ROUTES.sessionBulletin.routeId).toBe('sessions.bulletin.get');
    expect(API_ROUTES.sessionBulletinConsistencyProof.routeId).toBe('sessions.bulletin.consistencyProof.get');
    expect(API_ROUTES.sessionVoteInclusionProof.routeId).toBe('sessions.votes.inclusionProof.get');
    expect(API_ROUTES.sessionBulletinSth.routeId).toBe('sessions.bulletin.sth.get');
    expect(API_ROUTES.currentFinalizationBitmapProof.routeId).toBe('sessions.finalizations.current.bitmapProof.get');
    expect(API_ROUTES.currentFinalizationInputCommitment.routeId).toBe(
      'sessions.finalizations.current.inputCommitment.get',
    );

    for (const oldPath of [
      '/api/bulletin',
      '/api/bulletin/consistency-proof',
      '/api/bulletin/vote-1/proof',
      '/api/sth',
      '/api/bitmap-proof',
      '/api/zkvm-input-hash',
    ]) {
      expect(matchApiRoute('GET', oldPath)).toBeNull();
    }
    expect(API_ROUTES.currentFinalizationInputCommitment.request).not.toHaveProperty('query');
    expect(API_ROUTES.currentFinalizationInputCommitment).not.toHaveProperty('variants');
  });

  it('classifies every target route with lifecycle, auth, capability, and data boundary metadata', () => {
    const contracts: readonly ApiRouteContract[] = TARGET_API_ROUTE_CONTRACTS;
    const failures = contracts.flatMap((route) => {
      const missing: string[] = [];
      if (route.admissionControls.length === 0) {
        missing.push('admissionControls');
      }
      if (route.capabilityScope !== 'none' && !route.authScope.includes('session-capability')) {
        missing.push('capability scope requires session-capability auth scope');
      }
      return missing.map((field) => `${routeKey(route.method, route.path)}: ${field}`);
    });

    expect(failures).toEqual([]);
  });

  it('records stable route IDs and typed request/response/error metadata for every route', () => {
    const contracts: readonly Partial<ApiRouteContract>[] = TARGET_API_ROUTE_CONTRACTS;
    const routeIds = new Set<string>();
    const failures = contracts.flatMap((route) => {
      const missing: string[] = [];
      if (!route.routeId) {
        missing.push('routeId');
      } else if (routeIds.has(route.routeId)) {
        missing.push(`duplicate routeId ${route.routeId}`);
      } else {
        routeIds.add(route.routeId);
      }
      if (!route.request) {
        missing.push('request');
      }
      if (!route.responses || route.responses.length === 0) {
        missing.push('responses');
      }
      if (
        !route.publicErrors ||
        route.publicErrors.responses.length === 0 ||
        (route.publicErrors.codes.length === 0 && route.publicErrors.envelope !== 'plain-text')
      ) {
        missing.push('publicErrors');
      }
      return missing.map((field) => `${partialRouteKey(route)}: ${field}`);
    });

    expect(failures).toEqual([]);
  });

  it('binds every public error code to its status, content type, and concrete envelope', () => {
    for (const route of TARGET_API_ROUTE_CONTRACTS) {
      const responses = route.publicErrors.responses;
      const derivedCodes = Array.from(new Set(responses.map((response) => response.code)));
      const concreteEnvelopes = Array.from(new Set(responses.map((response) => response.envelope)));
      const expectedSummaryEnvelope = concreteEnvelopes.length === 1 ? concreteEnvelopes[0] : 'mixed-error-envelopes';

      expect(responses, routeKey(route.method, route.path)).not.toHaveLength(0);
      expect(route.publicErrors.codes, routeKey(route.method, route.path)).toEqual(derivedCodes);
      expect(route.publicErrors.envelope, routeKey(route.method, route.path)).toBe(expectedSummaryEnvelope);
      expect(route.publicErrorShape, routeKey(route.method, route.path)).toBe(route.publicErrors.envelope);

      for (const response of responses) {
        const responseLabel = `${routeKey(route.method, route.path)}: ${response.case ?? response.code}`;
        expect(Object.hasOwn(response, 'status'), responseLabel).toBe(true);
        if (typeof response.status === 'number') {
          expect(Number.isInteger(response.status), responseLabel).toBe(true);
          expect(response.status, responseLabel).toBeGreaterThanOrEqual(100);
          expect(response.status, responseLabel).toBeLessThanOrEqual(599);
        }
        expect(['application/json', 'text/plain; charset=UTF-8']).toContain(response.contentType);
        expect(response.envelope).not.toBe('mixed-error-envelopes');
      }
    }
  });

  it('uses current mounted error codes instead of historical aliases', () => {
    const allCodes = TARGET_API_ROUTE_CONTRACTS.flatMap((route) => route.publicErrors.codes);

    expect(allCodes).not.toContain('TURNSTILE_FAILED');
    expect(allCodes).not.toContain('RATE_LIMITED');
    expect(allCodes).not.toContain('MISSING_SESSION_ID');
    expect(allCodes).not.toContain('VERIFICATION_BUNDLE_UNAVAILABLE');
    expect(allCodes).not.toContain('EXPECTED_IMAGE_ID_UNAVAILABLE');
    expect(allCodes).not.toContain('CALLBACK_AUTH_REQUIRED');
    expect(allCodes).not.toContain('INVALID_CALLBACK_PAYLOAD');

    for (const path of ['/sessions', '/sessions/:sessionId/votes', '/sessions/:sessionId/finalizations']) {
      const errors = getApiRouteContract('POST', path).publicErrors;
      expect(errors.codes).toContain('CAPTCHA_FAILED');
      expect(errors.responses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'CAPTCHA_FAILED', status: 403 }),
          expect.objectContaining({
            code: 'CAPTCHA_FAILED',
            case: 'turnstile-upstream-rejection',
            status: 'upstream-response-status',
          }),
        ]),
      );
    }
    for (const path of [
      '/sessions',
      '/sessions/:sessionId/votes',
      '/sessions/:sessionId/finalizations',
      '/sessions/:sessionId/finalizations/:finalizationId/cancel',
      '/sessions/:sessionId/finalizations/:finalizationId/verification',
    ]) {
      const errors = getApiRouteContract('POST', path).publicErrors;
      expect(errors.codes).toContain('GLOBAL_LIMIT_EXCEEDED');
      expect(errors.responses).toContainEqual(expect.objectContaining({ code: 'GLOBAL_LIMIT_EXCEEDED', status: 503 }));
    }
    for (const path of [
      '/sessions/:sessionId/finalizations',
      '/sessions/:sessionId/finalizations/:finalizationId/verification',
    ]) {
      const errors = getApiRouteContract('POST', path).publicErrors;
      expect(errors.codes).toContain('ZKVM_RATE_LIMIT_EXCEEDED');
      expect(errors.responses).toContainEqual(
        expect.objectContaining({ code: 'ZKVM_RATE_LIMIT_EXCEEDED', status: 429 }),
      );
    }
  });

  it('records current vote-proof and verification-run failures without public callback metadata', () => {
    const voteProof = getApiRouteContract('GET', '/sessions/:sessionId/votes/:voteId/inclusion-proof');
    expect(voteProof.publicErrors.codes).toEqual(
      expect.arrayContaining(['INVALID_VOTE_ID', 'VOTE_NOT_FOUND', 'VERIFICATION_FAILED', 'SESSION_NOT_FINALIZED']),
    );
    expect(voteProof.publicErrors.codes).not.toContain('CT_PROOF_UNAVAILABLE');
    expect(voteProof.publicErrors.codes).not.toContain('INVALID_FINALIZATION_ARTIFACT');
    expect(voteProof.publicErrors.responses).toContainEqual(
      expect.objectContaining({
        code: 'VERIFICATION_FAILED',
        case: 'ct-proof-unavailable',
        status: 400,
        contentType: 'application/json',
        envelope: 'standard-error-envelope',
      }),
    );

    const verificationRun = getApiRouteContract(
      'POST',
      '/sessions/:sessionId/finalizations/:finalizationId/verification',
    );
    expect(verificationRun.publicErrors.codes).toEqual(
      expect.arrayContaining([
        'SESSION_NOT_FINALIZED',
        'GLOBAL_LIMIT_EXCEEDED',
        'ZKVM_RATE_LIMIT_EXCEEDED',
        'PAYLOAD_TOO_LARGE',
      ]),
    );
    expect(verificationRun.publicErrors.codes).not.toContain('INVALID_FINALIZATION_ARTIFACT');

    expect(TARGET_API_ROUTE_CONTRACTS.some((route) => route.path.startsWith('/internal/'))).toBe(false);
  });

  it('records explicit route admission metadata instead of only free-form controls', () => {
    const contracts: readonly Partial<ApiRouteContract>[] = TARGET_API_ROUTE_CONTRACTS;
    const failures = contracts.flatMap((route) => {
      const missing: string[] = [];
      if (!route.bodySize) {
        missing.push('bodySize');
      }
      if (!route.sourceIp) {
        missing.push('sourceIp');
      }
      if (!route.productionBypass) {
        missing.push('productionBypass');
      }
      if (route.kind === 'mutation') {
        if (!route.rateLimit) {
          missing.push('rateLimit');
        }
        if (!route.turnstile) {
          missing.push('turnstile');
        }
      }
      return missing.map((field) => `${partialRouteKey(route)}: ${field}`);
    });

    expect(failures).toEqual([]);
  });

  it('records the mounted client-IP and global rate-limit scopes without a session-key claim', () => {
    expect(getApiRouteContract('POST', '/sessions/:sessionId/votes').rateLimit).toMatchObject({
      required: true,
      scope: 'client-ip',
    });
    expect(
      getApiRouteContract('POST', '/sessions/:sessionId/finalizations/:finalizationId/cancel').rateLimit,
    ).toMatchObject({ required: true, scope: 'client-ip' });
    for (const path of [
      '/sessions/:sessionId/finalizations',
      '/sessions/:sessionId/finalizations/:finalizationId/verification',
    ]) {
      expect(getApiRouteContract('POST', path).rateLimit).toMatchObject({
        required: true,
        scope: 'client-ip-and-global',
      });
    }
  });

  it('does not advertise the unreachable cancellation-unsupported response', () => {
    const cancel = getApiRouteContract('POST', '/sessions/:sessionId/finalizations/:finalizationId/cancel');

    expect(cancel.publicErrors.responses).not.toContainEqual(
      expect.objectContaining({ code: 'CANCELLATION_UNSUPPORTED', status: 501 }),
    );
  });

  it('records browser-equivalent Turnstile body token metadata for public mutation routes', () => {
    const tokenLocations = ['body.turnstileToken'];

    expect(getApiRouteContract('POST', '/sessions').turnstile).toMatchObject({
      required: true,
      action: 'session',
      tokenLocations,
      productionBypass: 'deny-outside-approved-non-production',
    });
    expect(getApiRouteContract('POST', '/sessions/:sessionId/votes').turnstile).toMatchObject({
      required: true,
      action: 'vote',
      tokenLocations,
      productionBypass: 'deny-outside-approved-non-production',
    });
    expect(getApiRouteContract('POST', '/sessions/:sessionId/finalizations').turnstile).toMatchObject({
      required: true,
      action: 'finalize',
      tokenLocations,
      productionBypass: 'deny-outside-approved-non-production',
    });
  });

  it('records response schema coverage for active JSON routes', () => {
    const contracts: readonly ApiRouteContract[] = TARGET_API_ROUTE_CONTRACTS;
    const missing = contracts
      .filter((route) => route.lifecycle === 'active')
      .flatMap((route) =>
        route.responses
          .filter((response) => !('schema' in response) && !response.exemptReason)
          .map((response) => `${routeKey(route.method, route.path)}: ${response.status}`),
      );

    expect(missing).toEqual([]);
  });

  it('carries every referenced contract schema as an actual schema object', () => {
    const unresolved = TARGET_API_ROUTE_CONTRACTS.flatMap((route) =>
      schemasFor(route)
        .filter((schema) => !(schema instanceof s.Schema))
        .map(() => routeKey(route.method, route.path)),
    );

    expect(unresolved).toEqual([]);
  });

  it('records request schema coverage for active mutation routes', () => {
    const contracts: readonly ApiRouteContract[] = TARGET_API_ROUTE_CONTRACTS;
    const missing = contracts
      .filter((route) => route.kind === 'mutation')
      .filter((route) => Reflect.get(route.request, 'body') === undefined)
      .map((route) => routeKey(route.method, route.path));

    expect(missing).toEqual([]);
  });

  it('excludes the internal callback from target routes', () => {
    expect(TARGET_API_ROUTE_CONTRACTS.some((route) => route.path.includes('/internal/'))).toBe(false);
  });

  it('keeps required session metadata in the target session response contract', () => {
    const session = getApiRouteContract('POST', '/sessions');

    expect(session.responses).toEqual([jsonResponse(200, SessionResponseSchema)]);
    expect(session.admissionControls).toEqual(
      expect.arrayContaining(['turnstile-session-action', 'rate-limit', 'capability-issuance']),
    );
  });

  it('records one availability-discriminated verification response schema', () => {
    const verification = getApiRouteContract('GET', '/sessions/:sessionId/finalizations/:finalizationId/verification');

    expect(verification.responses).toEqual([jsonResponse(200, VerificationResourceResponseSchema)]);
  });

  it('records the operator-gated develop session admission decision', () => {
    const session = getApiRouteContract('POST', '/sessions');

    expect(session.targetAdmission).toEqual({
      nonOperatorDevelop: 'blocked-by-outer-operator-gate',
      operatorGatedDevelop: 'enabled-for-production-equivalent-smoke',
      ungatedPublic: 'requires-explicit-public-enable-and-server-turnstile',
      runtimeEnforcementHandoff: 'trusted-proxy-and-public-admission',
    });
    expect(session.admissionControls).toEqual(
      expect.arrayContaining([
        'operator-gated-develop-session-create',
        'non-operator-develop-gate',
        'ungated-public-server-turnstile-required',
      ]),
    );
  });

  it('records semantic finalization admission controls on verification-support routes', () => {
    expect(getApiRouteContract('GET', '/sessions/:sessionId/bulletin/sth').admissionControls).toEqual(
      expect.arrayContaining(['path-session-capability', 'same-origin', 'finalized-session', 'finalization-authority']),
    );
    expect(
      getApiRouteContract('POST', '/sessions/:sessionId/finalizations/:finalizationId/verification').admissionControls,
    ).toEqual(
      expect.arrayContaining([
        'path-session-capability',
        'finalization-id',
        'finalized-session',
        'finalization-authority',
        'expected-image-id',
      ]),
    );
    const observation = getApiRouteContract(
      'POST',
      '/sessions/:sessionId/finalizations/:finalizationId/verification/observations',
    );
    expect(observation).toMatchObject({
      routeId: 'sessions.finalizations.verification.observations.post',
      authScope: 'path-session-capability',
      capabilityScope: 'path',
      rateLimit: {
        required: false,
        scope: 'none',
        sourceIpDependency: 'not-required',
      },
    });
    expect(observation.request).toMatchObject({
      body: VerificationObservationRequestSchema,
    });
    expect(observation.responses).toEqual([jsonResponse(200, VerificationObservationResponseSchema)]);
    expect(observation.admissionControls).toEqual(
      expect.arrayContaining([
        'path-session-capability',
        'api-gateway-default-throttle',
        'body-size',
        'malformed-json',
        'finalized-session',
        'finalization-authority',
        'finalization-id',
        'durable-observation-cas',
      ]),
    );
    expect(observation.publicErrors.codes).toEqual(
      expect.arrayContaining(['INVALID_REQUEST', 'SESSION_NOT_FOUND', 'SESSION_NOT_FINALIZED', 'USER_NOT_VOTED']),
    );
    expect(observation.publicErrors.codes).not.toContain('INVALID_FINALIZATION_ARTIFACT');

    for (const [method, path] of [
      ['GET', '/sessions/:sessionId/finalizations/:finalizationId/verification'],
      ['POST', '/sessions/:sessionId/finalizations/:finalizationId/verification'],
      ['POST', '/sessions/:sessionId/finalizations/:finalizationId/verification/observations'],
    ] as const) {
      expect(getApiRouteContract(method, path).publicErrors.codes).toContain('SESSION_NOT_FOUND');
    }

    const consistencyProofRoute = getApiRouteContract('GET', '/sessions/:sessionId/bulletin/consistency-proof');
    expect(consistencyProofRoute.admissionControls).toEqual([
      'path-session-capability',
      'range-validation',
      'root-history',
    ]);
    expect(consistencyProofRoute.admissionControls).not.toContain('finalized-session');
    expect(consistencyProofRoute.publicErrors.codes).not.toContain('INVALID_FINALIZATION_ARTIFACT');

    const voteProofRoute = getApiRouteContract('GET', '/sessions/:sessionId/votes/:voteId/inclusion-proof');
    expect(voteProofRoute.admissionControls).toEqual(
      expect.arrayContaining(['path-session-capability', 'finalized-session', 'finalization-authority']),
    );
    expect(voteProofRoute.publicErrors.codes).toContain('SESSION_NOT_FINALIZED');
    expect(voteProofRoute.publicErrors.codes).not.toContain('INVALID_FINALIZATION_ARTIFACT');
  });

  it('documents bulletin paging query parameters', () => {
    expect(getApiRouteContract('GET', '/sessions/:sessionId/bulletin').request).toMatchObject({
      query: BulletinQuerySchema,
    });
  });

  it('records mutation request parsing, rate-limit, and route-specific controls', () => {
    expect(getApiRouteContract('POST', '/sessions').admissionControls).toEqual(
      expect.arrayContaining(['body-size', 'malformed-json', 'turnstile-session-action', 'rate-limit']),
    );
    expect(getApiRouteContract('POST', '/sessions/:sessionId/votes').admissionControls).toEqual(
      expect.arrayContaining(['body-size', 'malformed-json', 'turnstile-vote-action', 'rate-limit', 'duplicate-vote']),
    );
    expect(getApiRouteContract('POST', '/sessions/:sessionId/finalizations').admissionControls).toEqual(
      expect.arrayContaining([
        'body-size',
        'malformed-json',
        'turnstile-finalize-action',
        'rate-limit',
        'finalized-session',
        'finalization-transition-policy',
      ]),
    );
    expect(getApiRouteContract('POST', '/sessions/:sessionId/finalizations').publicErrors.codes).toContain(
      'INVALID_IMAGE_ID',
    );
    expect(getApiRouteContract('POST', '/sessions/:sessionId/finalizations').publicErrors.codes).toContain(
      'INVALID_FINALIZATION_ARTIFACT',
    );
    expect(
      getApiRouteContract('POST', '/sessions/:sessionId/finalizations/:finalizationId/cancel').admissionControls,
    ).toEqual(expect.arrayContaining(['body-size', 'malformed-json', 'rate-limit', 'finalization-id']));
    expect(
      getApiRouteContract('POST', '/sessions/:sessionId/finalizations/:finalizationId/cancel').request,
    ).toMatchObject({
      body: FinalizationCancelRequestSchema,
    });
    expect(
      getApiRouteContract('POST', '/sessions/:sessionId/finalizations/:finalizationId/verification').admissionControls,
    ).toEqual(expect.arrayContaining(['body-size', 'malformed-json', 'rate-limit']));
    expect(
      getApiRouteContract('POST', '/sessions/:sessionId/finalizations/:finalizationId/verification/observations')
        .admissionControls,
    ).not.toContain('rate-limit');
  });
});

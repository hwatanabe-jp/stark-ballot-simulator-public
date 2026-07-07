import { describe, expect, it } from 'vitest';
import { s, type SchemaTypeAny } from '@stark-ballot/validation/schema';
import * as apiSchemas from '@stark-ballot/api-contract/validation/apiSchemas';
import {
  TARGET_API_ROUTE_CONTRACTS,
  getApiRouteContract,
  isRetiredTargetRouteVariant,
  type ApiRouteContract,
} from './routes';

const routeKey = (method: string, path: string): string => `${method} ${path}`;
const partialRouteKey = (route: Partial<ApiRouteContract>): string =>
  `${route.method ?? 'UNKNOWN'} ${route.path ?? 'UNKNOWN'}`;
const schemaExports = apiSchemas as Record<string, unknown>;

function schemaNamesFor(route: ApiRouteContract): string[] {
  const requestSchemaNames: string[] = [];
  for (const schemaName of [
    route.requestSchemas.params,
    route.requestSchemas.query,
    route.requestSchemas.headers,
    route.requestSchemas.body,
  ]) {
    if (schemaName) {
      requestSchemaNames.push(schemaName);
    }
  }
  const responseSchemaNames = route.responseSchemas.flatMap((response) => (response.schema ? [response.schema] : []));
  return [...requestSchemaNames, ...responseSchemaNames];
}

function isSchema(value: unknown): value is SchemaTypeAny {
  return value instanceof s.Schema;
}

describe('target API route contract', () => {
  it('classifies every target route with lifecycle, auth, capability, and data boundary metadata', () => {
    const contracts: readonly ApiRouteContract[] = TARGET_API_ROUTE_CONTRACTS;
    const failures = contracts.flatMap((route) => {
      const missing: string[] = [];
      if (route.admissionControls.length === 0) {
        missing.push('admissionControls');
      }
      if (route.lifecycle === 'active' && route.dataClassification === 'retired-private') {
        missing.push('active route cannot use retired-private classification');
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
      if (!route.requestSchemas) {
        missing.push('requestSchemas');
      }
      if (!route.responseSchemas || route.responseSchemas.length === 0) {
        missing.push('responseSchemas');
      }
      if (!route.publicErrors || route.publicErrors.codes.length === 0) {
        missing.push('publicErrors');
      }
      return missing.map((field) => `${partialRouteKey(route)}: ${field}`);
    });

    expect(failures).toEqual([]);
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

  it('records browser-equivalent Turnstile body token metadata for public mutation routes', () => {
    const tokenLocations = ['body.turnstileToken', 'body.cf-turnstile-response', 'body.cfTurnstileResponse'];

    expect(getApiRouteContract('POST', '/session').turnstile).toMatchObject({
      required: true,
      action: 'session',
      tokenLocations,
      productionBypass: 'deny-outside-approved-non-production',
    });
    expect(getApiRouteContract('POST', '/vote').turnstile).toMatchObject({
      required: true,
      action: 'vote',
      tokenLocations,
      productionBypass: 'deny-outside-approved-non-production',
    });
    expect(getApiRouteContract('POST', '/finalize').turnstile).toMatchObject({
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
      .filter((route) => !route.responseSchema && !route.responseSchemaExemptReason)
      .map((route) => routeKey(route.method, route.path));

    expect(missing).toEqual([]);
  });

  it('resolves every referenced contract schema to an exported schema schema', () => {
    const unresolved = TARGET_API_ROUTE_CONTRACTS.flatMap((route) =>
      schemaNamesFor(route)
        .filter((schemaName) => !isSchema(schemaExports[schemaName]))
        .map((schemaName) => `${routeKey(route.method, route.path)}: ${schemaName}`),
    );

    expect(unresolved).toEqual([]);
  });

  it('records request schema coverage for active mutation routes', () => {
    const contracts: readonly ApiRouteContract[] = TARGET_API_ROUTE_CONTRACTS;
    const missing = contracts
      .filter((route) => route.lifecycle === 'active' && route.kind === 'mutation')
      .filter((route) => !route.requestSchema)
      .map((route) => routeKey(route.method, route.path));

    expect(missing).toEqual([]);
  });

  it('records the Phase 03 retired and internal target routes', () => {
    expect(getApiRouteContract('GET', '/debug/enable').lifecycle).toBe('retired');
    expect(getApiRouteContract('GET', '/botdata/:id').lifecycle).toBe('retired');
    expect(getApiRouteContract('POST', '/finalize/callback').lifecycle).toBe('internal-operator-only');
  });

  it('keeps required session metadata in the target session response contract', () => {
    const session = getApiRouteContract('POST', '/session');

    expect(session.responseSchema).toBe('SessionResponseSchema');
    expect(session.admissionControls).toEqual(
      expect.arrayContaining(['turnstile-session-action', 'rate-limit', 'capability-issuance']),
    );
  });

  it('records both successful and fail-closed verify 200 response schemas', () => {
    const verify = getApiRouteContract('GET', '/verify');

    expect(verify.responseSchema).toBe('VerifyResponseSchema|VerifyFailClosedResponseSchema');
    expect(verify.responseSchemas).toEqual(
      expect.arrayContaining([
        { status: 200, content: 'json', schema: 'VerifyResponseSchema' },
        { status: 200, content: 'json', schema: 'VerifyFailClosedResponseSchema' },
      ]),
    );
  });

  it('records the operator-gated develop session admission decision', () => {
    const session = getApiRouteContract('POST', '/session');

    expect(session.targetAdmission).toEqual({
      nonOperatorDevelop: 'blocked-by-outer-operator-gate',
      operatorGatedDevelop: 'enabled-for-production-equivalent-smoke',
      ungatedPublic: 'requires-explicit-public-enable-and-server-turnstile',
      runtimeEnforcementHandoff: 'plans-07-and-11',
    });
    expect(session.admissionControls).toEqual(
      expect.arrayContaining([
        'operator-gated-develop-session-create',
        'non-operator-develop-gate',
        'ungated-public-server-turnstile-required',
      ]),
    );
  });

  it('treats truthy includeData zkVM input requests as retired target variants', () => {
    const route = getApiRouteContract('GET', '/zkvm-input-hash');

    for (const value of ['true', '1', 'yes', 'TRUE', 'YES']) {
      expect(isRetiredTargetRouteVariant(route, `https://example.test/api/zkvm-input-hash?includeData=${value}`)).toBe(
        true,
      );
    }

    expect(isRetiredTargetRouteVariant(route, 'https://example.test/api/zkvm-input-hash')).toBe(false);
    expect(isRetiredTargetRouteVariant(route, 'https://example.test/api/zkvm-input-hash?includeData=false')).toBe(
      false,
    );
  });

  it('records inherited current-artifact admission controls on retained verification-support routes', () => {
    expect(getApiRouteContract('GET', '/sth').admissionControls).toEqual(
      expect.arrayContaining(['session-header-capability', 'same-origin', 'finalized-session', 'current-artifact']),
    );
    expect(getApiRouteContract('POST', '/verification/run').admissionControls).toEqual(
      expect.arrayContaining([
        'session-header-capability',
        'finalized-session',
        'current-artifact',
        'expected-image-id',
      ]),
    );

    const consistencyProofRoute = getApiRouteContract('GET', '/bulletin/consistency-proof');
    expect(consistencyProofRoute.admissionControls).toEqual(
      expect.arrayContaining(['session-header-capability', 'current-artifact', 'unsupported-artifact-rejects']),
    );
    expect(consistencyProofRoute.admissionControls).not.toContain('finalized-session');
    expect(consistencyProofRoute.publicErrors.codes).toContain('UNSUPPORTED_CURRENT_ARTIFACT');

    const voteProofRoute = getApiRouteContract('GET', '/bulletin/:voteId/proof');
    expect(voteProofRoute.admissionControls).toEqual(
      expect.arrayContaining([
        'session-header-capability',
        'finalized-session',
        'current-artifact',
        'unsupported-artifact-rejects',
      ]),
    );
    expect(voteProofRoute.publicErrors.codes).toEqual(
      expect.arrayContaining(['SESSION_NOT_FINALIZED', 'UNSUPPORTED_CURRENT_ARTIFACT']),
    );
  });

  it('documents bulletin paging query parameters', () => {
    expect(getApiRouteContract('GET', '/bulletin').requestSchemas.query).toBe('BulletinQuerySchema');
  });

  it('records mutation request parsing, rate-limit, and route-specific controls', () => {
    expect(getApiRouteContract('POST', '/session').admissionControls).toEqual(
      expect.arrayContaining(['body-size', 'malformed-json', 'turnstile-session-action', 'rate-limit']),
    );
    expect(getApiRouteContract('POST', '/vote').admissionControls).toEqual(
      expect.arrayContaining(['body-size', 'malformed-json', 'turnstile-vote-action', 'rate-limit', 'duplicate-vote']),
    );
    expect(getApiRouteContract('POST', '/finalize').admissionControls).toEqual(
      expect.arrayContaining([
        'body-size',
        'malformed-json',
        'turnstile-finalize-action',
        'rate-limit',
        'finalized-session',
        'current-artifact',
      ]),
    );
    expect(getApiRouteContract('POST', '/finalize').publicErrors.codes).toContain('INVALID_IMAGE_ID');
    expect(getApiRouteContract('POST', '/finalize/cancel').admissionControls).toEqual(
      expect.arrayContaining(['body-size', 'malformed-json', 'rate-limit', 'execution-id']),
    );
    expect(getApiRouteContract('POST', '/finalize/cancel').requestSchema).toBe('FinalizeCancelRequestSchema');
    expect(getApiRouteContract('POST', '/verification/run').admissionControls).toEqual(
      expect.arrayContaining(['body-size', 'malformed-json', 'rate-limit']),
    );
  });
});

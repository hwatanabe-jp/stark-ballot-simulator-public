import { describe, expect, it } from 'vitest';
import { TARGET_API_ROUTE_CONTRACTS, type ApiRouteContract } from '@stark-ballot/api-contract/routes';
import { s } from '@stark-ballot/validation/schema';
import { buildOpenApiDocument, serializeOpenApiDocument } from './openapi-projection';

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function operation(document: Record<string, unknown>, path: string, method: string): Record<string, unknown> {
  return record(record(record(document['paths'])[path])[method]);
}

function parameter(
  projectedOperation: Record<string, unknown>,
  name: string,
  location: string,
): Record<string, unknown> {
  const parameters = projectedOperation['parameters'] as unknown[];
  const match = parameters.find((candidate) => {
    const projected = record(candidate);
    return projected['name'] === name && projected['in'] === location;
  });
  if (!match) throw new Error(`Missing ${location} parameter ${name}`);
  return record(match);
}

function routeContract(routeId: string): ApiRouteContract {
  const route = TARGET_API_ROUTE_CONTRACTS.find((candidate) => candidate.routeId === routeId);
  if (!route) throw new Error(`Missing route contract ${routeId}`);
  return route;
}

describe('guest-safe OpenAPI projection', () => {
  it('covers exactly the public typed inventory with account-free relative routing', () => {
    const document = buildOpenApiDocument(TARGET_API_ROUTE_CONTRACTS);
    const operations = Object.values(record(document['paths'])).flatMap((pathItem) => Object.values(record(pathItem)));

    expect(document['servers']).toEqual([{ url: '/api' }]);
    expect(record(document['info'])['version']).toBe('unversioned');
    expect(operations.map((value) => record(value)['operationId']).sort()).toEqual(
      TARGET_API_ROUTE_CONTRACTS.map((route) => route.routeId).sort(),
    );
    expect(JSON.stringify(document)).not.toContain('/internal/');
    expect(JSON.stringify(document)).not.toContain('runtimeEnforcementHandoff');
    expect(JSON.stringify(document)).not.toMatch(/plans?-\d+/u);
    for (const projected of operations) {
      const sourceIp = record(record(projected)['x-stark-ballot-source-ip']);
      expect(Object.keys(sourceIp)).toEqual(['dependency']);
      expect(['not-required', 'trusted-proxy-required-for-target-runtime']).toContain(sourceIp['dependency']);
    }
  });

  it('preserves authentication, wire transforms, media types, and bodyless responses', () => {
    const document = buildOpenApiDocument(TARGET_API_ROUTE_CONTRACTS);
    const createSession = operation(document, '/sessions', 'post');
    const bulletin = operation(document, '/sessions/{sessionId}/bulletin', 'get');
    const bundle = operation(document, '/sessions/{sessionId}/finalizations/{finalizationId}/artifacts/bundle', 'get');
    const report = operation(document, '/sessions/{sessionId}/finalizations/{finalizationId}/artifacts/report', 'get');
    const bitmap = operation(
      document,
      '/sessions/{sessionId}/finalizations/current/bitmap-proofs/{kind}/{voteIndex}',
      'get',
    );

    expect(createSession['security']).toEqual([]);
    expect(bulletin['security']).toEqual([{ sessionCapability: [] }]);
    const bulletinParameters = bulletin['parameters'] as unknown[];
    expect(record(record(bulletinParameters[1])['schema'])['type']).toBe('string');
    expect(record(record(record(record(bundle['responses'])['206'])['content'])['application/zip'])['schema']).toEqual({
      type: 'string',
      format: 'binary',
    });
    const reportResponse = record(record(report['responses'])['200']);
    const reportMedia = record(record(reportResponse['content'])['application/json']);
    expect(reportMedia).not.toHaveProperty('schema');
    expect(reportResponse['x-stark-ballot-runtime-validation']).toBe('retained-bytes-not-revalidated');
    const expectedReportSchema = record(reportResponse['x-stark-ballot-expected-retained-schema']);
    expect(expectedReportSchema).toHaveProperty('anyOf');
    const reportVariants = expectedReportSchema['anyOf'] as unknown[];
    for (const variant of reportVariants) {
      const properties = record(record(variant)['properties']);
      expect(properties).toHaveProperty('bundle_path');
      expect(properties).toHaveProperty('receipt_path');
    }
    expect(record(record(bitmap['responses'])['304'])).not.toHaveProperty('content');
  });

  it('documents only the mounted verification-read success variant', () => {
    const document = buildOpenApiDocument(TARGET_API_ROUTE_CONTRACTS);
    const verification = operation(
      document,
      '/sessions/{sessionId}/finalizations/{finalizationId}/verification',
      'get',
    );
    const response = record(record(verification['responses'])['200']);
    const schema = record(record(record(response['content'])['application/json'])['schema']);
    const data = record(record(schema['properties'])['data']);

    expect(data).not.toHaveProperty('anyOf');
    expect(record(record(data['properties'])['availability'])['const']).toBe('available');
    expect(response['x-stark-ballot-mounted-success-projection']).toBe('available-only');
    expect(record(verification['responses'])).toHaveProperty('500');
  });

  it('retains exact declared errors including upstream-selected status', () => {
    const document = buildOpenApiDocument(TARGET_API_ROUTE_CONTRACTS);
    const createSession = operation(document, '/sessions', 'post');
    const responses = record(createSession['responses']);

    expect(responses).toHaveProperty('403');
    expect(responses).toHaveProperty('default');
    expect(record(responses['default'])['x-stark-ballot-errors']).toContainEqual(
      expect.objectContaining({ code: 'CAPTCHA_FAILED', status: 'upstream-response-status' }),
    );
    expect(record(responses['500'])['x-stark-ballot-errors']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CAPTCHA_FAILED', status: 'upstream-response-status' }),
        expect.objectContaining({ code: 'INTERNAL_ERROR', status: 500 }),
      ]),
    );
    expect(createSession['x-stark-ballot-errors']).toEqual(
      TARGET_API_ROUTE_CONTRACTS.find((route) => route.routeId === 'session.post')?.publicErrors.responses,
    );
  });

  it('projects route-owned path and range admission that is stricter than shared schemas', () => {
    const document = buildOpenApiDocument(TARGET_API_ROUTE_CONTRACTS);
    const progress = operation(document, '/sessions/{sessionId}/progress', 'get');
    const voteProof = operation(document, '/sessions/{sessionId}/votes/{voteId}/inclusion-proof', 'get');
    const bitmap = operation(
      document,
      '/sessions/{sessionId}/finalizations/current/bitmap-proofs/{kind}/{voteIndex}',
      'get',
    );
    const bundle = operation(document, '/sessions/{sessionId}/finalizations/{finalizationId}/artifacts/bundle', 'get');

    expect(record(parameter(progress, 'sessionId', 'path')['schema'])['pattern']).toBe('^[A-Za-z0-9-]+$');
    expect(record(parameter(voteProof, 'voteId', 'path')['schema'])).toMatchObject({
      format: 'uuid',
      pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-4[0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$',
    });
    expect(record(parameter(bundle, 'Range', 'header')['schema'])['pattern']).toBe(
      '^\\s*bytes=(?:\\d+-\\d*|-\\d+)\\s*$',
    );
    expect(record(parameter(bitmap, 'voteIndex', 'path')['schema'])).toMatchObject({
      'x-stark-ballot-numeric-maximum': Number.MAX_SAFE_INTEGER,
      'x-stark-ballot-runtime-constraint': 'The index must equal the authenticated session user vote index.',
    });
    expect(bitmap['description']).toContain('authenticated session user');
    expect(bitmap['x-stark-ballot-admission-controls']).toContain('owner-vote-index');
  });

  it('serializes stable bytes regardless of inventory order', () => {
    const forward = serializeOpenApiDocument(buildOpenApiDocument(TARGET_API_ROUTE_CONTRACTS));
    const reversed = serializeOpenApiDocument(buildOpenApiDocument([...TARGET_API_ROUTE_CONTRACTS].reverse()));

    expect(reversed).toBe(forward);
    expect(forward.endsWith('\n')).toBe(true);
  });

  it('fails closed on a route outside the reviewed guest authentication boundary', () => {
    const route = {
      ...routeContract('sessions.bulletin.get'),
      authScope: 'callback-authenticity',
      capabilityScope: 'none',
    } as ApiRouteContract;

    expect(() => buildOpenApiDocument([route])).toThrow('does not match the reviewed session-capability boundary');
  });

  it('fails closed on an unprojected error envelope or media type', () => {
    const source = routeContract('sessions.bulletin.get');
    const route = {
      ...source,
      publicErrors: {
        ...source.publicErrors,
        responses: [
          {
            case: 'plain failure',
            status: 500,
            contentType: 'text/plain; charset=UTF-8',
            envelope: 'plain-text',
          },
        ],
      },
    } as ApiRouteContract;

    expect(() => buildOpenApiDocument([route])).toThrow('uses unsupported text/plain; charset=UTF-8/plain-text');
  });

  it('fails closed on authenticated raw-body routes', () => {
    const source = routeContract('sessions.bulletin.get');
    if (!('params' in source.request)) throw new Error('Fixture route must have path parameters');
    const route = {
      ...source,
      request: {
        params: source.request.params,
        rawBody: { kind: 'authenticated-raw-body', limitPath: 'fixture', authenticateBeforeParse: true },
      },
    } as ApiRouteContract;

    expect(() => buildOpenApiDocument([route])).toThrow('uses an authenticated raw body');
  });

  it('preserves omission through nullable wrappers on route parameters', () => {
    const source = routeContract('sessions.bulletin.get');
    const route = {
      ...source,
      request: {
        ...source.request,
        query: s.object({ cursor: s.string().optional().nullable() }).strict(),
      },
    } as ApiRouteContract;
    const document = buildOpenApiDocument([route]);
    const bulletin = operation(document, '/sessions/{sessionId}/bulletin', 'get');

    expect(parameter(bulletin, 'cursor', 'query')['required']).toBe(false);
  });
});

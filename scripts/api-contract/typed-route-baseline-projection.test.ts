import { describe, expect, it } from 'vitest';
import { s } from '@stark-ballot/validation/schema';
import { TARGET_API_ROUTE_CONTRACTS as TYPED_ROUTE_CONTRACTS } from '@stark-ballot/api-contract/routes';
import { fingerprintSchemaSemantics, type SchemaSemanticEvidence } from './schema-semantic-fingerprint';
import { projectTypedRoutesForBaseline } from './typed-route-baseline-projection';

function expectSchemaEvidence(evidence: SchemaSemanticEvidence | undefined): void {
  expect(evidence?.algorithm).toBe('json-wire-admission');
  expect(evidence?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
}

describe('typed route baseline projection', () => {
  it('records direct semantic schema evidence without compatibility aliases or export-name lookup', () => {
    const projectedRoutes = projectTypedRoutesForBaseline(TYPED_ROUTE_CONTRACTS).sort((left, right) =>
      `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
    );

    const voteRoute = projectedRoutes.find((route) => route.routeId === 'vote.post');
    expectSchemaEvidence(voteRoute?.request.params);
    expectSchemaEvidence(voteRoute?.request.headers);
    expectSchemaEvidence(voteRoute?.request.body);
    expect(voteRoute?.responses).toHaveLength(1);
    const voteResponse = voteRoute?.responses[0];
    expect(voteResponse).toMatchObject({ status: 200, content: 'json' });
    expectSchemaEvidence(voteResponse && 'schema' in voteResponse ? voteResponse.schema : undefined);

    expect(
      projectedRoutes.find((route) => route.routeId === 'sessions.finalizations.artifacts.bundle.get'),
    ).toMatchObject({
      path: '/sessions/:sessionId/finalizations/:finalizationId/artifacts/bundle',
      responses: [
        { status: 200, content: 'binary', exemptReason: 'binary-public-bundle-download' },
        { status: 206, content: 'binary', exemptReason: 'binary-public-bundle-range-download' },
      ],
    });

    for (const route of projectedRoutes) {
      expect(route).not.toHaveProperty('requestSchema');
      expect(route).not.toHaveProperty('requestSchemas');
      expect(route).not.toHaveProperty('responseSchema');
      expect(route).not.toHaveProperty('responseSchemas');
      expect(route).not.toHaveProperty('responseSchemaExemptReason');
    }
    expect(JSON.stringify(projectedRoutes)).not.toMatch(/Schema(?:s|ExemptReason)?"\s*:/u);
  });

  it('fingerprints independently constructed schemas by semantics rather than object identity', () => {
    const first = s
      .object({
        value: s.string().min(1),
        optionalCount: s.number().int().optional(),
      })
      .strict();
    const equivalent = s
      .object({
        optionalCount: s.number().int().optional(),
        value: s.string().min(1),
      })
      .strict();
    const changed = s
      .object({
        value: s.string().min(2),
        optionalCount: s.number().int().optional(),
      })
      .strict();

    expect(fingerprintSchemaSemantics(first)).toEqual(fingerprintSchemaSemantics(equivalent));
    expect(fingerprintSchemaSemantics(first)).not.toEqual(fingerprintSchemaSemantics(changed));
  });

  it('distinguishes transforms with the same raw admission but different wire outputs', () => {
    const returnsOne = s.string().transform(() => 1);
    const returnsTwo = s.string().transform(() => 2);

    expect(fingerprintSchemaSemantics(returnsOne)).not.toEqual(fingerprintSchemaSemantics(returnsTwo));
  });
});

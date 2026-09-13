import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_AT,
  APP_SOURCE_SHA,
  DEPLOYMENT_ID,
  createAppAcceptanceFixture,
  createBoundSelectionFixture,
} from './testdata/app-acceptance-ledger-fixture.js';
import {
  bindAppAcceptanceSelection,
  deriveAppAcceptanceRecordKey,
  projectInitialAppAcceptancePointer,
} from './app-acceptance-ledger.js';
import {
  APP_DEPLOYMENT_STATUS_MAX_BYTES,
  APP_DEPLOYMENT_STATUS_TTL_DAYS,
  admitAppDeploymentStatus,
  canonicalAppDeploymentStatusJson,
  parseCanonicalAppDeploymentStatus,
  projectAppDeploymentStatus,
} from './app-deployment-status.js';

const EXPECTED_STATUS = {
  deploymentId: DEPLOYMENT_ID,
  source: {
    shortSha: APP_SOURCE_SHA.slice(0, 12),
    commitUrl: `https://github.com/hwatanabe-jp/stark-ballot-simulator/commit/${APP_SOURCE_SHA}`,
  },
  prover: {
    imageDigestPrefix: `sha256:${'e'.repeat(12)}`,
    imageId: `0x${'e'.repeat(64)}`,
    methodVersion: 14,
  },
  deploymentMode: 'normal',
  planDisposition: 'changed',
  smokeOutcome: 'passed',
  acceptedAt: ACCEPTED_AT,
  updatedAt: ACCEPTED_AT,
  staleAfter: '2026-09-13T01:04:05.000Z',
} as const;

function fixtureBody(): string {
  return readFileSync(new URL('../fixtures/app-deployment-status.json', import.meta.url), 'utf8');
}

function mutableStatus(): Record<string, unknown> {
  return structuredClone(EXPECTED_STATUS);
}

function boundSelectionFor(record: Readonly<Record<string, unknown>>) {
  const acceptanceKey = deriveAppAcceptanceRecordKey(record, 'stark-dev/develop');
  const pointer = projectInitialAppAcceptancePointer(
    {
      history: [acceptanceKey],
      predecessor: { etag: 'captured-etag', versionId: 'captured-object-id' },
    },
    'stark-dev/develop',
  );
  return bindAppAcceptanceSelection(
    {
      pointer,
      pointerObservation: { etag: 'pointer-etag', versionId: 'pointer-object-id' },
      recordKey: acceptanceKey,
      record,
      recordObservation: { etag: 'record-etag', versionId: 'record-object-id' },
    },
    'stark-dev/develop',
  );
}

describe('App deployment status DTO', () => {
  it('projects the current accepted deployment into exact public-safe display data', () => {
    const selection = createBoundSelectionFixture('current');

    const status = projectAppDeploymentStatus(selection, 'stark-dev/develop');

    expect(APP_DEPLOYMENT_STATUS_TTL_DAYS).toBe(30);
    expect(APP_DEPLOYMENT_STATUS_MAX_BYTES).toBe(4096);
    expect(status).toEqual(EXPECTED_STATUS);
    expect(Object.keys(status).sort()).toEqual([
      'acceptedAt',
      'deploymentId',
      'deploymentMode',
      'planDisposition',
      'prover',
      'smokeOutcome',
      'source',
      'staleAfter',
      'updatedAt',
    ]);
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.source)).toBe(true);
    expect(Object.isFrozen(status.prover)).toBe(true);

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(selection.acceptanceKey);
    expect(serialized).not.toContain(selection.acceptance.targetContext.target.accountId);
    expect(serialized).not.toContain(`sha256:${'e'.repeat(64)}`);
  });

  it('projects an exact retained acceptance for comparison with already stored display data', () => {
    expect(projectAppDeploymentStatus(createBoundSelectionFixture('retained'), 'stark-dev/develop')).toEqual(
      EXPECTED_STATUS,
    );
  });

  it('emits the deterministic repository fixture as canonical newline-terminated JSON', () => {
    const status = projectAppDeploymentStatus(createBoundSelectionFixture('current'), 'stark-dev/develop');
    const body = canonicalAppDeploymentStatusJson(status, 'stark-dev/develop');

    expect(body).toBe(fixtureBody());
    expect(body.endsWith('\n')).toBe(true);
    expect(body.endsWith('\n\n')).toBe(false);
    expect(parseCanonicalAppDeploymentStatus(body, 'stark-dev/develop')).toEqual(EXPECTED_STATUS);
    expect(Object.isFrozen(parseCanonicalAppDeploymentStatus(body, 'stark-dev/develop'))).toBe(true);
    expect(Object.isFrozen(parseCanonicalAppDeploymentStatus(body, 'stark-dev/develop').source)).toBe(true);
    expect(Object.isFrozen(parseCanonicalAppDeploymentStatus(body, 'stark-dev/develop').prover)).toBe(true);
  });

  it.each([
    ['missing final newline', () => fixtureBody().slice(0, -1)],
    ['extra final newline', () => `${fixtureBody()}\n`],
    ['surrounding whitespace', () => ` ${fixtureBody()}`],
    ['pretty printing', () => `${JSON.stringify(EXPECTED_STATUS, null, 2)}\n`],
    ['different key order', () => `${JSON.stringify(EXPECTED_STATUS)}\n`],
    ['malformed JSON', () => '{'],
  ])('rejects %s instead of normalizing stored bytes', (_label, body) => {
    expect(() => parseCanonicalAppDeploymentStatus(body(), 'stark-dev/develop')).toThrow();
  });

  it.each([null, true, 1, {}, []])('rejects a non-string canonical body input %#', (body) => {
    expect(() => parseCanonicalAppDeploymentStatus(body, 'stark-dev/develop')).toThrow(/string/iu);
  });

  it('rejects an oversized canonical-body candidate before parsing it', () => {
    expect(() =>
      parseCanonicalAppDeploymentStatus(' '.repeat(APP_DEPLOYMENT_STATUS_MAX_BYTES + 1), 'stark-dev/develop'),
    ).toThrow(/byte limit/iu);
  });

  it('admits only the exact current DTO fields and nested fields', () => {
    expect(admitAppDeploymentStatus(EXPECTED_STATUS, 'stark-dev/develop')).toEqual(EXPECTED_STATUS);

    const missing = mutableStatus();
    delete missing['staleAfter'];
    const extra = { ...EXPECTED_STATUS, accountId: '123456789012' };
    const shapeTag = { ...EXPECTED_STATUS, statusType: 'app-deployment-status' };
    const nestedExtra = mutableStatus();
    (nestedExtra['source'] as Record<string, unknown>)['sourceSha'] = APP_SOURCE_SHA;
    const symbol = mutableStatus();
    Object.defineProperty(symbol, Symbol('internal'), { enumerable: true, value: 'unsafe' });
    const hidden = mutableStatus();
    Object.defineProperty(hidden, 'internal', { enumerable: false, value: 'unsafe' });

    for (const value of [missing, extra, shapeTag, nestedExtra, symbol, hidden]) {
      expect(() => admitAppDeploymentStatus(value, 'stark-dev/develop')).toThrow(/exact/iu);
    }
  });

  it('rejects accessors and proxies without invoking their traps', () => {
    let accessorCalls = 0;
    const accessor = mutableStatus();
    Object.defineProperty(accessor, 'deploymentId', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return DEPLOYMENT_ID;
      },
    });
    expect(() => admitAppDeploymentStatus(accessor, 'stark-dev/develop')).toThrow(/data|exact/iu);
    expect(accessorCalls).toBe(0);

    let proxyTraps = 0;
    const proxiedStatus = new Proxy(mutableStatus(), {
      get() {
        proxyTraps += 1;
        return 'swapped';
      },
      ownKeys() {
        proxyTraps += 1;
        return [];
      },
    });
    expect(() => admitAppDeploymentStatus(proxiedStatus, 'stark-dev/develop')).toThrow(/proxy/iu);
    expect(proxyTraps).toBe(0);

    const nestedProxy = mutableStatus();
    nestedProxy['source'] = new Proxy(nestedProxy['source'] as Record<string, unknown>, {
      get() {
        proxyTraps += 1;
        return 'swapped';
      },
    });
    expect(() => admitAppDeploymentStatus(nestedProxy, 'stark-dev/develop')).toThrow(/proxy/iu);
    expect(proxyTraps).toBe(0);
  });

  it.each([
    ['deployment ID', { deploymentId: 'dep_short' }],
    ['source short SHA', { source: { ...EXPECTED_STATUS.source, shortSha: 'A'.repeat(12) } }],
    [
      'source URL origin',
      { source: { ...EXPECTED_STATUS.source, commitUrl: `https://example.invalid/commit/${APP_SOURCE_SHA}` } },
    ],
    [
      'source URL user information',
      {
        source: {
          ...EXPECTED_STATUS.source,
          commitUrl: `https://user@github.com/hwatanabe-jp/stark-ballot-simulator/commit/${APP_SOURCE_SHA}`,
        },
      },
    ],
    [
      'source URL port',
      {
        source: {
          ...EXPECTED_STATUS.source,
          commitUrl: `https://github.com:443/hwatanabe-jp/stark-ballot-simulator/commit/${APP_SOURCE_SHA}`,
        },
      },
    ],
    [
      'source URL query',
      { source: { ...EXPECTED_STATUS.source, commitUrl: `${EXPECTED_STATUS.source.commitUrl}?raw=1` } },
    ],
    ['Prover digest prefix', { prover: { ...EXPECTED_STATUS.prover, imageDigestPrefix: 'sha256:222' } }],
    ['ImageID', { prover: { ...EXPECTED_STATUS.prover, imageId: `0x${'E'.repeat(64)}` } }],
    ['method semantics', { prover: { ...EXPECTED_STATUS.prover, methodVersion: 0 } }],
    ['deployment mode', { deploymentMode: 'preview' }],
    ['disposition', { planDisposition: 'unknown' }],
    ['smoke outcome', { smokeOutcome: 'failed' }],
    ['accepted timestamp', { acceptedAt: '2026-08-14T01:04:05Z' }],
    ['updated timestamp binding', { updatedAt: '2026-08-14T01:04:06.000Z' }],
    ['expiry binding', { staleAfter: '2026-09-13T01:04:05.001Z' }],
  ])('rejects an invalid %s', (_label, override) => {
    expect(() => admitAppDeploymentStatus({ ...EXPECTED_STATUS, ...override }, 'stark-dev/develop')).toThrow();
  });

  it('rejects a timestamp whose bounded expiry exceeds the four-digit UTC range', () => {
    const value = {
      ...EXPECTED_STATUS,
      acceptedAt: '9999-12-20T00:00:00.000Z',
      updatedAt: '9999-12-20T00:00:00.000Z',
      staleAfter: '9999-12-31T23:59:59.999Z',
    };
    expect(() => admitAppDeploymentStatus(value, 'stark-dev/develop')).toThrow(/range|overflow/iu);

    const selection = boundSelectionFor(createAppAcceptanceFixture({ acceptedAt: '9999-12-20T00:00:00.000Z' }));
    expect(() => projectAppDeploymentStatus(selection, 'stark-dev/develop')).toThrow(/range|overflow/iu);
  });

  it('rejects anything other than an exact rebound acceptance selection', () => {
    const current = createBoundSelectionFixture('current');

    expect(() => projectAppDeploymentStatus(current.acceptance, 'stark-dev/develop')).toThrow(/exact|selection/iu);
    expect(() => projectAppDeploymentStatus({ ...current, unknown: true }, 'stark-dev/develop')).toThrow(/exact/iu);
    expect(() => projectAppDeploymentStatus({ ...current, selectionType: 'retained' }, 'stark-dev/develop')).toThrow(
      /detached/iu,
    );

    const detached = structuredClone(current) as Record<string, unknown>;
    const acceptance = detached['acceptance'] as Record<string, unknown>;
    acceptance['selectedApplicationSourceSha'] = 'b'.repeat(40);
    expect(() => projectAppDeploymentStatus(detached, 'stark-dev/develop')).toThrow(/detached|match|source/iu);

    const symbol = { ...current };
    Object.defineProperty(symbol, Symbol('unsafe'), { enumerable: true, value: true });
    expect(() => projectAppDeploymentStatus(symbol, 'stark-dev/develop')).toThrow(/exact|data/iu);

    let accessorCalls = 0;
    const accessor = { ...current } as Record<string, unknown>;
    Object.defineProperty(accessor, 'targetKey', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return current.targetKey;
      },
    });
    expect(() => projectAppDeploymentStatus(accessor, 'stark-dev/develop')).toThrow(/data|exact/iu);
    expect(accessorCalls).toBe(0);

    let proxyTraps = 0;
    const proxy = new Proxy(current, {
      get() {
        proxyTraps += 1;
        return 'swapped';
      },
      ownKeys() {
        proxyTraps += 1;
        return [];
      },
    });
    expect(() => projectAppDeploymentStatus(proxy, 'stark-dev/develop')).toThrow(/proxy/iu);
    expect(proxyTraps).toBe(0);
  });
});

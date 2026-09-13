import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APP_DEPLOYMENT_STATUS_MAX_ATTEMPTS,
  classifyAppDeploymentStatusPublication,
  publishCurrentAppDeploymentStatus,
} from './app-deployment-status-publication.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

const ledgerMocks = vi.hoisted(() => ({
  admitPointer: vi.fn((value: unknown) => Object.freeze(value as object)),
  bindSelection: vi.fn((value: Readonly<Record<string, unknown>>) => {
    const pointer = value['pointer'] as Readonly<{ headKey: string }>;
    return Object.freeze({
      selectionType: pointer.headKey === value['recordKey'] ? 'current' : 'retained',
      targetKey: 'stark-dev/develop',
      pointer: value['pointer'],
      pointerObservation: value['pointerObservation'],
      acceptanceKey: value['recordKey'],
      acceptance: value['record'],
      acceptanceObservation: value['recordObservation'],
    });
  }),
}));

const dtoMocks = vi.hoisted(() => ({
  projectStatus: vi.fn((selection: Readonly<Record<string, unknown>>) => {
    const acceptance = selection['acceptance'] as Readonly<Record<string, unknown>>;
    return Object.freeze(acceptance['projectedStatus'] as object);
  }),
  canonicalStatus: vi.fn((value: unknown) => `${JSON.stringify(value)}\n`),
  parseStatus: vi.fn((body: unknown) => {
    if (typeof body !== 'string') {
      throw new Error('App deployment status body is invalid.');
    }
    const parsed = JSON.parse(body) as unknown;
    if (`${JSON.stringify(parsed)}\n` !== body) {
      throw new Error('App deployment status body must use canonical bytes.');
    }
    return Object.freeze(parsed as object);
  }),
}));

vi.mock('./app-acceptance-ledger.js', () => ({
  admitAppCurrentAcceptancePointer: ledgerMocks.admitPointer,
  bindAppAcceptanceSelection: ledgerMocks.bindSelection,
}));

vi.mock('./app-deployment-status.js', () => ({
  APP_DEPLOYMENT_STATUS_MAX_BYTES: 4096,
  canonicalAppDeploymentStatusJson: dtoMocks.canonicalStatus,
  parseCanonicalAppDeploymentStatus: dtoMocks.parseStatus,
  projectAppDeploymentStatus: dtoMocks.projectStatus,
}));

const POINTER_KEY = resolveDeploymentLaneAuthority(resolveAllowedDeploymentTarget('stark-dev/develop'), 'app').names
  .acceptedDeploymentPointerKey;
const HEAD_KEY = `retained/app/acceptance/${'a'.repeat(64)}.json`;
const RETAINED_KEY = `retained/app/acceptance/${'b'.repeat(64)}.json`;
const POINTER_OBSERVATION = Object.freeze({ etag: '"pointer-etag"', versionId: 'pointer-object' });

function deploymentStatus(deploymentId: string) {
  return Object.freeze({
    deploymentId,
    source: Object.freeze({ shortSha: deploymentId.slice(-8), commitUrl: `https://example.test/${deploymentId}` }),
    prover: Object.freeze({
      imageDigestPrefix: 'sha256:123456789abc',
      imageId: `0x${'1'.repeat(64)}`,
      methodVersion: 1,
    }),
    deploymentMode: 'normal',
    planDisposition: 'changed',
    smokeOutcome: 'passed',
    acceptedAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    staleAfter: '2026-09-13T00:00:00.000Z',
  });
}

const HEAD_STATUS = deploymentStatus(`dep_${'1'.repeat(32)}`);
const RETAINED_STATUS = deploymentStatus(`dep_${'2'.repeat(32)}`);
const NEXT_STATUS = deploymentStatus(`dep_${'3'.repeat(32)}`);

function selection(
  pointer: Readonly<Record<string, unknown>>,
  pointerObservation: Readonly<{ etag: string; versionId: string }>,
  acceptanceKey: string,
  projectedStatus: Readonly<Record<string, unknown>>,
  acceptanceFact: string,
  observationFact: string,
) {
  return Object.freeze({
    selectionType: pointer['headKey'] === acceptanceKey ? 'current' : 'retained',
    targetKey: 'stark-dev/develop',
    pointer,
    pointerObservation,
    acceptanceKey,
    acceptance: Object.freeze({ projectedStatus, acceptanceFact }),
    acceptanceObservation: Object.freeze({
      etag: `"${observationFact}-etag"`,
      versionId: `${observationFact}-object`,
    }),
  });
}

function historyResolution({
  headKey = HEAD_KEY,
  pointerObservation = POINTER_OBSERVATION,
  headStatus = HEAD_STATUS,
  retainedStatus = RETAINED_STATUS,
  headAcceptanceFact = 'head-fact',
  retainedAcceptanceFact = 'retained-fact',
  headObservationFact = 'head-record',
  retainedObservationFact = 'retained-record',
}: {
  readonly headKey?: string;
  readonly pointerObservation?: Readonly<{ etag: string; versionId: string }>;
  readonly headStatus?: Readonly<Record<string, unknown>>;
  readonly retainedStatus?: Readonly<Record<string, unknown>>;
  readonly headAcceptanceFact?: string;
  readonly retainedAcceptanceFact?: string;
  readonly headObservationFact?: string;
  readonly retainedObservationFact?: string;
} = {}) {
  const retainedKey = headKey === HEAD_KEY ? RETAINED_KEY : HEAD_KEY;
  const pointer = Object.freeze({
    kind: 'app-current-acceptance-pointer',
    targetKey: 'stark-dev/develop',
    generation: headKey === HEAD_KEY ? 1 : 2,
    headKey,
    history: Object.freeze([headKey, retainedKey]),
    previous: Object.freeze({ etag: '"previous-etag"', versionId: 'previous-object' }),
    compareAndSwapEvidenceId: `cas/app-acceptance/${'c'.repeat(64)}`,
  });
  return Object.freeze({
    resolutionType: 'app-acceptance-history',
    pointerKey: POINTER_KEY,
    pointer,
    pointerObservation,
    selections: Object.freeze([
      selection(pointer, pointerObservation, headKey, headStatus, headAcceptanceFact, headObservationFact),
      selection(
        pointer,
        pointerObservation,
        retainedKey,
        retainedStatus,
        retainedAcceptanceFact,
        retainedObservationFact,
      ),
    ]),
  });
}

function canonicalStatus(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function stablePublication({
  resolution = historyResolution(),
  statusRead = undefined,
  writeResult = undefined,
}: {
  readonly resolution?: unknown;
  readonly statusRead?: unknown;
  readonly writeResult?: unknown;
} = {}) {
  const resolveHistory = vi.fn().mockResolvedValue(resolution);
  const readStatus = vi.fn().mockResolvedValue(statusRead);
  const writeStatus = vi.fn();
  if (writeResult !== undefined) {
    writeStatus.mockResolvedValue(writeResult);
  } else if (statusRead === undefined) {
    writeStatus.mockResolvedValue({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });
  } else {
    writeStatus
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValue({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });
  }
  return {
    input: { resolveHistory, statusStore: { readStatus, writeStatus } },
    resolveHistory,
    readStatus,
    writeStatus,
  };
}

describe('App deployment status publication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bounds conditional publication attempts', () => {
    expect(APP_DEPLOYMENT_STATUS_MAX_ATTEMPTS).toBe(5);
  });

  it('classifies a missing status as an exact conditional create', () => {
    const classification = classifyAppDeploymentStatusPublication(
      {
        resolution: historyResolution(),
        statusRead: undefined,
      },
      'stark-dev/develop',
    );

    expect(classification).toEqual({
      disposition: 'create',
      status: HEAD_STATUS,
      body: canonicalStatus(HEAD_STATUS),
      condition: { type: 'if-none-match' },
    });
    expect(Object.isFrozen(classification)).toBe(true);
    if (classification.disposition !== 'create') {
      throw new Error('Expected a create classification.');
    }
    expect(Object.isFrozen(classification.condition)).toBe(true);
    expect(ledgerMocks.bindSelection).toHaveBeenCalledTimes(2);
    expect(dtoMocks.projectStatus).toHaveBeenCalledTimes(2);
  });

  it('classifies exact current bytes as a no-op bound to their observation', () => {
    const classification = classifyAppDeploymentStatusPublication(
      {
        resolution: historyResolution(),
        statusRead: {
          body: canonicalStatus(HEAD_STATUS),
          etag: '"status-etag"',
          versionId: 'status-object',
        },
      },
      'stark-dev/develop',
    );

    expect(classification).toEqual({
      disposition: 'current',
      status: HEAD_STATUS,
      body: canonicalStatus(HEAD_STATUS),
      statusObservation: { etag: '"status-etag"', versionId: 'status-object' },
    });
  });

  it('classifies exact retained bytes as a conditional update to the head', () => {
    const classification = classifyAppDeploymentStatusPublication(
      {
        resolution: historyResolution(),
        statusRead: {
          body: canonicalStatus(RETAINED_STATUS),
          etag: '"retained-status-etag"',
          versionId: 'retained-status-object',
        },
      },
      'stark-dev/develop',
    );

    expect(classification).toEqual({
      disposition: 'update',
      status: HEAD_STATUS,
      body: canonicalStatus(HEAD_STATUS),
      condition: {
        type: 'if-match',
        etag: '"retained-status-etag"',
        versionId: 'retained-status-object',
      },
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['noncanonical JSON', `${JSON.stringify(HEAD_STATUS)}`],
    ['unrelated canonical status', canonicalStatus(deploymentStatus(`dep_${'3'.repeat(32)}`))],
    [
      'current deployment with different canonical bytes',
      canonicalStatus({ ...HEAD_STATUS, staleAfter: '2026-09-14T00:00:00.000Z' }),
    ],
  ])('rejects %s as an authority contradiction', (_label, body) => {
    expect(() =>
      classifyAppDeploymentStatusPublication(
        {
          resolution: historyResolution(),
          statusRead: { body, etag: '"status-etag"', versionId: 'status-object' },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/contradiction/u);
  });

  it('rejects classifier proxies and accessors without invoking their traps', () => {
    let proxyTraps = 0;
    const proxiedResolution = new Proxy(historyResolution(), {
      get() {
        proxyTraps += 1;
        return 'swapped';
      },
      ownKeys() {
        proxyTraps += 1;
        return [];
      },
    });
    expect(() =>
      classifyAppDeploymentStatusPublication(
        { resolution: proxiedResolution, statusRead: undefined },
        'stark-dev/develop',
      ),
    ).toThrow(/proxy/iu);
    expect(proxyTraps).toBe(0);

    const proxiedRead = new Proxy(
      { body: canonicalStatus(HEAD_STATUS), etag: '"status-etag"', versionId: 'status-object' },
      {
        get() {
          proxyTraps += 1;
          return 'swapped';
        },
      },
    );
    expect(() =>
      classifyAppDeploymentStatusPublication(
        { resolution: historyResolution(), statusRead: proxiedRead },
        'stark-dev/develop',
      ),
    ).toThrow(/proxy/iu);
    expect(proxyTraps).toBe(0);

    let accessorCalls = 0;
    const accessorInput = { statusRead: undefined } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'resolution', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return historyResolution();
      },
    });
    expect(() => classifyAppDeploymentStatusPublication(accessorInput, 'stark-dev/develop')).toThrow(/data|shape/iu);
    expect(accessorCalls).toBe(0);
  });

  it('rejects an over-limit stored body before parsing it', () => {
    expect(() =>
      classifyAppDeploymentStatusPublication(
        {
          resolution: historyResolution(),
          statusRead: { body: 'x'.repeat(4097), etag: '"status-etag"', versionId: 'status-object' },
        },
        'stark-dev/develop',
      ),
    ).toThrow(/body.*invalid/iu);
    expect(dtoMocks.parseStatus).not.toHaveBeenCalled();
  });

  it('conditionally creates from exact current history before any status read', async () => {
    const calls: string[] = [];
    const resolveHistory = vi.fn(() => {
      calls.push('resolve-history');
      return Promise.resolve(historyResolution());
    });
    const readStatus = vi.fn(() => {
      calls.push('read-status');
      return Promise.resolve(undefined);
    });
    const writeStatus = vi.fn((request: Readonly<Record<string, unknown>>) => {
      const condition = request['condition'] as Readonly<Record<string, unknown>>;
      calls.push(`write-status:${String(condition['type'])}`);
      return Promise.resolve({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });
    });

    const result = await publishCurrentAppDeploymentStatus(
      {
        resolveHistory,
        statusStore: { readStatus, writeStatus },
      },
      'stark-dev/develop',
    );

    expect(result).toEqual({
      disposition: 'created',
      status: HEAD_STATUS,
      statusObservation: { etag: '"written-etag"', versionId: 'written-object' },
    });
    expect(calls).toEqual(['resolve-history', 'write-status:if-none-match', 'resolve-history']);
    expect(resolveHistory).toHaveBeenCalledTimes(2);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).toHaveBeenCalledOnce();
    expect(writeStatus).toHaveBeenCalledWith({
      body: canonicalStatus(HEAD_STATUS),
      condition: { type: 'if-none-match' },
    });
    const writeRequest: unknown = writeStatus.mock.calls[0]?.[0];
    expect(Object.isFrozen(writeRequest)).toBe(true);
    expect(Object.isFrozen((writeRequest as { condition: unknown }).condition)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.status)).toBe(true);
    expect(Object.isFrozen(result.statusObservation)).toBe(true);
  });

  it('returns an already-current result without writing', async () => {
    const publication = stablePublication({
      statusRead: {
        body: canonicalStatus(HEAD_STATUS),
        etag: '"current-etag"',
        versionId: 'current-object',
      },
    });

    await expect(publishCurrentAppDeploymentStatus(publication.input, 'stark-dev/develop')).resolves.toEqual({
      disposition: 'already-current',
      status: HEAD_STATUS,
      statusObservation: { etag: '"current-etag"', versionId: 'current-object' },
    });
    expect(publication.resolveHistory).toHaveBeenCalledTimes(3);
    expect(publication.readStatus).toHaveBeenCalledOnce();
    expect(publication.writeStatus).toHaveBeenCalledOnce();
    expect(publication.writeStatus).toHaveBeenCalledWith({
      body: canonicalStatus(HEAD_STATUS),
      condition: { type: 'if-none-match' },
    });
    expect(publication.writeStatus.mock.invocationCallOrder[0]).toBeLessThan(
      publication.readStatus.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('converges an exact retained status with its observed conditional write', async () => {
    const publication = stablePublication({
      statusRead: {
        body: canonicalStatus(RETAINED_STATUS),
        etag: '"retained-etag"',
        versionId: 'retained-object',
      },
    });

    await expect(publishCurrentAppDeploymentStatus(publication.input, 'stark-dev/develop')).resolves.toEqual({
      disposition: 'updated',
      status: HEAD_STATUS,
      statusObservation: { etag: '"written-etag"', versionId: 'written-object' },
    });
    expect(publication.writeStatus.mock.calls).toEqual([
      [{ body: canonicalStatus(HEAD_STATUS), condition: { type: 'if-none-match' } }],
      [
        {
          body: canonicalStatus(HEAD_STATUS),
          condition: {
            type: 'if-match',
            etag: '"retained-etag"',
            versionId: 'retained-object',
          },
        },
      ],
    ]);
  });

  it('restarts before classification when the pointer changes after the status read', async () => {
    const earlier = historyResolution();
    const current = historyResolution({
      headKey: RETAINED_KEY,
      headStatus: NEXT_STATUS,
      retainedStatus: HEAD_STATUS,
      pointerObservation: { etag: '"next-pointer-etag"', versionId: 'next-pointer-object' },
    });
    const resolveHistory = vi
      .fn()
      .mockResolvedValueOnce(earlier)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(current);
    const readStatus = vi.fn().mockResolvedValue(undefined);
    const writeStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValue({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).resolves.toMatchObject({ disposition: 'created', status: NEXT_STATUS });
    expect(resolveHistory).toHaveBeenCalledTimes(4);
    expect(readStatus).toHaveBeenCalledOnce();
    expect(writeStatus.mock.calls).toEqual([
      [{ body: canonicalStatus(HEAD_STATUS), condition: { type: 'if-none-match' } }],
      [{ body: canonicalStatus(NEXT_STATUS), condition: { type: 'if-none-match' } }],
    ]);
  });

  it('restarts when a rebound acceptance changes without changing its display projection', async () => {
    const earlier = historyResolution({ headAcceptanceFact: 'earlier-full-acceptance' });
    const current = historyResolution({ headAcceptanceFact: 'current-full-acceptance' });
    const resolveHistory = vi
      .fn()
      .mockResolvedValueOnce(earlier)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(current);
    const readStatus = vi.fn().mockResolvedValue(undefined);
    const writeStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValue({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).resolves.toMatchObject({ disposition: 'created', status: HEAD_STATUS });
    expect(resolveHistory).toHaveBeenCalledTimes(4);
    expect(readStatus).toHaveBeenCalledOnce();
    expect(writeStatus).toHaveBeenCalledTimes(2);
  });

  it('restarts when only an acceptance object observation changes', async () => {
    const earlier = historyResolution({ headObservationFact: 'earlier-record-observation' });
    const current = historyResolution({ headObservationFact: 'current-record-observation' });
    const resolveHistory = vi
      .fn()
      .mockResolvedValueOnce(earlier)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(current);
    const readStatus = vi.fn().mockResolvedValue(undefined);
    const writeStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValue({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).resolves.toMatchObject({ disposition: 'created', status: HEAD_STATUS });
    expect(resolveHistory).toHaveBeenCalledTimes(4);
    expect(readStatus).toHaveBeenCalledOnce();
    expect(writeStatus).toHaveBeenCalledTimes(2);
  });

  it('restarts when full history changes after an apparent no-op', async () => {
    const earlier = historyResolution({ headAcceptanceFact: 'earlier-full-acceptance' });
    const current = historyResolution({ headAcceptanceFact: 'current-full-acceptance' });
    const resolveHistory = vi
      .fn()
      .mockResolvedValueOnce(earlier)
      .mockResolvedValueOnce(earlier)
      .mockResolvedValue(current);
    const readStatus = vi.fn().mockResolvedValue({
      body: canonicalStatus(HEAD_STATUS),
      etag: '"status-etag"',
      versionId: 'status-object',
    });
    const writeStatus = vi.fn().mockResolvedValue({ status: 'precondition-failed' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).resolves.toEqual({
      disposition: 'already-current',
      status: HEAD_STATUS,
      statusObservation: { etag: '"status-etag"', versionId: 'status-object' },
    });
    expect(resolveHistory).toHaveBeenCalledTimes(6);
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(writeStatus).toHaveBeenCalledTimes(2);
    expect(
      writeStatus.mock.calls.every(
        ([request]) => (request as Readonly<{ condition: { type: string } }>).condition.type === 'if-none-match',
      ),
    ).toBe(true);
  });

  it('reprojects current authority when the pointer changes after a successful write', async () => {
    const earlier = historyResolution();
    const current = historyResolution({
      headKey: RETAINED_KEY,
      headStatus: NEXT_STATUS,
      retainedStatus: HEAD_STATUS,
      pointerObservation: { etag: '"next-pointer-etag"', versionId: 'next-pointer-object' },
    });
    const resolveHistory = vi
      .fn()
      .mockResolvedValueOnce(earlier)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(current);
    const readStatus = vi.fn().mockResolvedValue({
      body: canonicalStatus(HEAD_STATUS),
      etag: '"earlier-write-etag"',
      versionId: 'earlier-write-object',
    });
    const writeStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: 'written', etag: '"earlier-write-etag"', versionId: 'earlier-write-object' })
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValueOnce({ status: 'written', etag: '"current-write-etag"', versionId: 'current-write-object' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).resolves.toEqual({
      disposition: 'updated',
      status: NEXT_STATUS,
      statusObservation: { etag: '"current-write-etag"', versionId: 'current-write-object' },
    });
    expect(resolveHistory).toHaveBeenCalledTimes(5);
    expect(readStatus).toHaveBeenCalledOnce();
    expect(writeStatus).toHaveBeenCalledTimes(3);
    expect(writeStatus.mock.calls).toEqual([
      [{ body: canonicalStatus(HEAD_STATUS), condition: { type: 'if-none-match' } }],
      [{ body: canonicalStatus(NEXT_STATUS), condition: { type: 'if-none-match' } }],
      [
        {
          body: canonicalStatus(NEXT_STATUS),
          condition: {
            type: 'if-match',
            etag: '"earlier-write-etag"',
            versionId: 'earlier-write-object',
          },
        },
      ],
    ]);
  });

  it.each([
    ['first create', undefined, 2],
    [
      'retained update',
      { body: canonicalStatus(RETAINED_STATUS), etag: '"retained-etag"', versionId: 'retained-object' },
      3,
    ],
  ])('recovers when a competing %s wins the conditional write', async (_label, initialRead, expectedWrites) => {
    const resolveHistory = vi.fn().mockResolvedValue(historyResolution());
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(initialRead)
      .mockResolvedValueOnce({
        body: canonicalStatus(HEAD_STATUS),
        etag: '"winner-etag"',
        versionId: 'winner-object',
      });
    const writeStatus = vi.fn().mockResolvedValue({ status: 'precondition-failed' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).resolves.toEqual({
      disposition: 'already-current',
      status: HEAD_STATUS,
      statusObservation: { etag: '"winner-etag"', versionId: 'winner-object' },
    });
    expect(resolveHistory).toHaveBeenCalledTimes(5);
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(writeStatus).toHaveBeenCalledTimes(expectedWrites);
    expect(writeStatus.mock.calls[0]?.[0]).toEqual({
      body: canonicalStatus(HEAD_STATUS),
      condition: { type: 'if-none-match' },
    });
  });

  it('fails after the bounded attempts when the pointer never stays stable', async () => {
    const earlier = historyResolution();
    const current = historyResolution({
      headKey: RETAINED_KEY,
      headStatus: NEXT_STATUS,
      retainedStatus: HEAD_STATUS,
      pointerObservation: { etag: '"next-pointer-etag"', versionId: 'next-pointer-object' },
    });
    let resolutionCall = 0;
    const resolveHistory = vi.fn(() => Promise.resolve(resolutionCall++ % 2 === 0 ? earlier : current));
    const readStatus = vi.fn();
    const writeStatus = vi
      .fn()
      .mockResolvedValue({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/did not converge.*five/u);
    expect(resolveHistory).toHaveBeenCalledTimes(10);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).toHaveBeenCalledTimes(APP_DEPLOYMENT_STATUS_MAX_ATTEMPTS);
  });

  it.each([
    ['malformed', '{', 2],
    ['over-limit', 'x'.repeat(4097), 1],
    ['unrelated', canonicalStatus(deploymentStatus(`dep_${'4'.repeat(32)}`)), 2],
  ])('rejects a %s status after only the failed create', async (_label, body, expectedResolutionCalls) => {
    const publication = stablePublication({
      statusRead: { body, etag: '"status-etag"', versionId: 'status-object' },
    });

    await expect(publishCurrentAppDeploymentStatus(publication.input, 'stark-dev/develop')).rejects.toThrow();
    expect(publication.resolveHistory).toHaveBeenCalledTimes(expectedResolutionCalls);
    expect(publication.readStatus).toHaveBeenCalledOnce();
    expect(publication.writeStatus).toHaveBeenCalledOnce();
    expect(publication.writeStatus).toHaveBeenCalledWith({
      body: canonicalStatus(HEAD_STATUS),
      condition: { type: 'if-none-match' },
    });
    expect(publication.writeStatus.mock.invocationCallOrder[0]).toBeLessThan(
      publication.readStatus.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('propagates history resolution failure without reading or writing status', async () => {
    const error = new Error('history I/O failed');
    const resolveHistory = vi.fn().mockRejectedValue(error);
    const readStatus = vi.fn();
    const writeStatus = vi.fn();

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toBe(error);
    expect(resolveHistory).toHaveBeenCalledOnce();
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
  });

  it('propagates an access-denied status read after only the failed create', async () => {
    const error = new Error('AccessDenied');
    const resolveHistory = vi.fn().mockResolvedValue(historyResolution());
    const readStatus = vi.fn().mockRejectedValue(error);
    const writeStatus = vi.fn().mockResolvedValue({ status: 'precondition-failed' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toBe(error);
    expect(resolveHistory).toHaveBeenCalledOnce();
    expect(readStatus).toHaveBeenCalledOnce();
    expect(writeStatus).toHaveBeenCalledOnce();
  });

  it('propagates status write I/O failure without a post-write resolution', async () => {
    const error = new Error('status write I/O failed');
    const resolveHistory = vi.fn().mockResolvedValue(historyResolution());
    const readStatus = vi.fn();
    const writeStatus = vi.fn().mockRejectedValue(error);

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toBe(error);
    expect(resolveHistory).toHaveBeenCalledOnce();
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown outcome', { status: 'unknown' }],
    ['extra written field', { status: 'written', etag: '"written-etag"', versionId: 'written-object', unknown: true }],
    ['extra precondition field', { status: 'precondition-failed', unknown: true }],
  ])('rejects an invalid write result with %s', async (_label, writeResult) => {
    const publication = stablePublication({ writeResult });

    await expect(publishCurrentAppDeploymentStatus(publication.input, 'stark-dev/develop')).rejects.toThrow(
      /result|shape/iu,
    );
    expect(publication.resolveHistory).toHaveBeenCalledOnce();
    expect(publication.readStatus).not.toHaveBeenCalled();
    expect(publication.writeStatus).toHaveBeenCalledOnce();
  });

  it('captures injected functions once and invokes them with frozen detached owners', async () => {
    const replacementResolve = vi.fn();
    const replacementRead = vi.fn();
    const replacementWrite = vi.fn();
    const resolveOwners: unknown[] = [];
    const statusOwners: unknown[] = [];
    const resolveHistory = vi.fn(function (this: unknown) {
      resolveOwners.push(this);
      input.resolveHistory = replacementResolve;
      input.statusStore.readStatus = replacementRead;
      input.statusStore.writeStatus = replacementWrite;
      return Promise.resolve(historyResolution());
    });
    const readStatus = vi.fn(function (this: unknown) {
      statusOwners.push(this);
      return Promise.resolve(undefined);
    });
    const writeStatus = vi.fn(function (this: unknown) {
      statusOwners.push(this);
      return Promise.resolve({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });
    });
    const input = { resolveHistory, statusStore: { readStatus, writeStatus } };

    await expect(publishCurrentAppDeploymentStatus(input, 'stark-dev/develop')).resolves.toMatchObject({
      disposition: 'created',
    });
    expect(resolveHistory).toHaveBeenCalledTimes(2);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).toHaveBeenCalledOnce();
    expect(replacementResolve).not.toHaveBeenCalled();
    expect(replacementRead).not.toHaveBeenCalled();
    expect(replacementWrite).not.toHaveBeenCalled();
    expect(resolveOwners.every((owner) => Object.isFrozen(owner) && owner !== input)).toBe(true);
    expect(statusOwners.every((owner) => Object.isFrozen(owner) && owner !== input.statusStore)).toBe(true);
  });

  it('rejects proxied or accessor-bearing ports without invoking their traps', async () => {
    let proxyTraps = 0;
    const proxiedStore = new Proxy(
      { readStatus: vi.fn(), writeStatus: vi.fn() },
      {
        get() {
          proxyTraps += 1;
          return vi.fn();
        },
        ownKeys() {
          proxyTraps += 1;
          return [];
        },
      },
    );
    const resolveHistory = vi.fn();
    await expect(
      publishCurrentAppDeploymentStatus({ resolveHistory, statusStore: proxiedStore }, 'stark-dev/develop'),
    ).rejects.toThrow(/proxy/iu);
    expect(proxyTraps).toBe(0);
    expect(resolveHistory).not.toHaveBeenCalled();

    let accessorCalls = 0;
    const accessorStore = { writeStatus: vi.fn() } as Record<string, unknown>;
    Object.defineProperty(accessorStore, 'readStatus', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return vi.fn();
      },
    });
    await expect(
      publishCurrentAppDeploymentStatus({ resolveHistory, statusStore: accessorStore }, 'stark-dev/develop'),
    ).rejects.toThrow(/data|shape/iu);
    expect(accessorCalls).toBe(0);
    expect(resolveHistory).not.toHaveBeenCalled();
  });

  it('rejects proxied resolver and status results without invoking their property traps', async () => {
    let proxyTraps = 0;
    const proxiedHistory = new Proxy(historyResolution(), {
      get() {
        proxyTraps += 1;
        return 'swapped';
      },
      ownKeys() {
        proxyTraps += 1;
        return [];
      },
    });
    const resolveHistory = vi.fn().mockReturnValue(proxiedHistory);
    const readStatus = vi.fn();
    const writeStatus = vi.fn();
    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/proxy/iu);
    expect(proxyTraps).toBe(0);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();

    const proxiedRead = new Proxy(
      { body: canonicalStatus(HEAD_STATUS), etag: '"status-etag"', versionId: 'status-object' },
      {
        get() {
          proxyTraps += 1;
          return 'swapped';
        },
      },
    );
    const cleanResolve = vi.fn().mockResolvedValue(historyResolution());
    const proxiedReadStatus = vi.fn().mockReturnValue(proxiedRead);
    writeStatus.mockResolvedValue({ status: 'precondition-failed' });
    await expect(
      publishCurrentAppDeploymentStatus(
        {
          resolveHistory: cleanResolve,
          statusStore: { readStatus: proxiedReadStatus, writeStatus },
        },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/proxy/iu);
    expect(proxyTraps).toBe(0);
    expect(cleanResolve).toHaveBeenCalledOnce();
    expect(writeStatus).toHaveBeenCalledOnce();
  });

  it('rejects a synchronous history result with an own then accessor without invoking it', async () => {
    let thenAccessorCalls = 0;
    const historyWithThen = { ...historyResolution() } as Record<string, unknown>;
    Object.defineProperty(historyWithThen, 'then', {
      enumerable: true,
      get() {
        thenAccessorCalls += 1;
        return undefined;
      },
    });
    const resolveHistory = vi.fn().mockReturnValue(historyWithThen);
    const readStatus = vi.fn();
    const writeStatus = vi.fn();

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/shape|data/iu);
    expect(thenAccessorCalls).toBe(0);
    expect(resolveHistory).toHaveBeenCalledOnce();
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
  });

  it('rejects a synchronous status read with an own then accessor without invoking it', async () => {
    let thenAccessorCalls = 0;
    const readWithThen = {
      body: canonicalStatus(HEAD_STATUS),
      etag: '"status-etag"',
      versionId: 'status-object',
    } as Record<string, unknown>;
    Object.defineProperty(readWithThen, 'then', {
      enumerable: true,
      get() {
        thenAccessorCalls += 1;
        return undefined;
      },
    });
    const resolveHistory = vi.fn().mockResolvedValue(historyResolution());
    const readStatus = vi.fn().mockReturnValue(readWithThen);
    const writeStatus = vi.fn().mockReturnValue({ status: 'precondition-failed' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/shape|data/iu);
    expect(thenAccessorCalls).toBe(0);
    expect(resolveHistory).toHaveBeenCalledOnce();
    expect(readStatus).toHaveBeenCalledOnce();
    expect(writeStatus).toHaveBeenCalledOnce();
  });

  it('rejects a synchronous write result with an own then accessor without invoking it', async () => {
    let thenAccessorCalls = 0;
    const writeWithThen = {
      status: 'written',
      etag: '"written-etag"',
      versionId: 'written-object',
    } as Record<string, unknown>;
    Object.defineProperty(writeWithThen, 'then', {
      enumerable: true,
      get() {
        thenAccessorCalls += 1;
        return undefined;
      },
    });
    const resolveHistory = vi.fn().mockResolvedValue(historyResolution());
    const readStatus = vi.fn();
    const writeStatus = vi.fn().mockReturnValue(writeWithThen);

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/shape|data/iu);
    expect(thenAccessorCalls).toBe(0);
    expect(resolveHistory).toHaveBeenCalledOnce();
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).toHaveBeenCalledOnce();
  });

  it('admits exact synchronous results from every port', async () => {
    const resolveHistory = vi.fn().mockReturnValue(historyResolution());
    const readStatus = vi.fn().mockReturnValue(undefined);
    const writeStatus = vi
      .fn()
      .mockReturnValue({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).resolves.toEqual({
      disposition: 'created',
      status: HEAD_STATUS,
      statusObservation: { etag: '"written-etag"', versionId: 'written-object' },
    });
    expect(resolveHistory).toHaveBeenCalledTimes(2);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).toHaveBeenCalledOnce();
  });

  it('settles native promises without reading an own then accessor', async () => {
    let thenAccessorCalls = 0;
    function guardedPromise(value: unknown) {
      const promise = Promise.resolve(value);
      return Object.defineProperty(promise, 'then', {
        configurable: true,
        enumerable: true,
        get() {
          thenAccessorCalls += 1;
          throw new Error('own then accessor must not run');
        },
      });
    }
    let resolveCalls = 0;
    let readCalls = 0;
    let writeCalls = 0;
    const resolveHistory = () => {
      resolveCalls += 1;
      return guardedPromise(historyResolution());
    };
    const readStatus = () => {
      readCalls += 1;
      return guardedPromise(undefined);
    };
    const writeStatus = () => {
      writeCalls += 1;
      return guardedPromise({ status: 'written', etag: '"written-etag"', versionId: 'written-object' });
    };

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).resolves.toMatchObject({ disposition: 'created' });
    expect(thenAccessorCalls).toBe(0);
    expect(resolveCalls).toBe(2);
    expect(readCalls).toBe(0);
    expect(writeCalls).toBe(1);
  });

  it('rejects a branded promise with an own constructor accessor without invoking it', async () => {
    let constructorAccessorCalls = 0;
    const historyPromise = Promise.resolve(historyResolution());
    const guardedHistoryPromise = Object.defineProperty(historyPromise, 'constructor', {
      configurable: true,
      enumerable: true,
      get() {
        constructorAccessorCalls += 1;
        return Promise;
      },
    });
    const resolveHistory = () => guardedHistoryPromise;
    const readStatus = vi.fn();
    const writeStatus = vi.fn();

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/promise|constructor|shape/iu);
    expect(constructorAccessorCalls).toBe(0);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
  });

  it.each([
    [
      'subclass',
      () => {
        class DerivedPromise<T> extends Promise<T> {}
        return DerivedPromise.resolve(historyResolution());
      },
    ],
    [
      'custom prototype',
      () => {
        const promise = Promise.resolve(historyResolution());
        Object.setPrototypeOf(promise, Object.freeze({}));
        return promise;
      },
    ],
  ])('rejects a native promise %s before reading or writing status', async (_label, promiseFactory) => {
    const resolveHistory = () => promiseFactory();
    const readStatus = vi.fn();
    const writeStatus = vi.fn();

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/promise|prototype/iu);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
  });

  it('does not re-assimilate a fulfillment object changed after its promise resolved', async () => {
    let thenAccessorCalls = 0;
    const resolvedHistory = { ...historyResolution() } as Record<string, unknown>;
    const historyPromise = Promise.resolve(resolvedHistory);
    Object.defineProperty(resolvedHistory, 'then', {
      enumerable: true,
      get() {
        thenAccessorCalls += 1;
        return undefined;
      },
    });
    const resolveHistory = () => historyPromise;
    const readStatus = vi.fn();
    const writeStatus = vi.fn();

    await expect(
      publishCurrentAppDeploymentStatus(
        { resolveHistory, statusStore: { readStatus, writeStatus } },
        'stark-dev/develop',
      ),
    ).rejects.toThrow(/shape|data/iu);
    expect(thenAccessorCalls).toBe(0);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
  });
});

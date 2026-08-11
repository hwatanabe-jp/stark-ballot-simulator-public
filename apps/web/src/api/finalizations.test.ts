import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  fetchCurrentFinalization,
  parseFinalizationResource,
  resolveFinalizationStatusErrorCode,
} from './finalizations';
import { ApiClientError } from './client';
import {
  clearBrowserPublicEnvForTests,
  setBrowserPublicEnvForTests,
} from '@stark-ballot/runtime-config/env/browserPublic';

const sessionId = '1f8c6e60-8dec-4a44-b19c-c226bb7de6be';
const identity = { sessionId, capabilityToken: 'token-123' };
const requestMeta = { requestId: 'request-id' } as const;
const finalizationId = '01HVN5WA1CEH94868G90QGJ7HX';
const hex = (character: string): string => `0x${character.repeat(64)}`;

const journal = {
  electionId: '550e8400-e29b-41d4-a716-446655440000',
  electionConfigHash: hex('a'),
  bulletinRoot: hex('1'),
  treeSize: 64,
  totalExpected: 64,
  sthDigest: hex('2'),
  verifiedTally: [32, 32, 0, 0, 0],
  totalVotes: 64,
  validVotes: 64,
  invalidVotes: 0,
  seenIndicesCount: 64,
  missingSlots: 0,
  invalidPresentedSlots: 0,
  rejectedRecords: 0,
  seenBitmapRoot: hex('3'),
  includedBitmapRoot: hex('4'),
  excludedSlots: 0,
  inputCommitment: hex('5'),
  methodVersion: CURRENT_METHOD_VERSION,
} as const;

const buildPresentation = () => ({
  tally: {
    counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
    totalVotes: 64,
    tamperedCount: 0,
  },
  verifiedTally: [32, 32, 0, 0, 0],
  bulletinRoot: journal.bulletinRoot,
  missingSlots: 0,
  invalidPresentedSlots: 0,
  rejectedRecords: 0,
  totalExpected: 64,
  treeSize: 64,
  excludedSlots: 0,
  sthDigest: journal.sthDigest,
  seenBitmapRoot: journal.seenBitmapRoot,
  includedBitmapRoot: journal.includedBitmapRoot,
  inputCommitment: journal.inputCommitment,
  seenIndicesCount: 64,
  verificationStatus: 'not_run' as const,
});

const buildSucceededResource = () => ({
  finalizationId,
  status: 'succeeded' as const,
  queuedAtMs: 1730000000000,
  startedAtMs: 1730000001000,
  completedAtMs: 1730000005000,
  runtimeDiagnostics: {
    asyncMode: 'enabled' as const,
    queue: null,
    orchestrator: {
      status: 'SUCCEEDED',
      startTimeMs: 1730000001000,
      stopTimeMs: 1730000005000,
    },
  },
  result: {
    authority: {
      imageId: hex('6'),
      journal,
    },
    presentation: buildPresentation(),
    voterEvidence: {
      state: 'verification-gated' as const,
    },
    artifactAvailability: {
      bundle: 'available' as const,
      report: 'available' as const,
      includedBitmap: 'available' as const,
      seenBitmap: 'available' as const,
    },
  },
});

const buildRunningResource = () => ({
  finalizationId,
  status: 'running' as const,
  queuedAtMs: 1730000000000,
  startedAtMs: 1730000001000,
  runtimeDiagnostics: {
    asyncMode: 'enabled' as const,
    queue: null,
  },
});

function successEnvelope<T>(data: T) {
  return { data, meta: requestMeta };
}

function errorEnvelope(code: string, message: string) {
  return {
    error: { code, message },
    meta: requestMeta,
  };
}

describe('finalization resource client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    setBrowserPublicEnvForTests('VITE_RUNTIME_PROFILE', 'static-mock-e2e');
  });

  afterEach(() => {
    clearBrowserPublicEnvForTests();
  });

  it('parses a successful current-finalization response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successEnvelope(buildRunningResource())), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchMock;

    const result = await fetchCurrentFinalization(identity, { baseUrl: 'https://example.com' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/sessions/1f8c6e60-8dec-4a44-b19c-c226bb7de6be/finalizations/current',
      {
        headers: { 'X-Session-Capability': 'token-123' },
        method: 'GET',
      },
    );
    expect(result?.status).toBe('running');
    expect(result?.finalizationId).toBe(finalizationId);
  });

  it('sends only path-scoped capability auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successEnvelope(null)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchMock;

    await fetchCurrentFinalization(identity, { baseUrl: 'https://example.com' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/finalizations/current'),
      expect.objectContaining({
        headers: {
          'X-Session-Capability': 'token-123',
        },
      }),
    );
  });

  it('throws when the server returns an error response', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errorEnvelope('SESSION_NOT_FOUND', 'Session not found')), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchCurrentFinalization(identity, { baseUrl: 'https://example.com' })).rejects.toThrow(
      ApiClientError,
    );
  });

  it('extracts the API error code from ApiClientError payloads', () => {
    const error = new ApiClientError('missing', 404, errorEnvelope('SESSION_NOT_FOUND', 'Session not found'));

    expect(resolveFinalizationStatusErrorCode(error)).toBe('SESSION_NOT_FOUND');
    expect(resolveFinalizationStatusErrorCode(new Error('plain error'))).toBeNull();
  });

  it('fails fast when the resource shape is invalid', () => {
    expect(() => parseFinalizationResource({ status: 'unknown' })).toThrowError(
      /Invalid finalization resource payload:/,
    );
  });

  it('parses succeeded resource authority and orchestrator diagnostics', () => {
    const parsed = parseFinalizationResource(buildSucceededResource());

    expect(parsed.status).toBe('succeeded');
    if (parsed.status !== 'succeeded') {
      throw new Error('Expected succeeded resource');
    }
    expect(parsed.result.authority.journal.methodVersion).toBe(CURRENT_METHOD_VERSION);
    expect(parsed.runtimeDiagnostics.orchestrator?.status).toBe('SUCCEEDED');
  });

  it('rejects the retired embedded artifactState projection', () => {
    expect(() =>
      parseFinalizationResource({
        ...buildRunningResource(),
        artifactState: 'unsupported_current_artifact',
      }),
    ).toThrowError(/Invalid finalization resource payload:/);
  });

  it('rejects unexpected server-only fields in the presentation result', () => {
    const resource = buildSucceededResource() as unknown as Record<string, unknown>;
    const result = resource['result'] as Record<string, unknown>;
    const presentation = result['presentation'] as Record<string, unknown>;
    presentation['bitmapData'] = { includedBitmap: [true] };

    expect(() => parseFinalizationResource(resource)).toThrowError(/Invalid finalization resource payload:/);
  });

  it('rejects non-canonical journal payloads in finalization authority', () => {
    const resource = buildSucceededResource() as unknown as Record<string, unknown>;
    const result = resource['result'] as Record<string, unknown>;
    const authority = result['authority'] as Record<string, unknown>;
    authority['journal'] = { electionId: journal.electionId, treeSize: 64 };

    expect(() => parseFinalizationResource(resource)).toThrowError(/Invalid finalization resource payload:/);
  });

  it('parses dev_mode verification reports without local file paths', () => {
    const resource = buildSucceededResource() as unknown as Record<string, unknown>;
    const result = resource['result'] as Record<string, unknown>;
    const presentation = result['presentation'] as Record<string, unknown>;
    presentation['verificationStatus'] = 'dev_mode';
    Object.assign(presentation, {
      verificationReport: {
        status: 'dev_mode',
        verifier_version: '1.0.0',
        verified_at: '2026-01-01T00:00:00.000Z',
        duration_ms: 12,
        expected_image_id: hex('6'),
        receipt_image_id: hex('6'),
        dev_mode_receipt: true,
      },
    });

    const parsed = parseFinalizationResource(resource);

    expect(parsed.status).toBe('succeeded');
    if (parsed.status !== 'succeeded') {
      throw new Error('Expected succeeded resource');
    }
    expect(parsed.result.presentation.verificationReport).toMatchObject({
      status: 'dev_mode',
      dev_mode_receipt: true,
    });
  });

  it('parses bounded queue diagnostics when present', () => {
    const resource = {
      ...buildRunningResource(),
      runtimeDiagnostics: {
        asyncMode: 'enabled' as const,
        queue: {
          concurrencyLimit: 2,
          estimatedDurationMs: 360000,
        },
      },
    };

    expect(parseFinalizationResource(resource).runtimeDiagnostics.queue).toEqual({
      concurrencyLimit: 2,
      estimatedDurationMs: 360000,
    });
  });

  it('rejects legacy queue payloads with positional claims', () => {
    const resource = buildRunningResource() as unknown as Record<string, unknown>;
    resource['runtimeDiagnostics'] = {
      asyncMode: 'enabled',
      queue: {
        position: 3,
        depth: 8,
        concurrencyLimit: 2,
        estimatedStartAt: 1730000020000,
        estimatedDurationMs: 360000,
        estimatedCompletionAt: 1730000260000,
      },
    };

    expect(() => parseFinalizationResource(resource)).toThrow('Invalid finalization resource payload');
  });

  it('accepts explicit null queue diagnostics', () => {
    expect(parseFinalizationResource(buildRunningResource()).runtimeDiagnostics.queue).toBeNull();
  });

  it('accepts short finalization IDs allowed by the shared contract', () => {
    const parsed = parseFinalizationResource({
      ...buildRunningResource(),
      finalizationId: 'finalization-1',
    });

    expect(parsed.finalizationId).toBe('finalization-1');
  });

  it('accepts succeeded resources when tally.tamperedCount is omitted', () => {
    const resource = buildSucceededResource();
    const tally = resource.result.presentation.tally as {
      counts: Record<string, number>;
      totalVotes: number;
      tamperedCount?: number;
    };
    delete tally.tamperedCount;

    const parsed = parseFinalizationResource(resource);

    expect(parsed.status).toBe('succeeded');
    if (parsed.status !== 'succeeded') {
      throw new Error('Expected succeeded resource');
    }
    expect(parsed.result.presentation.tally.totalVotes).toBe(64);
    expect(parsed.result.presentation.tally.tamperedCount).toBeUndefined();
  });
});

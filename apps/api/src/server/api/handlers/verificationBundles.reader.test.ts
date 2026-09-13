import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFinalizationResultFromJournal } from '@stark-ballot/application/finalize/finalization-result';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationId,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import { asFinalizationId } from '@stark-ballot/application/finalize/finalization-id';
import type { ArtifactReader, ArtifactReadResult } from '@stark-ballot/application/verification/artifact-reader';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/schemas/errors';
import { createMockVoteStore } from '../../test-support/mockVoteStore';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { getApiErrorCode, readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { localRuntimeProfile } from '@stark-ballot/runtime-config/env/test-support/runtimeProfileFixtures';
import { getVerificationBundleHandler, getVerificationReportHandler } from './verificationBundles';
import { asSessionId, type SessionId } from '@stark-ballot/domain/types/identifiers';

const canonicalEventMocks = vi.hoisted(() => ({
  emitCanonicalEvent: vi.fn(),
}));

vi.mock('@stark-ballot/diagnostics/canonicalEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stark-ballot/diagnostics/canonicalEvents')>()),
  emitCanonicalEvent: canonicalEventMocks.emitCanonicalEvent,
}));

const scenarioContext: FinalizationScenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 1,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
};

function buildFinalizedRecord(sessionId: SessionId, finalizationId: FinalizationId): FinalizationRecord {
  const now = Date.now();
  const journal = createTestJournal({
    validVotes: 1,
    totalExpected: 1,
    seenIndicesCount: 1,
  });
  return {
    sessionId,
    finalizationId,
    scenarioContext,
    state: {
      status: 'succeeded',
      finalizationId,
      queuedAtMs: now - 2_000,
      startedAtMs: now - 1_000,
      completedAtMs: now,
    },
    finalizationResult: {
      finalizationId,
      ...buildFinalizationResultFromJournal({
        journal,
        imageId: `0x${'12'.repeat(32)}`,
      }),
    },
  };
}

function readerReturning(result: ArtifactReadResult): ArtifactReader {
  return {
    read: vi.fn().mockResolvedValue(result),
  };
}

function contextFor(
  sessionId: SessionId,
  finalizationId: FinalizationId,
  artifactReader: ArtifactReader,
  finalization: FinalizationRecord | null = buildFinalizedRecord(sessionId, finalizationId),
) {
  return {
    store: createMockVoteStore({
      getCurrentFinalizationRecord: vi.fn().mockResolvedValue(finalization),
    }),
    runtimeProfile: localRuntimeProfile(),
    requestId: 'artifact-reader-handler-request',
    requestOrigin: 'http://localhost',
    operatorGatedDevelop: false,
    sessionId,
    finalizationId,
    artifactDeliveryDependencies: { artifactReader },
  };
}

async function expectStandardError(response: Response, status: number, code: string): Promise<void> {
  const payload = await readJsonRecord(response, 'artifact error');
  expect(response.status).toBe(status);
  expect(StandardErrorResponseSchema.safeParse(payload).success).toBe(true);
  expect(getApiErrorCode(payload)).toBe(code);
}

describe('verification artifact handler reader mapping', () => {
  const sessionId = asSessionId('session-1');
  const finalizationId = asFinalizationId('finalization-1');
  const headers = { 'X-Session-Capability': 'admitted-by-transport' };

  beforeEach(() => {
    canonicalEventMocks.emitCanonicalEvent.mockReset();
  });

  it.each([
    ['bytes=1-20', { kind: 'closed', start: 1, end: 20 }],
    ['bytes=1-', { kind: 'openEnded', start: 1 }],
    ['bytes=-7', { kind: 'suffix', length: 7 }],
    ['items=1-2', { kind: 'invalid' }],
  ] as const)('passes a transport-neutral %s range to the reader', async (Range, expectedRange) => {
    const reader = readerReturning({ kind: 'invalidRange', totalBytes: 32 });

    await getVerificationBundleHandler({
      input: {
        params: { sessionId, finalizationId },
        headers: { ...headers, Range },
      },
      context: contextFor(sessionId, finalizationId, reader),
    });

    expect(reader.read).toHaveBeenCalledWith({
      artifact: 'bundle',
      sessionId,
      finalizationId,
      range: expectedRange,
    });
  });

  it('returns exact ranged bundle bytes with stable delivery headers', async () => {
    const bytes = Uint8Array.from([0, 255, 1, 2]);
    const reader = readerReturning({
      kind: 'range',
      bytes,
      totalBytes: 12,
      start: 4,
      end: 7,
      representation: {
        etag: '"etag-1"',
        versionId: 'version-1',
      },
    });

    const response = await getVerificationBundleHandler({
      input: {
        params: { sessionId, finalizationId },
        headers: { ...headers, Range: 'bytes=4-7' },
      },
      context: contextFor(sessionId, finalizationId, reader),
    });

    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="${finalizationId}.zip"`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Range')).toBe('bytes 4-7/12');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('X-Stark-Bundle-Range-Chunk-Size')).toBe(String(4 * 1024 * 1024));
    expect(response.headers.get('ETag')).toBe('"etag-1"');
    expect(response.headers.get('X-Amz-Version-Id')).toBe('version-1');
  });

  it('fails closed when a ranged reader result omits representation identity', async () => {
    const reader = readerReturning({
      kind: 'range',
      bytes: Uint8Array.from([0, 1, 2, 3]),
      totalBytes: 8,
      start: 0,
      end: 3,
      representation: {},
    });

    const response = await getVerificationBundleHandler({
      input: {
        params: { sessionId, finalizationId },
        headers: { ...headers, Range: 'bytes=0-3' },
      },
      context: contextFor(sessionId, finalizationId, reader),
    });

    await expectStandardError(response, 500, 'BUNDLE_DOWNLOAD_FAILED');
    expect(response.headers.get('ETag')).toBeNull();
    expect(response.headers.get('X-Amz-Version-Id')).toBeNull();
  });

  it('returns exact report bytes without wrapping or reserialization', async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x7b, 0x7d]);
    const reader = readerReturning({
      kind: 'full',
      bytes,
      totalBytes: bytes.byteLength,
      representation: {},
    });

    const response = await getVerificationReportHandler({
      input: {
        params: { sessionId, finalizationId },
        headers,
      },
      context: contextFor(sessionId, finalizationId, reader),
    });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Content-Disposition')).toBe(`inline; filename="${finalizationId}-verification.json"`);
    expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(reader.read).toHaveBeenCalledWith({
      artifact: 'report',
      sessionId,
      finalizationId,
    });
  });

  it.each([
    ['bundle', { kind: 'notFound' }, 404, 'BUNDLE_NOT_FOUND'],
    ['bundle', { kind: 'invalidRange', totalBytes: 10 }, 416, 'INVALID_RANGE'],
    ['bundle', { kind: 'tooLarge', totalBytes: 10 }, 413, 'BUNDLE_REQUIRES_RANGE_DOWNLOAD'],
    ['bundle', { kind: 'unavailable', failureKind: 'accessDenied' }, 500, 'BUNDLE_DOWNLOAD_FAILED'],
    ['report', { kind: 'notFound' }, 404, 'REPORT_NOT_FOUND'],
    ['report', { kind: 'tooLarge', totalBytes: 10 }, 413, 'REPORT_DOWNLOAD_TOO_LARGE'],
    ['report', { kind: 'unavailable', failureKind: 'timeout' }, 500, 'REPORT_DOWNLOAD_FAILED'],
  ] as const)('maps %s reader outcome %# to the declared error', async (artifact, result, status, code) => {
    const reader = readerReturning(result);
    const response =
      artifact === 'bundle'
        ? await getVerificationBundleHandler({
            input: {
              params: { sessionId, finalizationId },
              headers,
            },
            context: contextFor(sessionId, finalizationId, reader),
          })
        : await getVerificationReportHandler({
            input: {
              params: { sessionId, finalizationId },
              headers,
            },
            context: contextFor(sessionId, finalizationId, reader),
          });

    await expectStandardError(response, status, code);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (artifact === 'bundle' && (result.kind === 'tooLarge' || result.kind === 'invalidRange')) {
      expect(response.headers.get('Content-Range')).toBe('bytes */10');
      expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    }
  });

  it('uses report-not-found for missing finalization scope without invoking the reader', async () => {
    const reader = readerReturning({ kind: 'full', bytes: new Uint8Array(), totalBytes: 0, representation: {} });

    const response = await getVerificationReportHandler({
      input: {
        params: { sessionId, finalizationId },
        headers,
      },
      context: contextFor(sessionId, finalizationId, reader, null),
    });

    await expectStandardError(response, 404, 'REPORT_NOT_FOUND');
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('emits only bounded failure fields and preserves the response if telemetry throws', async () => {
    canonicalEventMocks.emitCanonicalEvent.mockImplementationOnce(() => {
      throw new Error('telemetry unavailable');
    });
    const reader = readerReturning({
      kind: 'unavailable',
      failureKind: 'accessDenied',
    });

    const response = await getVerificationBundleHandler({
      input: {
        params: { sessionId, finalizationId },
        headers,
      },
      context: contextFor(sessionId, finalizationId, reader),
    });

    await expectStandardError(response, 500, 'BUNDLE_DOWNLOAD_FAILED');
    expect(canonicalEventMocks.emitCanonicalEvent).toHaveBeenCalledOnce();
    const emittedEvent: unknown = canonicalEventMocks.emitCanonicalEvent.mock.calls[0]?.[0];
    expect(emittedEvent).toMatchObject({
      event: 'bundle_download_failed',
      endpoint: 'bundle',
      http_status: 500,
      s3_error_code: 'access_denied',
      finalization_id: finalizationId,
    });
    if (typeof emittedEvent !== 'object' || emittedEvent === null) {
      throw new Error('Expected a canonical event payload');
    }
    expect(Reflect.get(emittedEvent, 'key_prefix')).toMatch(/^key_[0-9a-f]{12}$/);
    expect(Reflect.get(emittedEvent, 'session_id_hash')).toMatch(/^sid_[0-9a-f]{12}$/);
    expect(JSON.stringify(canonicalEventMocks.emitCanonicalEvent.mock.calls)).not.toContain('s3://');
  });
});

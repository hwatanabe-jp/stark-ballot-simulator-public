import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FinalizationStatusError,
  fetchFinalizationStatus,
  parseFinalizationStatusResponse,
  resolveFinalizationStatusErrorCode,
} from '../finalization-status-client';

const sessionId = '1f8c6e60-8dec-4a44-b19c-c226bb7de6be';

describe('finalization status client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('parses a successful status response', async () => {
    const responsePayload = {
      sessionId,
      finalizationState: {
        status: 'running',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
        queuedAt: 1730000000000,
        startedAt: 1730000001000,
        stepFunctionsArn: undefined,
      },
      finalizationResult: null,
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    global.fetch = fetchMock;

    const result = await fetchFinalizationStatus(sessionId, { baseUrl: 'https://example.com' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/sessions/1f8c6e60-8dec-4a44-b19c-c226bb7de6be/status',
      {
        headers: { Accept: 'application/json' },
        method: 'GET',
        signal: undefined,
      },
    );

    expect(result.sessionId).toBe(sessionId);
    expect(result.finalizationState?.status).toBe('running');
    expect(result.finalizationState?.executionId).toBe('01HVN5WA1CEH94868G90QGJ7HX');
    expect(result.artifactState).toBeUndefined();
    expect(result.queue).toBeNull();
  });

  it('sends auth headers when provided', async () => {
    const responsePayload = {
      sessionId,
      finalizationState: null,
      finalizationResult: null,
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchMock;

    await fetchFinalizationStatus(sessionId, {
      baseUrl: 'https://example.com',
      authHeaders: {
        'X-Session-ID': sessionId,
        'X-Session-Capability': 'token-123',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/sessions/1f8c6e60-8dec-4a44-b19c-c226bb7de6be/status',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'X-Session-ID': sessionId,
          'X-Session-Capability': 'token-123',
        },
      }),
    );
  });

  it('throws when the server returns an error response', async () => {
    const errorPayload = { error: 'Session not found' };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errorPayload), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    global.fetch = fetchMock;

    await expect(fetchFinalizationStatus(sessionId, { baseUrl: 'https://example.com' })).rejects.toThrow(
      FinalizationStatusError,
    );
  });

  it('extracts the API error code from FinalizationStatusError payloads', () => {
    const error = new FinalizationStatusError('missing', 404, {
      error: 'SESSION_NOT_FOUND',
      message: 'Session not found',
    });

    expect(resolveFinalizationStatusErrorCode(error)).toBe('SESSION_NOT_FOUND');
    expect(resolveFinalizationStatusErrorCode(new Error('plain error'))).toBeNull();
  });

  it('fails fast when payload shape is invalid', () => {
    const invalidPayload = {
      sessionId,
      finalizationState: { status: 'unknown' },
      asyncFinalizationMode: 'enabled',
    };

    expect(() => parseFinalizationStatusResponse(invalidPayload)).toThrowError(/Invalid finalization status payload:/);
  });

  it('parses succeeded state with step functions info', () => {
    const journal = {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 64,
      totalExpected: 64,
      sthDigest: '0x' + '2'.repeat(64),
      verifiedTally: [32, 32, 0, 0, 0],
      totalVotes: 64,
      validVotes: 64,
      invalidVotes: 0,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      seenBitmapRoot: '0x' + '3'.repeat(64),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      excludedSlots: 0,
      inputCommitment: '0x' + '5'.repeat(64),
      methodVersion: 12,
    } as const;
    const responsePayload = {
      sessionId,
      finalizationState: {
        status: 'succeeded',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
        queuedAt: 1730000000000,
        startedAt: 1730000001000,
        completedAt: 1730000005000,
        stepFunctionsArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
      },
      finalizationResult: {
        tally: {
          counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '6'.repeat(64),
        verifiedTally: [32, 32, 0, 0, 0],
        journal,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        totalExpected: 64,
        treeSize: 64,
        excludedSlots: 0,
        sthDigest: '0x' + '2'.repeat(64),
        seenBitmapRoot: '0x' + '3'.repeat(64),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        inputCommitment: '0x' + '5'.repeat(64),
        seenIndicesCount: 64,
      },
      stepFunctions: {
        executionArn: 'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:exec-001',
        status: 'SUCCEEDED',
        startTime: 1730000001000,
        stopTime: 1730000005000,
        error: null,
        cause: null,
      },
      asyncFinalizationMode: 'enabled',
    } as const;

    const parsed = parseFinalizationStatusResponse(responsePayload);

    expect(parsed.finalizationState?.status).toBe('succeeded');
    expect(parsed.stepFunctions?.status).toBe('SUCCEEDED');
  });

  it('preserves artifactState when the status response is fail-closed', () => {
    const parsed = parseFinalizationStatusResponse({
      sessionId,
      finalizationState: null,
      artifactState: 'unsupported_current_artifact',
      finalizationResult: null,
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    });

    expect(parsed.artifactState).toBe('unsupported_current_artifact');
  });

  it('rejects unexpected server-only fields in finalizationResult', () => {
    const responsePayload = {
      sessionId,
      finalizationState: null,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '2'.repeat(64),
        verifiedTally: [1, 0, 0, 0, 0],
        journal: {},
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        totalExpected: 1,
        treeSize: 1,
        excludedSlots: 0,
        sthDigest: '0x' + '3'.repeat(64),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        inputCommitment: '0x' + '5'.repeat(64),
        seenIndicesCount: 1,
        bitmapData: { includedBitmap: [true] },
      },
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    expect(() => parseFinalizationStatusResponse(responsePayload)).toThrowError(/Invalid finalization status payload:/);
  });

  it('rejects non-canonical journal payloads in finalizationResult', () => {
    const responsePayload = {
      sessionId,
      finalizationState: null,
      finalizationResult: {
        tally: {
          counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 1,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '2'.repeat(64),
        verifiedTally: [1, 0, 0, 0, 0],
        journal: {
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          treeSize: 1,
        },
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        totalExpected: 1,
        treeSize: 1,
        excludedSlots: 0,
        sthDigest: '0x' + '3'.repeat(64),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        inputCommitment: '0x' + '5'.repeat(64),
        seenIndicesCount: 1,
      },
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    expect(() => parseFinalizationStatusResponse(responsePayload)).toThrowError(/Invalid finalization status payload:/);
  });

  it('parses dev_mode verification results without local file paths', () => {
    const journal = {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 64,
      totalExpected: 64,
      sthDigest: '0x' + '2'.repeat(64),
      verifiedTally: [32, 32, 0, 0, 0],
      totalVotes: 64,
      validVotes: 64,
      invalidVotes: 0,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      seenBitmapRoot: '0x' + '3'.repeat(64),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      excludedSlots: 0,
      inputCommitment: '0x' + '5'.repeat(64),
      methodVersion: 12,
    } as const;
    const responsePayload = {
      sessionId,
      finalizationState: null,
      finalizationResult: {
        tally: {
          counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
          totalVotes: 64,
          tamperedCount: 0,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '6'.repeat(64),
        verifiedTally: [32, 32, 0, 0, 0],
        journal,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        totalExpected: 64,
        treeSize: 64,
        excludedSlots: 0,
        sthDigest: '0x' + '2'.repeat(64),
        seenBitmapRoot: '0x' + '3'.repeat(64),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        inputCommitment: '0x' + '5'.repeat(64),
        seenIndicesCount: 64,
        verificationResult: {
          status: 'dev_mode',
          report: {
            status: 'dev_mode',
            verifier_version: '1.0.0',
            verified_at: '2026-01-01T00:00:00.000Z',
            duration_ms: 12,
            expected_image_id: '0x' + '6'.repeat(64),
            receipt_image_id: '0x' + '6'.repeat(64),
            dev_mode_receipt: true,
          },
        },
      },
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    const parsed = parseFinalizationStatusResponse(responsePayload);

    expect(parsed.finalizationResult?.verificationResult).toMatchObject({
      status: 'dev_mode',
      report: {
        status: 'dev_mode',
        dev_mode_receipt: true,
      },
    });
  });

  it('parses queue info when present', () => {
    const responsePayload = {
      sessionId,
      finalizationState: {
        status: 'pending',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
        queuedAt: 1730000000000,
      },
      queue: {
        position: 3,
        depth: 8,
        concurrencyLimit: 2,
        estimatedStartAt: 1730000020000,
        estimatedDurationMs: 360000,
        estimatedCompletionAt: 1730000260000,
      },
      finalizationResult: null,
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    const parsed = parseFinalizationStatusResponse(responsePayload);

    expect(parsed.queue).toEqual({
      position: 3,
      depth: 8,
      concurrencyLimit: 2,
      estimatedStartAt: 1730000020000,
      estimatedDurationMs: 360000,
      estimatedCompletionAt: 1730000260000,
    });
  });

  it('accepts explicit null queue payload', () => {
    const responsePayload = {
      sessionId,
      finalizationState: {
        status: 'pending',
        executionId: '01HVN5WA1CEH94868G90QGJ7HX',
        queuedAt: 1730000000000,
      },
      queue: null,
      finalizationResult: null,
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    const parsed = parseFinalizationStatusResponse(responsePayload);

    expect(parsed.queue).toBeNull();
  });

  it('accepts status responses with short execution ids allowed by the shared contract', () => {
    const responsePayload = {
      sessionId,
      finalizationState: {
        status: 'pending',
        executionId: 'exec-1',
        queuedAt: 1730000000000,
      },
      finalizationResult: null,
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    const parsed = parseFinalizationStatusResponse(responsePayload);

    expect(parsed.finalizationState?.executionId).toBe('exec-1');
  });

  it('accepts status responses when tally.tamperedCount is omitted by the shared contract', () => {
    const journal = {
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + 'a'.repeat(64),
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 64,
      totalExpected: 64,
      sthDigest: '0x' + '2'.repeat(64),
      verifiedTally: [32, 32, 0, 0, 0],
      totalVotes: 64,
      validVotes: 64,
      invalidVotes: 0,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      seenBitmapRoot: '0x' + '3'.repeat(64),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      excludedSlots: 0,
      inputCommitment: '0x' + '5'.repeat(64),
      methodVersion: 12,
    } as const;
    const responsePayload = {
      sessionId,
      finalizationState: null,
      finalizationResult: {
        tally: {
          counts: { A: 32, B: 32, C: 0, D: 0, E: 0 },
          totalVotes: 64,
        },
        bulletinRoot: '0x' + '1'.repeat(64),
        imageId: '0x' + '6'.repeat(64),
        verifiedTally: [32, 32, 0, 0, 0],
        journal,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        totalExpected: 64,
        treeSize: 64,
        excludedSlots: 0,
        sthDigest: '0x' + '2'.repeat(64),
        seenBitmapRoot: '0x' + '3'.repeat(64),
        includedBitmapRoot: '0x' + '4'.repeat(64),
        inputCommitment: '0x' + '5'.repeat(64),
        seenIndicesCount: 64,
      },
      stepFunctions: null,
      asyncFinalizationMode: 'enabled',
    } as const;

    const parsed = parseFinalizationStatusResponse(responsePayload);

    expect(parsed.finalizationResult?.tally.totalVotes).toBe(64);
    expect(parsed.finalizationResult?.tally.tamperedCount).toBeUndefined();
  });
});

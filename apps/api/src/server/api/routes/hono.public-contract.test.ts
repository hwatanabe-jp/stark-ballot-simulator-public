import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHonoApp } from './hono';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import type { SessionData } from '@stark-ballot/domain/types/server';
import {
  admitAwsPersistedFinalizationResultBranch,
  admitAwsPersistedFinalizationStateBranch,
  type AwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getRecordProperty, getStringProperty } from '@stark-ballot/domain/utils/guards';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';

const s3DownloadMocks = vi.hoisted(() => ({
  downloadFromS3: vi.fn(),
  downloadRangeFromS3: vi.fn(),
  headS3Object: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/aws/s3-download', () => ({
  downloadFromS3: s3DownloadMocks.downloadFromS3,
  downloadRangeFromS3: s3DownloadMocks.downloadRangeFromS3,
  headS3Object: s3DownloadMocks.headS3Object,
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

const capabilitySecret = 'mounted-hono-public-contract-secret-0123456789abcdef';
const sessionId = 'session-mounted-1';
const executionId = 'execution-mounted-1';
const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
const reportKey = `sessions/${sessionId}/${executionId}/verification.json`;

function buildFinalizationResult(): AwsPersistedFinalizationResult {
  const oneBitBitmapRoot = computeIncludedBitmapRoot([true]);
  const journal = {
    ...createTestJournal({
      validVotes: 1,
      totalExpected: 1,
      seenIndicesCount: 1,
    }),
    includedBitmapRoot: oneBitBitmapRoot,
    seenBitmapRoot: oneBitBitmapRoot,
  };

  return {
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: `0x${'12'.repeat(32)}`,
    journal,
    publicInputArtifact: createTestPublicInputArtifact({
      source: 'bundle',
      executionId,
      bundleKey,
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        methodVersion: journal.methodVersion,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        votesCount: journal.validVotes,
        recomputedInputCommitment: journal.inputCommitment,
      },
    }),
    verificationExecutionId: executionId,
    s3BundleKey: bundleKey,
    verificationResult: {
      status: 'success',
      executionId,
      s3BundleKey: bundleKey,
      s3ReportKey: reportKey,
    },
    bitmapProofSource: 'real',
  };
}

function buildFinalizedSession(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  return {
    sessionId,
    contractGeneration: resolveCurrentContractGeneration(),
    finalizationContractGeneration: resolveCurrentContractGeneration(),
    hasPersistedFinalizationBranch: true,
    votes: new Map(),
    botCount: 0,
    finalized: true,
    createdAt: now,
    lastActivity: now,
    userVoteIndex: 0,
    ...omitUndefinedProperties({
      finalizationResult: admitAwsPersistedFinalizationResultBranch(buildFinalizationResult()),
    }),
    ...overrides,
  };
}

function authHeaders(id = sessionId): Record<string, string> {
  return {
    [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId: id }, capabilitySecret),
  };
}

function sessionAuthHeaders(id = sessionId): Record<string, string> {
  return {
    [SESSION_ID_HEADER]: id,
    ...authHeaders(id),
  };
}

describe('mounted Hono public contract behavior', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      SESSION_CAPABILITY_SECRET: process.env['SESSION_CAPABILITY_SECRET'],
      TARGET_AWS_RUNTIME: process.env['TARGET_AWS_RUNTIME'],
      USE_S3: process.env['USE_S3'],
      AWS_DEFAULT_REGION: process.env['AWS_DEFAULT_REGION'],
      AWS_ACCOUNT_ID: process.env['AWS_ACCOUNT_ID'],
      S3_PROOF_BUCKET: process.env['S3_PROOF_BUCKET'],
      S3_PROOF_PREFIX: process.env['S3_PROOF_PREFIX'],
      VITE_STH_SOURCES: process.env['VITE_STH_SOURCES'],
      VITE_STH_MIN_MATCHES: process.env['VITE_STH_MIN_MATCHES'],
    };
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';
    process.env['AWS_DEFAULT_REGION'] = 'ap-northeast-1';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('preserves mounted auth failure, CORS, cache, binary range, and report behavior for bundle endpoints', async () => {
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildFinalizedSession()),
    });
    vi.mocked(getGlobalStore).mockReturnValue(store);
    s3DownloadMocks.headS3Object.mockResolvedValue({ contentLength: 8 });
    s3DownloadMocks.downloadRangeFromS3.mockResolvedValue({
      body: Uint8Array.from([2, 3, 4]),
      contentLength: 3,
      contentRange: 'bytes 1-3/8',
    });
    s3DownloadMocks.downloadFromS3.mockResolvedValue(
      Uint8Array.from([123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125]),
    );

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const preflight = await app.request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Session-Capability, Range',
      },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('range');

    const missingCapability = await app.request(
      `http://localhost/api/verification/bundles/${sessionId}/${executionId}`,
    );
    const missingPayload = await readJsonRecord(missingCapability, 'missing capability');
    expect(missingCapability.status).toBe(401);
    expect(getStringProperty(missingPayload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');

    const rangedBundle = await app.request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
      headers: {
        ...authHeaders(),
        Range: 'bytes=1-3',
        Origin: 'http://localhost:3000',
      },
    });
    expect(rangedBundle.status).toBe(206);
    expect(rangedBundle.headers.get('Content-Type')).toBe('application/zip');
    expect(rangedBundle.headers.get('Cache-Control')).toBe('no-store');
    expect(rangedBundle.headers.get('Accept-Ranges')).toBe('bytes');
    expect(rangedBundle.headers.get('Content-Range')).toBe('bytes 1-3/8');
    expect(Array.from(new Uint8Array(await rangedBundle.arrayBuffer()))).toEqual([2, 3, 4]);

    const report = await app.request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
      headers: authHeaders(),
    });
    expect(report.status).toBe(200);
    expect(report.headers.get('Content-Type')).toBe('application/json');
    expect(report.headers.get('Cache-Control')).toBe('no-store');
    expect(await report.json()).toEqual({ ok: true });
  });

  it('fails closed for stale execution IDs and corrupt finalized artifact locators before S3 access', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () => Promise.resolve(buildFinalizedSession()),
      }),
    );

    const stale = await app.request(`http://localhost/api/verification/bundles/${sessionId}/execution-stale`, {
      headers: authHeaders(),
    });
    expect(stale.status).toBe(404);
    expect(getStringProperty(await readJsonRecord(stale, 'stale execution'), 'error')).toBe('BUNDLE_NOT_FOUND');

    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () =>
          Promise.resolve(
            buildFinalizedSession({
              finalizationResult: admitAwsPersistedFinalizationResultBranch({
                ...buildFinalizationResult(),
                s3BundleKey: `archive/${sessionId}/${executionId}/bundle.zip`,
              }),
            }),
          ),
      }),
    );

    const corrupt = await app.request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
      headers: authHeaders(),
    });
    expect(corrupt.status).toBe(404);
    expect(getStringProperty(await readJsonRecord(corrupt, 'corrupt locator'), 'error')).toBe(
      'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
    );
    expect(s3DownloadMocks.headS3Object).not.toHaveBeenCalled();
  });

  it('preserves mounted session-status cache privacy and finalization projection behavior', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () =>
          Promise.resolve(
            buildFinalizedSession({
              finalizationState: admitAwsPersistedFinalizationStateBranch({
                status: 'succeeded',
                executionId,
                queuedAt: 1,
                startedAt: 2,
                completedAt: 3,
              }),
            }),
          ),
      }),
    );

    const status = await app.request(`http://localhost/api/sessions/${sessionId}/status`, {
      headers: authHeaders(),
    });
    const payload = await readJsonRecord(status, 'session status');

    expect(status.status).toBe(200);
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect(getStringProperty(payload, 'sessionId')).toBe(sessionId);
    expect(getRecordProperty(payload, 'finalizationResult')).not.toBeUndefined();
  });

  it('preserves mounted verify fail-closed finalized-artifact behavior', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () =>
          Promise.resolve(
            buildFinalizedSession({
              ...omitUndefinedProperties({ finalizationResult: {} as unknown as SessionData['finalizationResult'] }),
            }),
          ),
      }),
    );

    const verify = await app.request('http://localhost/api/verify', {
      headers: sessionAuthHeaders(),
    });
    const payload = await readJsonRecord(verify, 'verify fail-closed response');

    expect(verify.status).toBe(200);
    expect(verify.headers.get('Cache-Control')).toBe('no-store');
    expect(getStringProperty(payload, 'error')).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
  });

  it('evaluates mounted verify STH and bitmap checks without CloudFront self-fetch', async () => {
    process.env['VITE_STH_SOURCES'] = '/api/sth';
    process.env['VITE_STH_MIN_MATCHES'] = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('forbidden', { status: 403 }))),
    );

    const finalizationResult = buildFinalizationResult();
    const vote = {
      voteId: 'vote-mounted-user',
      vote: 'A' as const,
      rand: `0x${'01'.repeat(32)}`,
      commit: `0x${'34'.repeat(32)}`,
      path: [],
      timestamp: 1,
      rootAtCast: finalizationResult.journal.bulletinRoot,
      treeSize: 1,
    };
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () =>
          Promise.resolve(
            buildFinalizedSession({
              votes: new Map([[0, vote]]),
              finalizationResult: admitAwsPersistedFinalizationResultBranch(finalizationResult),
            }),
          ),
        getVoteByIdWithProof: () =>
          Promise.resolve({
            voteData: vote,
            leafIndex: 0,
            merklePath: [],
            bulletinRootAtCast: finalizationResult.journal.bulletinRoot,
            treeSize: 1,
          }),
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [true],
            seenBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAt: 1,
          }),
      }),
    );

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const verify = await app.request('http://localhost/api/verify', {
      headers: sessionAuthHeaders(),
    });
    const payload = await readJsonRecord(verify, 'verify response');
    const data = getRecordProperty(payload, 'data');
    const checks = data?.['verificationChecks'];
    const statusById = new Map(
      Array.isArray(checks)
        ? checks
            .filter((check): check is { id: string; status: string } => {
              return (
                check !== null &&
                typeof check === 'object' &&
                typeof (check as { id?: unknown }).id === 'string' &&
                typeof (check as { status?: unknown }).status === 'string'
              );
            })
            .map((check) => [check.id, check.status] as const)
        : [],
    );

    expect(verify.status).toBe(200);
    expect(statusById.get('recorded_sth_third_party')).toBe('success');
    expect(statusById.get('counted_my_vote_included')).toBe('success');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves mounted bitmap-proof auth, cache, ETag, and conditional response behavior', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () => Promise.resolve(buildFinalizedSession()),
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [true],
            seenBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAt: 1,
          }),
      }),
    );

    const missingCapability = await app.request('http://localhost/api/bitmap-proof?i=0');
    expect(missingCapability.status).toBe(400);
    expect(getStringProperty(await readJsonRecord(missingCapability, 'bitmap auth failure'), 'error')).toBe(
      'SESSION_ID_REQUIRED',
    );

    const missingCapabilityWithSession = await app.request('http://localhost/api/bitmap-proof?i=0', {
      headers: {
        [SESSION_ID_HEADER]: sessionId,
      },
    });
    expect(missingCapabilityWithSession.status).toBe(401);
    expect(
      getStringProperty(await readJsonRecord(missingCapabilityWithSession, 'bitmap capability failure'), 'error'),
    ).toBe('SESSION_CAPABILITY_REQUIRED');

    const proof = await app.request('http://localhost/api/bitmap-proof?i=0&kind=included', {
      headers: sessionAuthHeaders(),
    });
    const proofPayload = await readJsonRecord(proof, 'bitmap proof');
    const etag = proof.headers.get('ETag');

    expect(proof.status).toBe(200);
    expect(proof.headers.get('Cache-Control')).toContain('private');
    expect(proof.headers.get('Vary')).toContain('X-Session-Capability');
    expect(etag).toMatch(/^W\/"/);
    expect(getStringProperty(proofPayload, 'leafChunk')).toMatch(/^[0-9a-f]{64}$/);

    const notModified = await app.request('http://localhost/api/bitmap-proof?i=0&kind=included', {
      headers: {
        ...sessionAuthHeaders(),
        'If-None-Match': etag ?? '',
      },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('ETag')).toBe(etag);
    expect(await notModified.text()).toBe('');
  });

  it('fails closed when bitmap sidecar roots do not match the finalized journal', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () => Promise.resolve(buildFinalizedSession()),
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            includedBitmap: [false],
            includedBitmapRoot: computeIncludedBitmapRoot([false]),
            treeSize: 1,
            finalizedAt: 1,
          }),
      }),
    );

    const proof = await app.request('http://localhost/api/bitmap-proof?i=0&kind=included', {
      headers: sessionAuthHeaders(),
    });
    const payload = await readJsonRecord(proof, 'bitmap proof root mismatch');

    expect(proof.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('fails closed when bitmap data is unavailable after finalization', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () => Promise.resolve(buildFinalizedSession()),
        getBitmapData: () => Promise.resolve(null),
      }),
    );

    const proof = await app.request('http://localhost/api/bitmap-proof?i=0&kind=included', {
      headers: sessionAuthHeaders(),
    });
    const payload = await readJsonRecord(proof, 'missing bitmap data');

    expect(proof.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('fails closed when the included bitmap sidecar is unavailable', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () => Promise.resolve(buildFinalizedSession()),
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            includedBitmap: undefined as unknown as boolean[],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [true],
            seenBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAt: 1,
          }),
      }),
    );

    const proof = await app.request('http://localhost/api/bitmap-proof?i=0&kind=included', {
      headers: sessionAuthHeaders(),
    });
    const payload = await readJsonRecord(proof, 'missing included bitmap sidecar');

    expect(proof.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('fails closed when the seen bitmap sidecar is unavailable', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () => Promise.resolve(buildFinalizedSession()),
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAt: 1,
          }),
      }),
    );

    const proof = await app.request('http://localhost/api/bitmap-proof?i=0&kind=seen', {
      headers: sessionAuthHeaders(),
    });
    const payload = await readJsonRecord(proof, 'missing seen bitmap sidecar');

    expect(proof.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('fails closed when the seen bitmap sidecar root does not match the finalized journal', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () => Promise.resolve(buildFinalizedSession()),
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [false],
            seenBitmapRoot: computeIncludedBitmapRoot([false]),
            treeSize: 1,
            finalizedAt: 1,
          }),
      }),
    );

    const proof = await app.request('http://localhost/api/bitmap-proof?i=0&kind=seen', {
      headers: sessionAuthHeaders(),
    });
    const payload = await readJsonRecord(proof, 'seen bitmap root mismatch');

    expect(proof.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('rejects normal bitmap-proof requests for indices other than the session user vote', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const bitmap = [true, false];
    const bitmapRoot = computeIncludedBitmapRoot(bitmap);
    const finalizationResult = buildFinalizationResult();
    finalizationResult.journal = {
      ...finalizationResult.journal,
      treeSize: 2,
      totalExpected: 2,
      includedBitmapRoot: bitmapRoot,
      seenBitmapRoot: bitmapRoot,
    };
    vi.mocked(getGlobalStore).mockReturnValue(
      createMockVoteStore({
        getSession: () =>
          Promise.resolve(
            buildFinalizedSession({
              userVoteIndex: 0,
              finalizationResult: admitAwsPersistedFinalizationResultBranch(finalizationResult),
            }),
          ),
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            includedBitmap: bitmap,
            includedBitmapRoot: bitmapRoot,
            seenBitmap: bitmap,
            seenBitmapRoot: bitmapRoot,
            treeSize: 2,
            finalizedAt: 1,
          }),
      }),
    );

    const proof = await app.request('http://localhost/api/bitmap-proof?i=1&kind=included', {
      headers: sessionAuthHeaders(),
    });
    const payload = await readJsonRecord(proof, 'non-user bitmap proof rejection');

    expect(proof.status).toBe(400);
    expect(getStringProperty(payload, 'error')).toBe('INVALID_BITMAP_PROOF_REQUEST');
    expect(getStringProperty(payload, 'details')).toBe('Bitmap proof requests are limited to the session user vote.');
  });
});

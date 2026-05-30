import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { GET as downloadBundle } from '../[sessionId]/[executionId]/route';
import { GET as downloadReport } from '../[sessionId]/[executionId]/report/route';
import { downloadFromS3, downloadRangeFromS3, headS3Object } from '@/lib/aws/s3-download';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { MockSessionStore } from '@/lib/store/mockSessionStore';
import { resetGlobalStore } from '@/lib/store/storeInstance';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { resolveCurrentContractGeneration } from '@/lib/contract';

const TEST_BASE_DIR = path.join(process.cwd(), '.test-verifier-downloads');

vi.mock('@/lib/aws/s3-download', () => ({
  downloadFromS3: vi.fn(),
  downloadRangeFromS3: vi.fn(),
  headS3Object: vi.fn(),
}));

describe('verification bundle download routes', () => {
  let mockStore: MockSessionStore;

  const createAuthoritativePublicInputArtifact = (
    journal: {
      electionId: string;
      electionConfigHash: string;
      methodVersion: number;
      bulletinRoot: string;
      treeSize: number;
      totalExpected: number;
      validVotes: number;
      inputCommitment: string;
    },
    executionId?: string,
    bundleKey?: string,
  ) =>
    createTestPublicInputArtifact({
      ...(executionId ? { executionId } : {}),
      ...(bundleKey ? { bundleKey } : {}),
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        methodVersion: journal.methodVersion,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        votesCount: journal.validVotes,
        logId: '0x' + '2'.repeat(64),
        timestamp: 123,
        recomputedInputCommitment: journal.inputCommitment,
      },
    });

  const createRequestHeaders = (sessionId: string): Record<string, string> => ({
    [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
  });

  const createScopedBundleKey = (sessionId: string, executionId: string): string =>
    `custom/prefix/${sessionId}/${executionId}/bundle.zip`;

  const createScopedReportKey = (sessionId: string, executionId: string): string =>
    `custom/reports/${sessionId}/${executionId}/verification.json`;

  const requestS3BundleRange = async (
    executionId: string,
    download: { body: Buffer; contentLength?: number; contentRange?: string },
    options?: { rangeHeader?: string; totalSize?: number },
  ): Promise<Response> => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
    const totalSize = options?.totalSize ?? 20;
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: totalSize });
    vi.mocked(downloadRangeFromS3).mockResolvedValue(download);
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: bundleKey,
    });

    return await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: {
          ...createRequestHeaders(sessionId),
          Range: options?.rangeHeader ?? 'bytes=0-7',
        },
      }),
      { params: { sessionId, executionId } },
    );
  };

  const createFinalizedSession = async (
    executionId: string,
    options?: { sessionId?: string; s3BundleKey?: string; s3ReportKey?: string },
  ): Promise<{ sessionId: string; executionId: string }> => {
    const session = options?.sessionId
      ? await mockStore.getSession(options.sessionId)
      : await mockStore.createSession();
    if (!session) {
      throw new Error('Expected session');
    }
    const journal = createTestJournal();
    const electionManifest = buildElectionManifest(journal.electionId, buildDefaultElectionConfig());
    journal.electionConfigHash = electionManifest.electionConfigHash;
    const closeStatement = buildCloseStatement({
      logId: '0x' + '2'.repeat(64),
      treeSize: journal.treeSize,
      timestamp: 123,
      bulletinRoot: journal.bulletinRoot,
    });
    journal.sthDigest = closeStatement.sthDigest;
    await mockStore.finalizeSession(
      session.sessionId,
      {
        tally: {
          counts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
          totalVotes: 0,
          tamperedCount: 0,
        },
        imageId: '0x' + '1'.repeat(64),
        journal,
        publicInputArtifact: createAuthoritativePublicInputArtifact(journal, executionId, options?.s3BundleKey),
        electionManifest,
        closeStatement,
        ...(options?.s3BundleKey ? { s3BundleKey: options.s3BundleKey } : {}),
        verificationExecutionId: executionId,
        verificationResult: {
          status: 'running',
          executionId,
          ...(options?.s3BundleKey ? { s3BundleKey: options.s3BundleKey } : {}),
          ...(options?.s3ReportKey ? { s3ReportKey: options.s3ReportKey } : {}),
        },
      },
      resolveCurrentContractGeneration(),
    );
    return { sessionId: session.sessionId, executionId };
  };

  const createFinalizedSessionWithoutExecutionId = async (): Promise<{ sessionId: string }> => {
    const { sessionId } = await createFinalizedSession('exec-missing-selector');
    const session = await mockStore.getSession(sessionId);
    if (!session?.finalizationResult) {
      throw new Error('Expected finalized session');
    }
    delete session.finalizationResult.verificationExecutionId;
    if (session.finalizationResult.verificationResult) {
      delete session.finalizationResult.verificationResult.executionId;
    }
    return { sessionId };
  };

  beforeEach(async () => {
    setTestSessionCapabilitySecret();
    vi.mocked(downloadFromS3).mockReset();
    vi.mocked(downloadRangeFromS3).mockReset();
    vi.mocked(headS3Object).mockReset();
    await fs.rm(TEST_BASE_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_BASE_DIR, { recursive: true });
    process.env.VERIFIER_WORK_DIR = TEST_BASE_DIR;
    process.env.USE_MOCK_STORE = 'true';
    resetGlobalStore();
    mockStore = new MockSessionStore();
    global.__globalStoreInstance = mockStore;
  });

  afterEach(async () => {
    await fs.rm(TEST_BASE_DIR, { recursive: true, force: true });
    delete process.env.VERIFIER_WORK_DIR;
    delete process.env.USE_S3;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.USE_MOCK_STORE;
    resetGlobalStore();
  });

  it('serves bundle archive when present', async () => {
    const { sessionId, executionId } = await createFinalizedSession('exec123');
    const bundleDir = path.join(TEST_BASE_DIR, sessionId, executionId);
    await fs.mkdir(bundleDir, { recursive: true });

    const archivePath = path.join(bundleDir, 'bundle.zip');
    await fs.writeFile(archivePath, Buffer.from('PK\u0003\u0004')); // minimal zip header

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('returns 404 when bundle archive missing', async () => {
    const { sessionId, executionId } = await createFinalizedSession('missing-bundle');

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(404);
  });

  it('serves verification report JSON', async () => {
    const { sessionId, executionId } = await createFinalizedSession('exec999');
    const bundleDir = path.join(TEST_BASE_DIR, sessionId, executionId);
    await fs.mkdir(bundleDir, { recursive: true });

    const reportPayload = { status: 'success', verifier_version: '0.1.0' };
    await fs.writeFile(path.join(bundleDir, 'verification.json'), JSON.stringify(reportPayload));

    const response = await downloadReport(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const json = await readJsonRecord(response, 'verification report');
    expect(json).toEqual(reportPayload);
  });

  it('serves S3 bundle downloads through the authenticated route when enabled', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-s3';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
    vi.mocked(downloadFromS3).mockResolvedValue(Buffer.from('PK\u0003\u0004s3-bundle'));
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: Buffer.byteLength('PK\u0003\u0004s3-bundle') });
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: bundleKey,
    });

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${executionId}.zip"`);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('PK\u0003\u0004s3-bundle');
    expect(downloadFromS3).toHaveBeenCalledWith(bundleKey);
  });

  it('serves S3 bundle byte ranges through the authenticated route', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-s3-range';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: 20 });
    vi.mocked(downloadRangeFromS3).mockResolvedValue({
      body: Buffer.from('01234567'),
      contentLength: 8,
      contentRange: 'bytes 0-7/20',
    });
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: bundleKey,
    });

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: {
          ...createRequestHeaders(sessionId),
          Range: 'bytes=0-7',
        },
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-7/20');
    expect(response.headers.get('x-stark-bundle-range-chunk-size')).toBe(String(4 * 1024 * 1024));
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('01234567');
    expect(downloadRangeFromS3).toHaveBeenCalledWith(bundleKey, { start: 0, end: 7 });
    expect(downloadFromS3).not.toHaveBeenCalled();
  });

  it('serves S3 suffix byte ranges through the authenticated route', async () => {
    const response = await requestS3BundleRange(
      'exec-s3-suffix-range',
      {
        body: Buffer.from('56789'),
        contentLength: 5,
        contentRange: 'bytes 15-19/20',
      },
      { rangeHeader: 'bytes=-5' },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 15-19/20');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('56789');
    expect(downloadRangeFromS3).toHaveBeenCalledWith(expect.any(String), { start: 15, end: 19 });
    expect(downloadFromS3).not.toHaveBeenCalled();
  });

  it('returns 416 for invalid S3 bundle byte ranges', async () => {
    const response = await requestS3BundleRange(
      'exec-s3-invalid-range',
      {
        body: Buffer.from('unused'),
        contentLength: 6,
        contentRange: 'bytes 0-5/20',
      },
      { rangeHeader: 'bytes=20-25' },
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */20');
    const payload = await readJsonRecord(response, 'invalid S3 range response');
    expect(payload.error).toBe('Invalid range');
    expect(downloadRangeFromS3).not.toHaveBeenCalled();
    expect(downloadFromS3).not.toHaveBeenCalled();
  });

  it('fails closed when S3 range content-range does not match the requested range', async () => {
    const response = await requestS3BundleRange('exec-s3-range-bad-content-range', {
      body: Buffer.from('01234567'),
      contentLength: 8,
      contentRange: 'bytes 1-8/20',
    });

    expect(response.status).toBe(500);
    const payload = await readJsonRecord(response, 'mismatched S3 content-range response');
    expect(payload.error).toBe('Failed to load bundle');
  });

  it('fails closed when S3 range content-length does not match the requested range', async () => {
    const response = await requestS3BundleRange('exec-s3-range-bad-content-length', {
      body: Buffer.from('01234567'),
      contentLength: 7,
      contentRange: 'bytes 0-7/20',
    });

    expect(response.status).toBe(500);
    const payload = await readJsonRecord(response, 'mismatched S3 content-length response');
    expect(payload.error).toBe('Failed to load bundle');
  });

  it('fails closed when S3 range body length does not match the requested range', async () => {
    const response = await requestS3BundleRange('exec-s3-range-truncated-body', {
      body: Buffer.from('0123456'),
      contentLength: 8,
      contentRange: 'bytes 0-7/20',
    });

    expect(response.status).toBe(500);
    const payload = await readJsonRecord(response, 'truncated S3 range response');
    expect(payload.error).toBe('Failed to load bundle');
  });

  it('refuses oversized S3 bundle bodies without a byte range in hosted-safe mode', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-s3-large';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: 4 * 1024 * 1024 + 1 });
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: bundleKey,
    });

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(413);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe(`bytes */${4 * 1024 * 1024 + 1}`);
    const payload = await readJsonRecord(response, 'large S3 bundle response');
    expect(payload.error).toBe('Bundle requires ranged download');
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('fails closed instead of serving a foreign bundle key', async () => {
    process.env.USE_S3 = 'true';
    const executionId = 'exec-good';
    const session = await mockStore.createSession();
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: createScopedBundleKey(session.sessionId, executionId),
    });
    const persisted = await mockStore.getSession(sessionId);
    if (!persisted?.finalizationResult?.publicInputArtifact) {
      throw new Error('Expected finalized session');
    }
    const foreignBundleKey = 'sessions/other-session/other-exec/bundle.zip';
    persisted.finalizationResult.s3BundleKey = foreignBundleKey;
    persisted.finalizationResult.publicInputArtifact.provenance.bundleKey = foreignBundleKey;
    if (persisted.finalizationResult.verificationResult) {
      persisted.finalizationResult.verificationResult.s3BundleKey = foreignBundleKey;
    }

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(404);
    const payload = await readJsonRecord(response, 'foreign bundle key response');
    expect(payload.error).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
    expect(downloadFromS3).not.toHaveBeenCalled();
  });

  it('serves S3 report downloads through the authenticated route when enabled', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-s3-report';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
    const reportKey = createScopedReportKey(session.sessionId, executionId);
    vi.mocked(headS3Object).mockResolvedValue({
      contentLength: Buffer.byteLength('{"status":"success","source":"s3"}'),
    });
    vi.mocked(downloadFromS3).mockResolvedValue(Buffer.from('{"status":"success","source":"s3"}'));
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: bundleKey,
      s3ReportKey: reportKey,
    });

    const response = await downloadReport(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('content-disposition')).toBe(`inline; filename="${executionId}-verification.json"`);
    expect(await readJsonRecord(response, 'S3 verification report')).toEqual({ status: 'success', source: 's3' });
    expect(downloadFromS3).toHaveBeenCalledWith(reportKey);
  });

  it('fails closed for oversized S3 report downloads through the authenticated route', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-s3-large-report';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
    const reportKey = createScopedReportKey(session.sessionId, executionId);
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: 4 * 1024 * 1024 + 1 });
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: bundleKey,
      s3ReportKey: reportKey,
    });

    const response = await downloadReport(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(413);
    const payload = await readJsonRecord(response, 'oversized S3 verification report');
    expect(payload.error).toBe('Report exceeds authenticated download limit');
    expect(downloadFromS3).not.toHaveBeenCalled();
  });

  it('fails closed instead of serving a foreign report key', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-foreign-report';
    const bundleKey = `sessions/${session.sessionId}/${executionId}/bundle.zip`;
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: bundleKey,
      s3ReportKey: createScopedReportKey(session.sessionId, executionId),
    });
    const persisted = await mockStore.getSession(sessionId);
    if (!persisted?.finalizationResult?.verificationResult) {
      throw new Error('Expected finalized session');
    }
    persisted.finalizationResult.verificationResult.s3ReportKey = 'sessions/other-session/other-exec/verification.json';

    const response = await downloadReport(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(404);
    const payload = await readJsonRecord(response, 'foreign report key response');
    expect(payload.error).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
    expect(downloadFromS3).not.toHaveBeenCalled();
  });

  it('serves local report when USE_S3 is enabled but no authoritative s3ReportKey exists', async () => {
    process.env.USE_S3 = 'true';
    const { sessionId, executionId } = await createFinalizedSession('exec-local-report-fallback');
    const bundleDir = path.join(TEST_BASE_DIR, sessionId, executionId);
    await fs.mkdir(bundleDir, { recursive: true });

    const reportPayload = { status: 'success', verifier_version: '0.1.0' };
    await fs.writeFile(path.join(bundleDir, 'verification.json'), JSON.stringify(reportPayload));

    const response = await downloadReport(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(200);
    expect(await readJsonRecord(response, 'local fallback verification report')).toEqual(reportPayload);
  });

  it('returns 404 for report when authoritative s3ReportKey is missing and no local report exists', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-missing-report-locator';
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: createScopedBundleKey(session.sessionId, executionId),
    });

    const response = await downloadReport(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(404);
  });

  it('serves S3 bundle downloads in lambda runtime even without USE_S3', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'hono-api';
    const session = await mockStore.createSession();
    const executionId = 'exec-lambda';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
    vi.mocked(downloadFromS3).mockResolvedValue(Buffer.from('PK\u0003\u0004lambda-s3-bundle'));
    vi.mocked(headS3Object).mockResolvedValue({ contentLength: Buffer.byteLength('PK\u0003\u0004lambda-s3-bundle') });
    const { sessionId } = await createFinalizedSession(executionId, {
      sessionId: session.sessionId,
      s3BundleKey: bundleKey,
    });

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('PK\u0003\u0004lambda-s3-bundle');
    expect(downloadFromS3).toHaveBeenCalledWith(bundleKey);
  });

  it('falls back to local bundle reads when USE_S3 is enabled but no authoritative s3BundleKey exists', async () => {
    process.env.USE_S3 = 'true';
    const { sessionId, executionId } = await createFinalizedSession('exec-local-fallback');
    const bundleDir = path.join(TEST_BASE_DIR, sessionId, executionId);
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, 'bundle.zip'), Buffer.from('PK\u0003\u0004'));

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
  });

  it('fails closed instead of redirecting when USE_S3 is enabled but neither authoritative S3 nor local bundle exists', async () => {
    process.env.USE_S3 = 'true';
    const { sessionId, executionId } = await createFinalizedSession('exec-missing-local-fallback');

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(404);
  });

  it('returns 401 without capability token', async () => {
    const { sessionId, executionId } = await createFinalizedSession('exec-no-token');

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(401);
  });

  it('returns 404 for executionId outside session scope', async () => {
    const { sessionId } = await createFinalizedSession('exec-allowed');

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/exec-denied`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId: 'exec-denied' } },
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 for stale finalized artifacts even when executionId matches', async () => {
    const { sessionId, executionId } = await createFinalizedSession('exec-stale');
    const session = await mockStore.getSession(sessionId);
    if (!session) {
      throw new Error('Expected finalized session');
    }
    session.finalizationContractGeneration = 'stale-contract-generation';

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(404);
    const payload = await readJsonRecord(response, 'stale finalized bundle response');
    expect(payload.error).toBe('UNSUPPORTED_CURRENT_ARTIFACT');
    expect(payload.artifactState).toBe('unsupported_current_artifact');
  });

  it('returns 404 when verificationExecutionId is missing', async () => {
    process.env.USE_S3 = 'true';
    const { sessionId } = await createFinalizedSessionWithoutExecutionId();
    const executionId = 'exec-missing';

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(404);
    const payload = await readJsonRecord(response, 'missing selector bundle response');
    expect(payload.error).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
  });

  it('returns 404 when canonicalized finalized bundle authority is corrupt', async () => {
    const executionId = 'exec-unbound';
    const { sessionId } = await createFinalizedSession(executionId);
    const session = await mockStore.getSession(sessionId);
    if (!session?.finalizationResult?.journal) {
      throw new Error('Expected finalized session with journal');
    }
    session.finalizationResult.publicInputArtifact = createAuthoritativePublicInputArtifact(
      session.finalizationResult.journal,
    );

    const response = await downloadBundle(
      new NextRequest(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: createRequestHeaders(sessionId),
      }),
      { params: { sessionId, executionId } },
    );

    expect(response.status).toBe(404);
    const payload = await readJsonRecord(response, 'corrupt finalized bundle response');
    expect(payload.error).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
    expect(payload.artifactState).toBe('corrupt_or_unreadable');
  });
});

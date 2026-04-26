import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { GET as downloadBundle } from '../[sessionId]/[executionId]/route';
import { GET as downloadReport } from '../[sessionId]/[executionId]/report/route';
import { generateBundlePresignedUrlForKey } from '@/lib/aws/presigned-url';
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

vi.mock('@/lib/aws/presigned-url', () => ({
  generateBundlePresignedUrl: vi.fn((_sessionId: string, _executionId: string, fileName = 'bundle.zip') =>
    Promise.resolve({
      url: `https://example.com/${fileName}`,
      expiresAt: '2025-01-01T01:00:00.000Z',
      expiresIn: 3600,
      success: true,
    }),
  ),
  generateBundlePresignedUrlForKey: vi.fn((key: string) =>
    Promise.resolve({
      url: `https://example.com/download?key=${encodeURIComponent(key)}`,
      expiresAt: '2025-01-01T01:00:00.000Z',
      expiresIn: 3600,
      success: true,
    }),
  ),
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
    vi.mocked(generateBundlePresignedUrlForKey).mockClear();
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

  it('redirects bundle download to S3 when enabled', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-s3';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
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

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`https://example.com/download?key=${encodeURIComponent(bundleKey)}`);
  });

  it('fails closed instead of presigning a foreign bundle key', async () => {
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
    expect(generateBundlePresignedUrlForKey).not.toHaveBeenCalled();
  });

  it('redirects report download to S3 when enabled', async () => {
    process.env.USE_S3 = 'true';
    const session = await mockStore.createSession();
    const executionId = 'exec-s3-report';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
    const reportKey = createScopedReportKey(session.sessionId, executionId);
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

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`https://example.com/download?key=${encodeURIComponent(reportKey)}`);
  });

  it('fails closed instead of presigning a foreign report key', async () => {
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
    expect(generateBundlePresignedUrlForKey).not.toHaveBeenCalled();
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

  it('redirects bundle download to S3 in lambda runtime even without USE_S3', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'hono-api';
    const session = await mockStore.createSession();
    const executionId = 'exec-lambda';
    const bundleKey = createScopedBundleKey(session.sessionId, executionId);
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

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`https://example.com/download?key=${encodeURIComponent(bundleKey)}`);
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

import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@stark-ballot/domain/types/server';
import {
  admitAwsPersistedFinalizationResultBranch,
  type AwsPersistedFinalizationResult,
} from '@stark-ballot/aws-adapters/finalize/finalizationPersistenceEnvelope';
import { createMockVoteStore } from '@stark-ballot/test-support/testing/mockVoteStore';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import { resolveCurrentContractGeneration } from '@stark-ballot/domain/contract';
import { readJsonRecord } from '@stark-ballot/test-support/testing/response-helpers';
import { getNumberProperty, getStringProperty } from '@stark-ballot/domain/utils/guards';
import { StandardErrorResponseSchema } from '@stark-ballot/api-contract/validation/apiSchemas';
import { getVerificationBundleHandler, getVerificationReportHandler } from './verificationBundles';

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

const capabilitySecret = 'test-session-capability-secret-0123456789abcdef';

function buildFinalizationResult(
  sessionId: string,
  executionId: string,
  overrides: Partial<Pick<AwsPersistedFinalizationResult, 's3BundleKey' | 'verificationResult'>> = {},
): AwsPersistedFinalizationResult {
  const s3BundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
  const s3ReportKey = `sessions/${sessionId}/${executionId}/verification.json`;
  const journal = createTestJournal({
    validVotes: 1,
    totalExpected: 1,
    seenIndicesCount: 1,
  });

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
      bundleKey: s3BundleKey,
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
    s3BundleKey,
    verificationResult: {
      status: 'success',
      executionId,
      s3BundleKey,
      s3ReportKey,
    },
    ...overrides,
  };
}

function buildFinalizedSession(
  sessionId: string,
  executionId: string,
  finalizationOverrides: Partial<Pick<AwsPersistedFinalizationResult, 's3BundleKey' | 'verificationResult'>> = {},
): SessionData {
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
    finalizationResult: admitAwsPersistedFinalizationResultBranch(
      buildFinalizationResult(sessionId, executionId, finalizationOverrides),
    ),
  };
}

async function expectStandardErrorResponse(
  response: Response,
  expected: { status: number; error: string; statusCode?: number },
): Promise<Record<string, unknown>> {
  const payload = await readJsonRecord(response, 'standard error response');
  expect(StandardErrorResponseSchema.safeParse(payload).success).toBe(true);
  expect(response.status).toBe(expected.status);
  expect(getStringProperty(payload, 'error')).toBe(expected.error);
  expect(getNumberProperty(payload, 'statusCode')).toBe(expected.statusCode ?? expected.status);
  return payload;
}

describe('verification bundle downloads', () => {
  let originalEnv: Record<string, string | undefined>;
  let verifierWorkDir: string;

  beforeEach(async () => {
    originalEnv = {
      AWS_LAMBDA_FUNCTION_NAME: process.env['AWS_LAMBDA_FUNCTION_NAME'],
      SESSION_CAPABILITY_SECRET: process.env['SESSION_CAPABILITY_SECRET'],
      TARGET_AWS_RUNTIME: process.env['TARGET_AWS_RUNTIME'],
      USE_S3: process.env['USE_S3'],
      AWS_ACCOUNT_ID: process.env['AWS_ACCOUNT_ID'],
      AWS_DEFAULT_REGION: process.env['AWS_DEFAULT_REGION'],
      AWS_REGION: process.env['AWS_REGION'],
      S3_PROOF_BUCKET: process.env['S3_PROOF_BUCKET'],
      S3_PROOF_PREFIX: process.env['S3_PROOF_PREFIX'],
      VERIFIER_WORK_DIR: process.env['VERIFIER_WORK_DIR'],
    };
    verifierWorkDir = await mkdtemp(path.join(os.tmpdir(), 'stark-bundle-handler-'));
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    process.env['VERIFIER_WORK_DIR'] = verifierWorkDir;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(verifierWorkDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it.each([
    ['legacy Amplify Lambda name', 'amplify-starkballotsimulator-dev-honoapi-lambda'],
    ['arbitrary Lambda name', 'custom-prod-worker'],
    ['target-like Lambda name', 'stark-ballot-simulator-stark-dev-develop-public-api'],
  ])('does not serve S3 artifacts from %s without target runtime config', async (_label, functionName) => {
    const sessionId = 'session-1';
    const executionId = 'exec-1';
    const bundleBytes = Uint8Array.from([1, 2, 3, 4]);
    await mkdir(path.join(verifierWorkDir, sessionId, executionId), { recursive: true });
    await writeFile(path.join(verifierWorkDir, sessionId, executionId, 'bundle.zip'), bundleBytes);
    await writeFile(path.join(verifierWorkDir, sessionId, executionId, 'public-input.json'), '{}');
    process.env['USE_S3'] = 'true';
    delete process.env['TARGET_AWS_RUNTIME'];
    process.env['AWS_LAMBDA_FUNCTION_NAME'] = functionName;

    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildFinalizedSession(sessionId, executionId)),
    });
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);
    const response = await getVerificationBundleHandler({
      request: new Request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: {
          [SESSION_CAPABILITY_HEADER]: token,
        },
      }),
      store,
      params: {
        sessionId,
        executionId,
      },
    });

    const body = response.status === 200 ? undefined : await response.clone().text();
    expect(response.status, body).toBe(200);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(bundleBytes));
    expect(s3DownloadMocks.headS3Object).not.toHaveBeenCalled();
    expect(s3DownloadMocks.downloadFromS3).not.toHaveBeenCalled();
    expect(s3DownloadMocks.downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('returns a standard error envelope for invalid bundle references in the handler', async () => {
    const sessionId = 'session-1';
    const executionId = 'bad.segment';
    const store = createMockVoteStore();
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await getVerificationBundleHandler({
      request: new Request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: {
          [SESSION_CAPABILITY_HEADER]: token,
        },
      }),
      store,
      params: {
        sessionId,
        executionId,
      },
    });

    await expectStandardErrorResponse(response, {
      status: 400,
      error: 'INVALID_BUNDLE_REFERENCE',
    });
  });

  it('fails closed before S3 access when the stored bundle key uses a non-canonical prefix', async () => {
    const sessionId = 'session-1';
    const executionId = 'exec-1';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';
    process.env['AWS_DEFAULT_REGION'] = 'ap-northeast-1';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';

    const canonicalReportKey = `sessions/${sessionId}/${executionId}/verification.json`;
    const archiveBundleKey = `archive/${sessionId}/${executionId}/bundle.zip`;
    const store = createMockVoteStore({
      getSession: () =>
        Promise.resolve(
          buildFinalizedSession(sessionId, executionId, {
            s3BundleKey: archiveBundleKey,
            verificationResult: {
              status: 'success',
              executionId,
              s3BundleKey: archiveBundleKey,
              s3ReportKey: canonicalReportKey,
            },
          }),
        ),
    });
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await getVerificationBundleHandler({
      request: new Request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: {
          [SESSION_CAPABILITY_HEADER]: token,
        },
      }),
      store,
      params: {
        sessionId,
        executionId,
      },
    });

    const payload = await expectStandardErrorResponse(response, {
      status: 404,
      error: 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
    });
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(s3DownloadMocks.headS3Object).not.toHaveBeenCalled();
    expect(s3DownloadMocks.downloadFromS3).not.toHaveBeenCalled();
    expect(s3DownloadMocks.downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('fails closed before S3 access when the stored report key uses a non-canonical prefix', async () => {
    const sessionId = 'session-1';
    const executionId = 'exec-1';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';
    process.env['AWS_DEFAULT_REGION'] = 'ap-northeast-1';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';

    const canonicalBundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const archiveReportKey = `archive/${sessionId}/${executionId}/verification.json`;
    const store = createMockVoteStore({
      getSession: () =>
        Promise.resolve(
          buildFinalizedSession(sessionId, executionId, {
            s3BundleKey: canonicalBundleKey,
            verificationResult: {
              status: 'success',
              executionId,
              s3BundleKey: canonicalBundleKey,
              s3ReportKey: archiveReportKey,
            },
          }),
        ),
    });
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await getVerificationReportHandler({
      request: new Request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: {
          [SESSION_CAPABILITY_HEADER]: token,
        },
      }),
      store,
      params: {
        sessionId,
        executionId,
      },
    });

    const payload = await expectStandardErrorResponse(response, {
      status: 404,
      error: 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
    });
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(s3DownloadMocks.headS3Object).not.toHaveBeenCalled();
    expect(s3DownloadMocks.downloadFromS3).not.toHaveBeenCalled();
    expect(s3DownloadMocks.downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('fails closed instead of falling back to a local report when persisted report locator metadata is malformed', async () => {
    const sessionId = 'session-1';
    const executionId = 'exec-1';
    await mkdir(path.join(verifierWorkDir, sessionId, executionId), { recursive: true });
    await writeFile(path.join(verifierWorkDir, sessionId, executionId, 'verification.json'), '{"status":"success"}');
    const session = buildFinalizedSession(sessionId, executionId);
    const finalizationResult = buildFinalizationResult(sessionId, executionId);
    session.finalizationResult = {
      ...finalizationResult,
      verificationResult: {
        ...finalizationResult.verificationResult,
        status: 'success',
        executionId,
        s3ReportKey: null,
      },
    } as unknown as NonNullable<SessionData['finalizationResult']>;
    const store = createMockVoteStore({
      getSession: () => Promise.resolve(session),
    });
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await getVerificationReportHandler({
      request: new Request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: {
          [SESSION_CAPABILITY_HEADER]: token,
        },
      }),
      store,
      params: {
        sessionId,
        executionId,
      },
    });

    const payload = await expectStandardErrorResponse(response, {
      status: 404,
      error: 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE',
    });
    expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
    expect(s3DownloadMocks.headS3Object).not.toHaveBeenCalled();
    expect(s3DownloadMocks.downloadFromS3).not.toHaveBeenCalled();
    expect(s3DownloadMocks.downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('returns a standard range error envelope while preserving bundle range headers', async () => {
    const sessionId = 'session-1';
    const executionId = 'exec-1';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';
    process.env['AWS_DEFAULT_REGION'] = 'ap-northeast-1';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';
    s3DownloadMocks.headS3Object.mockResolvedValue({ contentLength: 1024 });

    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildFinalizedSession(sessionId, executionId)),
    });
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await getVerificationBundleHandler({
      request: new Request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}`, {
        headers: {
          [SESSION_CAPABILITY_HEADER]: token,
          Range: 'bytes=2000-1000',
        },
      }),
      store,
      params: {
        sessionId,
        executionId,
      },
    });

    await expectStandardErrorResponse(response, {
      status: 416,
      error: 'INVALID_RANGE',
    });
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Range')).toBe('bytes */1024');
    expect(response.headers.get('X-Stark-Bundle-Range-Chunk-Size')).toBe(String(4 * 1024 * 1024));
    expect(s3DownloadMocks.downloadRangeFromS3).not.toHaveBeenCalled();
  });

  it('returns a standard report error envelope when an S3 report exceeds the inline limit', async () => {
    const sessionId = 'session-1';
    const executionId = 'exec-1';
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_S3'] = 'true';
    process.env['AWS_DEFAULT_REGION'] = 'ap-northeast-1';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';
    s3DownloadMocks.headS3Object.mockResolvedValue({ contentLength: 4 * 1024 * 1024 + 1 });

    const store = createMockVoteStore({
      getSession: () => Promise.resolve(buildFinalizedSession(sessionId, executionId)),
    });
    const token = createSessionCapabilityToken({ sessionId }, capabilitySecret);

    const response = await getVerificationReportHandler({
      request: new Request(`http://localhost/api/verification/bundles/${sessionId}/${executionId}/report`, {
        headers: {
          [SESSION_CAPABILITY_HEADER]: token,
        },
      }),
      store,
      params: {
        sessionId,
        executionId,
      },
    });

    await expectStandardErrorResponse(response, {
      status: 413,
      error: 'REPORT_DOWNLOAD_TOO_LARGE',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(s3DownloadMocks.downloadFromS3).not.toHaveBeenCalled();
  });
});

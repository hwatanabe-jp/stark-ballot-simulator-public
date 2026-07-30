/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as yazl from 'yazl';
import { handler } from './handler';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';

vi.mock('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver', () => ({
  ensureAwsRuntimeConfigReferencesLoaded: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/aws/s3-download', () => ({
  downloadFromS3: vi.fn(),
}));

vi.mock('@stark-ballot/node-adapters/verifier-service-client', () => ({
  invokeVerifierService: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/aws/s3-upload', () => ({
  uploadFileToS3: vi.fn(({ filePath }: { filePath: string }) =>
    Promise.resolve({
      bucket: 'test-bucket',
      key: `uploads/${path.basename(filePath)}`,
      uploadedAt: '2025-01-01T00:00:00.000Z',
      success: true,
    }),
  ),
}));

const storeMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  recordAwsVerificationDeliveryMetadata: vi.fn(),
  completeVerificationResult: vi.fn(),
}));

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(() => storeMocks),
}));

import { downloadFromS3 } from '@stark-ballot/aws-adapters/aws/s3-download';
import { invokeVerifierService } from '@stark-ballot/node-adapters/verifier-service-client';
import { uploadFileToS3 } from '@stark-ballot/aws-adapters/aws/s3-upload';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashKeyPrefixForLogging, hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';

const resolverModule = await import('@stark-ballot/aws-adapters/config/awsRuntimeConfigReferenceResolver');

function buildPersistedFinalizationResult(input: {
  sessionId: string;
  executionId: string;
  verificationStatus: 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running';
}): Record<string, unknown> {
  const journal = createTestJournal({
    validVotes: 1,
    totalExpected: 1,
    seenIndicesCount: 1,
  });
  const bundleKey = `sessions/${input.sessionId}/${input.executionId}/bundle.zip`;
  return {
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: '0x' + '1'.repeat(64),
    journal,
    publicInputArtifact: createTestPublicInputArtifact({
      source: 'bundle',
      executionId: input.executionId,
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
    verificationExecutionId: input.executionId,
    s3BundleKey: bundleKey,
    verificationResult: {
      status: input.verificationStatus,
      executionId: input.executionId,
      s3BundleKey: bundleKey,
      s3ReportKey: `sessions/${input.sessionId}/${input.executionId}/verification.json`,
    },
  };
}

async function buildZipBuffer(entries: Record<string, unknown>): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    const chunks: Buffer[] = [];

    for (const [fileName, content] of Object.entries(entries)) {
      zipfile.addBuffer(Buffer.from(JSON.stringify(content), 'utf8'), fileName, {
        mtime: new Date(0),
        compress: false,
      });
    }

    zipfile.outputStream.on('data', (chunk: Buffer | Uint8Array | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zipfile.on('error', reject);
    zipfile.end();
  });
}

function errorWithIdentity(name: string, privateMessage: string): Error {
  const error = new Error(privateMessage);
  error.name = name;
  return error;
}

describe('target verification-worker handler', () => {
  const originalEnv = { ...process.env };
  let loggerErrorSpy: MockInstance<typeof logger.error>;
  let loggerInfoSpy: MockInstance<typeof logger.info>;
  let loggerWarnSpy: MockInstance<typeof logger.warn>;

  function configureTargetRuntimeEnv(): void {
    process.env['TARGET_AWS_RUNTIME'] = '1';
    process.env['USE_MOCK_STORE'] = 'false';
    process.env['FINALIZE_ASYNC_MODE'] = 'true';
    process.env['USE_S3'] = 'true';
    process.env['PROVER_WORK_QUEUE_URL'] =
      'https://sqs.ap-northeast-1.amazonaws.com/123456789012/stark-ballot-simulator-stark-dev-develop-prover-work';
    process.env['PROVER_STATE_MACHINE_ARN'] =
      'arn:aws:states:ap-northeast-1:123456789012:stateMachine:stark-ballot-simulator-stark-dev-develop-finalization';
    process.env['VERIFICATION_WORKER_FUNCTION_NAME'] = 'stark-ballot-simulator-stark-dev-develop-verification-worker';
    process.env['AWS_ACCOUNT_ID'] = '123456789012';
    process.env['AWS_REGION'] = 'ap-northeast-1';
    process.env['S3_PROOF_BUCKET'] = 'stark-ballot-simulator-stark-dev-develop-proof-artifacts';
    process.env['S3_PROOF_PREFIX'] = 'sessions/';
    process.env['DYNAMODB_SESSIONS_TABLE'] = 'stark-ballot-simulator-stark-dev-develop-sessions';
    process.env['DYNAMODB_VOTES_TABLE'] = 'stark-ballot-simulator-stark-dev-develop-votes';
    process.env['VERIFIER_PUBLIC_BASE_URL'] = 'https://develop.stark-ballot-sim.hwatanabe.dev';
    process.env['EXPECTED_IMAGE_ID'] = '0x' + '1'.repeat(64);
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER_REF'] =
      '/stark-ballot-simulator/stark-dev/develop/app/secrets/expected-origin-verify-header';
    process.env['EXPECTED_ORIGIN_VERIFY_HEADER'] = 'resolved-origin-verify-header-0123456789abcdef';
    process.env['LOG_IP_HASH_SALT_REF'] = '/stark-ballot-simulator/stark-dev/develop/app/secrets/log-ip-hash-salt';
    process.env['LOG_IP_HASH_SALT'] = 'resolved-target-log-hash-salt';
    process.env['LOG_FORMAT'] = 'json';
    process.env['DEPLOYMENT_ID'] = `dep_${'1'.repeat(32)}`;
    process.env['APP_SOURCE_SHA'] = '2'.repeat(40);
    process.env['DEPLOY_MODE'] = 'normal';
    delete process.env['USE_MOCK_ZKVM'];
    delete process.env['RISC0_DEV_MODE'];
    delete process.env['FORCE_DEV_MODE'];
    delete process.env['ALLOW_INSECURE_ZKVM'];
    delete process.env['ALLOW_DEV_MODE_VERIFICATION'];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.getSession.mockResolvedValue(null);
    storeMocks.recordAwsVerificationDeliveryMetadata.mockResolvedValue(undefined);
    storeMocks.completeVerificationResult.mockResolvedValue(undefined);
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    loggerInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    configureTargetRuntimeEnv();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    loggerErrorSpy.mockRestore();
    loggerInfoSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  it('verifies and re-uploads Docker-shaped async bundles without metadata.json', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-async';
    const workDir = path.join('/tmp', 'verifier-work');
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;

    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
        'input.json': { private: true },
        'included-bitmap.json': { private: true },
        'seen-bitmap.json': { private: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockImplementation(async ({ bundlePath, reportPath }) => {
      const report = {
        status: 'success' as const,
        verifier_version: 'test',
        verified_at: '2026-06-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: '0x' + '1'.repeat(64),
        bundle_path: bundlePath,
        receipt_path: path.join(bundlePath, 'receipt.json'),
        dev_mode_receipt: false,
      };
      await fs.writeFile(reportPath, JSON.stringify(report), 'utf-8');
      return {
        status: 'success',
        bundlePath,
        reportPath,
        report,
        diagnostics: {
          stderrCategory: 'truncated',
          stderrBytes: 4096,
          stderrTruncated: true,
        },
      };
    });

    const response = await handler({
      mode: 's3_bundle',
      sessionId,
      executionId,
      bundleKey,
      expectedImageId: '0x' + '1'.repeat(64),
      options: {
        uploadToS3: true,
      },
    });

    expect(response).toEqual(
      expect.objectContaining({
        status: 'success',
        sessionId,
        executionId,
        verifierStatus: 'success',
      }),
    );
    if (response.status === 'success') {
      expect(response.s3).toEqual({
        bundleKey: 'uploads/bundle.zip',
        reportKey: 'uploads/verification.json',
        uploadedAt: '2025-01-01T00:00:00.000Z',
      });
      expect(response.s3).not.toHaveProperty('bundleUrl');
      expect(response.s3).not.toHaveProperty('expiresAt');
    }
    expect(invokeVerifierService).toHaveBeenCalledWith(
      expect.objectContaining({
        bundlePath: path.join(workDir, sessionId, executionId),
        reportPath: path.join(workDir, sessionId, executionId, 'verification.json'),
      }),
    );
    expect(loggerInfoSpy).toHaveBeenCalledWith('[VerificationWorker] verifier-service diagnostics', {
      event: 'verifier_service_diagnostic',
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: executionId,
      stderr_category: 'truncated',
      stderr_bytes: 4096,
      stderr_truncated: true,
    });
    expect(JSON.stringify(loggerInfoSpy.mock.calls)).not.toContain('stderr output');
    expect(JSON.stringify(response)).not.toContain('stderr');
    const uploadedFiles = vi
      .mocked(uploadFileToS3)
      .mock.calls.map((call) => path.basename(call[0].filePath))
      .sort();
    expect(uploadedFiles).toEqual(
      expect.arrayContaining(['bundle.zip', 'verification.json', 'included-bitmap.json', 'seen-bitmap.json']),
    );
  });

  it('fails closed on insecure target proof-mode flags before S3 or verifier work', async () => {
    process.env['ALLOW_INSECURE_ZKVM'] = 'true';

    await expect(
      handler({
        mode: 's3_bundle',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        executionId: 'exec-async',
        bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-async/bundle.zip',
        expectedImageId: '0x' + '1'.repeat(64),
      }),
    ).rejects.toThrow('Runtime configuration validation failed');

    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(uploadFileToS3).not.toHaveBeenCalled();
    expect(loggerErrorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['ALLOW_INSECURE_ZKVM'],
    });
  });

  it('emits runtime reference names only when cold-start resolution fails', async () => {
    const secretValue = 'never-log-this-resolved-secret';
    const resolutionError = new Error(`resolution failed: ${secretValue}`);
    vi.mocked(resolverModule.ensureAwsRuntimeConfigReferencesLoaded).mockImplementationOnce(
      async (_entrypoint, options) => {
        if (!options) throw new Error('Expected runtime-reference resolver options');
        options.invalidNameCollector?.add('EXPECTED_ORIGIN_VERIFY_HEADER_REF');
        await Promise.reject(resolutionError);
      },
    );

    await expect(handler({ Records: [] })).rejects.toMatchObject({
      name: 'RuntimeConfigValidationError',
      message: 'Runtime configuration validation failed',
      invalidNames: ['EXPECTED_ORIGIN_VERIFY_HEADER_REF'],
    });

    expect(loggerErrorSpy).toHaveBeenCalledWith('Runtime configuration is invalid', {
      event: 'config_invalid',
      invalid_names: ['EXPECTED_ORIGIN_VERIFY_HEADER_REF'],
    });
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(secretValue);
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied workDir in target runtime before S3 or verifier work', async () => {
    const response = await handler({
      mode: 's3_bundle',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      executionId: 'exec-async',
      bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-async/bundle.zip',
      expectedImageId: '0x' + '1'.repeat(64),
      options: {
        uploadToS3: true,
        workDir: path.join(process.cwd(), '.test-target-verification-worker'),
      },
    });

    expect(response).toEqual({
      status: 'error',
      message: 'Invalid verifier invocation payload',
      details: 'workDir is not allowed when TARGET_AWS_RUNTIME=1',
    });
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(uploadFileToS3).not.toHaveBeenCalled();
  });

  it('rejects disabled S3 upload in target runtime before S3 or verifier work', async () => {
    const response = await handler({
      mode: 's3_bundle',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      executionId: 'exec-async',
      bundleKey: 'sessions/550e8400-e29b-41d4-a716-446655440000/exec-async/bundle.zip',
      expectedImageId: '0x' + '1'.repeat(64),
      options: {
        uploadToS3: false,
      },
    });

    expect(response).toEqual({
      status: 'error',
      message: 'Invalid verifier invocation payload',
      details: 'uploadToS3=false is not allowed when TARGET_AWS_RUNTIME=1',
    });
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(uploadFileToS3).not.toHaveBeenCalled();
  });

  it('rejects foreign bundle keys before S3 or verifier work', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-async';

    const response = await handler({
      mode: 's3_bundle',
      sessionId,
      executionId,
      bundleKey: `sessions/550e8400-e29b-41d4-a716-446655440999/${executionId}/bundle.zip`,
      expectedImageId: '0x' + '1'.repeat(64),
      options: {
        uploadToS3: true,
      },
    });

    expect(response.status).toBe('error');
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(uploadFileToS3).not.toHaveBeenCalled();
  });

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe execution id %s before S3 or verifier work',
    async (executionId) => {
      const response = await handler({
        mode: 's3_bundle',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        executionId,
        bundleKey: `sessions/550e8400-e29b-41d4-a716-446655440000/${executionId}/bundle.zip`,
        expectedImageId: '0x' + '1'.repeat(64),
        options: {
          uploadToS3: true,
        },
      });

      expect(response).toEqual({
        status: 'error',
        message: 'Invalid verifier invocation payload',
        details: 'Invalid verifier invocation payload',
      });
      expect(downloadFromS3).not.toHaveBeenCalled();
      expect(invokeVerifierService).not.toHaveBeenCalled();
      expect(uploadFileToS3).not.toHaveBeenCalled();
    },
  );

  it('keeps verifier stderr, paths, and S3 keys out of runner error details', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-verifier-failure';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const leakedPath = `/tmp/verifier-work/${sessionId}/${executionId}/verification.json`;
    const leakedError = `verifier stderr: failed at ${leakedPath} while reading s3://${bundleKey}`;

    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockRejectedValue(new Error(leakedError));

    const response = await handler({
      mode: 's3_bundle',
      sessionId,
      executionId,
      bundleKey,
      expectedImageId: '0x' + '1'.repeat(64),
      options: {
        uploadToS3: true,
      },
    });

    expect(response.status).toBe('error');
    if (response.status !== 'error') {
      throw new Error('expected verification worker error response');
    }
    expect(response.message).toBe('verifier-service execution failed');
    expect(response.details).toBe('Verifier service execution failed');
    expect(JSON.stringify(response)).not.toContain(leakedPath);
    expect(JSON.stringify(response)).not.toContain(bundleKey);
    expect(JSON.stringify(response)).not.toContain('verifier stderr');
    expect(uploadFileToS3).not.toHaveBeenCalled();
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[VerificationWorker] Verifier service execution failed',
      expect.objectContaining({
        session_id_hash: hashSessionIdForLogging(sessionId),
        executionId,
        bundle_key_prefix: hashKeyPrefixForLogging(bundleKey),
        failure_category: 'verifier_crash',
      }),
      expect.objectContaining({
        name: 'VerificationInfrastructureError',
        message: 'Verification infrastructure stage failed',
        failureCategory: 'verifier_crash',
      }),
    );
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(leakedError);
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(leakedPath);
    expect(JSON.stringify(loggerErrorSpy.mock.calls)).not.toContain(bundleKey);
    expect(loggerInfoSpy).toHaveBeenCalledWith('[VerificationWorker] verifier-service diagnostics', {
      event: 'verifier_service_diagnostic',
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: executionId,
      stderr_category: 'none',
      stderr_bytes: 0,
      stderr_truncated: false,
    });
  });

  it('emits only closed verifier diagnostics carried by a failed invocation', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-bounded-verifier-failure';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const privateStderr = 's3://private-bucket/raw-session/input.json private receipt bytes';

    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockRejectedValue(
      Object.assign(new Error(privateStderr), {
        diagnostics: {
          stderrCategory: 'truncated',
          stderrBytes: 4096,
          stderrTruncated: true,
        },
      }),
    );

    const response = await handler({
      mode: 's3_bundle',
      sessionId,
      executionId,
      bundleKey,
      expectedImageId: '0x' + '1'.repeat(64),
      options: { uploadToS3: true },
    });

    expect(response.status).toBe('error');
    expect(loggerInfoSpy).toHaveBeenCalledWith('[VerificationWorker] verifier-service diagnostics', {
      event: 'verifier_service_diagnostic',
      session_id_hash: hashSessionIdForLogging(sessionId),
      execution_id: executionId,
      stderr_category: 'truncated',
      stderr_bytes: 4096,
      stderr_truncated: true,
    });
    expect(JSON.stringify(loggerInfoSpy.mock.calls)).not.toContain(privateStderr);
    expect(JSON.stringify(response)).not.toContain(privateStderr);
  });

  it('processes SQS verification work and persists completed verification state', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-verification';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;

    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockImplementation(async ({ bundlePath, reportPath }) => {
      const report = {
        status: 'success' as const,
        verifier_version: 'test',
        verified_at: '2026-06-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: '0x' + '1'.repeat(64),
        dev_mode_receipt: false,
      };
      await fs.writeFile(reportPath, JSON.stringify(report), 'utf-8');
      return {
        status: 'success',
        bundlePath,
        reportPath,
        report,
      };
    });

    const response = await handler({
      Records: [
        {
          messageId: 'message-1',
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [] });
    expect(storeMocks.recordAwsVerificationDeliveryMetadata).toHaveBeenCalledWith(sessionId, executionId, {
      s3BundleKey: 'uploads/bundle.zip',
      s3ReportKey: 'uploads/verification.json',
      s3UploadedAt: '2025-01-01T00:00:00.000Z',
    });
    const [, completedPayload] = storeMocks.completeVerificationResult.mock.calls[0] as [
      string,
      {
        executionId: string;
        verificationResult: {
          status: string;
          report?: {
            status?: string;
          };
        };
      },
    ];
    expect(completedPayload.executionId).toBe(executionId);
    expect(completedPayload.verificationResult.status).toBe('success');
    expect(completedPayload.verificationResult).toHaveProperty('failureCategory', 'none');
    expect(completedPayload.verificationResult.report?.status).toBe('success');
    expect(loggerWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('bitmap'), expect.anything());
  });

  it('fails closed when target runtime cannot access an optional private sidecar unexpectedly', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sidecar-access';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;

    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockImplementation(async ({ bundlePath, reportPath }) => {
      const report = {
        status: 'success' as const,
        verifier_version: 'test',
        verified_at: '2026-06-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: '0x' + '1'.repeat(64),
        dev_mode_receipt: false,
      };
      await fs.writeFile(reportPath, JSON.stringify(report), 'utf-8');
      return { status: 'success', bundlePath, reportPath, report };
    });
    const realAccess = fs.access.bind(fs);
    const accessSpy = vi.spyOn(fs, 'access').mockImplementation(async (filePath) => {
      if (path.basename(String(filePath)) === 'included-bitmap.json') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return await realAccess(filePath);
    });

    try {
      const response = await handler({
        mode: 's3_bundle',
        sessionId,
        executionId,
        bundleKey,
        expectedImageId: '0x' + '1'.repeat(64),
      });

      expect(response.status).toBe('error');
      expect(loggerWarnSpy).toHaveBeenCalledWith('[Bundle] Included bitmap access failed:', 'permission denied');
    } finally {
      accessSpy.mockRestore();
    }
  });

  it('deduplicates repeated SQS work for the same execution within one batch', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-duplicate';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const body = JSON.stringify({
      messageVersion: 'v1',
      sessionId,
      executionId,
      queuedAt: 1_700_000_000_000,
      bundleKey,
      expectedImageId: '0x' + '1'.repeat(64),
    });

    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockImplementation(async ({ bundlePath, reportPath }) => {
      const report = {
        status: 'success' as const,
        verifier_version: 'test',
        verified_at: '2026-06-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: '0x' + '1'.repeat(64),
        dev_mode_receipt: false,
      };
      await fs.writeFile(reportPath, JSON.stringify(report), 'utf-8');
      return {
        status: 'success',
        bundlePath,
        reportPath,
        report,
      };
    });

    const response = await handler({
      Records: [
        { messageId: 'message-1', body },
        { messageId: 'message-2', body },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [] });
    expect(downloadFromS3).toHaveBeenCalledTimes(1);
    expect(invokeVerifierService).toHaveBeenCalledTimes(1);
    expect(storeMocks.completeVerificationResult).toHaveBeenCalledTimes(1);
  });

  it('skips post-completion SQS redelivery without rerunning the verifier', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-completed-redelivery';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    storeMocks.getSession.mockResolvedValue({
      finalizationResult: buildPersistedFinalizationResult({
        sessionId,
        executionId,
        verificationStatus: 'success',
      }),
    });

    const response = await handler({
      Records: [
        {
          messageId: 'message-completed-redelivery',
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [] });
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(storeMocks.recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(storeMocks.completeVerificationResult).not.toHaveBeenCalled();
  });

  it('skips stale SQS redelivery for a superseded execution without overwriting current state', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const staleExecutionId = 'exec-sqs-stale-redelivery';
    const currentExecutionId = 'exec-sqs-current';
    const bundleKey = `sessions/${sessionId}/${staleExecutionId}/bundle.zip`;
    storeMocks.getSession.mockResolvedValue({
      finalizationResult: buildPersistedFinalizationResult({
        sessionId,
        executionId: currentExecutionId,
        verificationStatus: 'running',
      }),
    });

    const response = await handler({
      Records: [
        {
          messageId: 'message-stale-redelivery',
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId: staleExecutionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [] });
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(storeMocks.recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(storeMocks.completeVerificationResult).not.toHaveBeenCalled();
  });

  it('persists verifier-reported verification failure as a terminal completed result', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-verifier-failed';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;

    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockImplementation(async ({ bundlePath, reportPath }) => {
      const report = {
        status: 'failed' as const,
        verifier_version: 'test',
        verified_at: '2026-06-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: '0x' + '2'.repeat(64),
        dev_mode_receipt: false,
      };
      await fs.writeFile(reportPath, JSON.stringify(report), 'utf-8');
      return {
        status: 'failed',
        bundlePath,
        reportPath,
        report,
      };
    });

    const response = await handler({
      Records: [
        {
          messageId: 'message-verifier-failed',
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [] });
    const [, completedPayload] = storeMocks.completeVerificationResult.mock.calls[0] as [
      string,
      {
        executionId: string;
        verificationResult: {
          status: string;
          report?: {
            status?: string;
          };
        };
      },
    ];
    expect(completedPayload).toMatchObject({
      executionId,
      verificationResult: {
        status: 'failed',
        failureCategory: 'none',
        report: {
          status: 'failed',
        },
      },
    });
  });

  it('returns partial batch failures so SQS can retry and eventually route to the DLQ', async () => {
    const privateUri = 's3://private-bucket/sessions/raw-session/input.json';
    const response = await handler({
      Records: [
        {
          messageId: 'message-invalid',
          body: `{not-json-${privateUri}`,
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-invalid' }] });
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(storeMocks.completeVerificationResult).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'sqs',
      reason: 'record_body_invalid',
    });
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(privateUri);
    expect(loggerErrorSpy).not.toHaveBeenCalledWith(
      '[VerificationWorker] SQS verification work failed',
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects malformed SQS envelopes without treating them as direct invocations', async () => {
    const privateUri = 's3://private-bucket/sessions/raw-session/input.json';

    await expect(handler({ Records: privateUri })).rejects.toThrow('Invalid SQS invocation');

    expect(loggerWarnSpy).toHaveBeenCalledWith('Invocation payload is invalid', {
      event: 'invocation_invalid',
      source_kind: 'sqs',
      reason: 'event_shape_invalid',
    });
    expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toContain(privateUri);
    expect(downloadFromS3).not.toHaveBeenCalled();
    expect(invokeVerifierService).not.toHaveBeenCalled();
  });

  it('returns SQS retry for S3 download failures without persisting terminal failure', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-s3-download-failure';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    vi.mocked(downloadFromS3).mockRejectedValueOnce(new Error('simulated S3 timeout'));

    const response = await handler({
      Records: [
        {
          messageId: 'message-s3-timeout',
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-s3-timeout' }] });
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(storeMocks.recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(storeMocks.completeVerificationResult).not.toHaveBeenCalled();
  });

  it('returns SQS retry for verifier process failures without persisting terminal failure', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-verifier-process-failure';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockRejectedValueOnce(new Error('simulated verifier process failure'));

    const response = await handler({
      Records: [
        {
          messageId: 'message-verifier-process-failure',
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-verifier-process-failure' }] });
    expect(storeMocks.recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(storeMocks.completeVerificationResult).not.toHaveBeenCalled();
  });

  it('returns SQS retry for verification artifact upload failures without persisting terminal failure', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-upload-failure';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    vi.mocked(uploadFileToS3).mockRejectedValueOnce(new Error('simulated upload failure'));
    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockImplementation(async ({ bundlePath, reportPath }) => {
      const report = {
        status: 'success' as const,
        verifier_version: 'test',
        verified_at: '2026-06-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: '0x' + '1'.repeat(64),
        dev_mode_receipt: false,
      };
      await fs.writeFile(reportPath, JSON.stringify(report), 'utf-8');
      return {
        status: 'success',
        bundlePath,
        reportPath,
        report,
      };
    });

    const response = await handler({
      Records: [
        {
          messageId: 'message-upload-failure',
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-upload-failure' }] });
    expect(storeMocks.recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(storeMocks.completeVerificationResult).not.toHaveBeenCalled();
  });

  it('persists terminal failed status on the final SQS retry before DLQ redrive', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-final-retry-failure';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    vi.mocked(downloadFromS3).mockRejectedValueOnce(
      errorWithIdentity('TimeoutError', 's3://private-bucket/sessions/raw-session/input.json timed out'),
    );

    const response = await handler({
      Records: [
        {
          messageId: 'message-final-s3-timeout',
          attributes: {
            ApproximateReceiveCount: '3',
          },
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-final-s3-timeout' }] });
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(storeMocks.recordAwsVerificationDeliveryMetadata).not.toHaveBeenCalled();
    expect(storeMocks.completeVerificationResult).toHaveBeenCalledWith(sessionId, {
      executionId,
      verificationResult: {
        status: 'failed',
        failureCategory: 'timeout',
      },
    });
  });

  it.each([
    ['AccessDenied', 's3_denied'],
    ['NoSuchKey', 's3_missing'],
    ['UnrecognizedSdkFailure', 'unknown'],
  ] as const)('persists the closed %s download category after retry exhaustion', async (errorName, category) => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = `exec-sqs-${category.replaceAll('_', '-')}`;
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const privateMessage = 's3://private-bucket/sessions/raw-session/input.json token=private-runtime-secret';
    vi.mocked(downloadFromS3).mockRejectedValueOnce(errorWithIdentity(errorName, privateMessage));

    const response = await handler({
      Records: [
        {
          messageId: `message-${category}`,
          attributes: { ApproximateReceiveCount: '3' },
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: `message-${category}` }] });
    expect(storeMocks.completeVerificationResult).toHaveBeenCalledWith(sessionId, {
      executionId,
      verificationResult: {
        status: 'failed',
        failureCategory: category,
      },
    });
    expect(JSON.stringify(storeMocks.completeVerificationResult.mock.calls)).not.toContain(privateMessage);
  });

  it('persists corrupt_bundle for extraction failure without storing bundle bytes or exception text', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-corrupt-bundle';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const privateBytes = 'not-a-zip private-opening=0x1234';
    vi.mocked(downloadFromS3).mockResolvedValueOnce(Buffer.from(privateBytes));

    const response = await handler({
      Records: [
        {
          messageId: 'message-corrupt-bundle',
          attributes: { ApproximateReceiveCount: '3' },
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-corrupt-bundle' }] });
    expect(invokeVerifierService).not.toHaveBeenCalled();
    expect(storeMocks.completeVerificationResult).toHaveBeenCalledWith(sessionId, {
      executionId,
      verificationResult: {
        status: 'failed',
        failureCategory: 'corrupt_bundle',
      },
    });
    expect(JSON.stringify(storeMocks.completeVerificationResult.mock.calls)).not.toContain(privateBytes);
  });

  it('persists verifier_crash for a verifier process failure after retry exhaustion', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-verifier-crash';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const privateMessage = 'verifier stderr: private receipt bytes 0x1234';
    vi.mocked(downloadFromS3).mockResolvedValueOnce(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockRejectedValueOnce(new Error(privateMessage));

    const response = await handler({
      Records: [
        {
          messageId: 'message-verifier-crash',
          attributes: { ApproximateReceiveCount: '3' },
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-verifier-crash' }] });
    expect(storeMocks.completeVerificationResult).toHaveBeenCalledWith(sessionId, {
      executionId,
      verificationResult: {
        status: 'failed',
        failureCategory: 'verifier_crash',
      },
    });
    expect(JSON.stringify(storeMocks.completeVerificationResult.mock.calls)).not.toContain(privateMessage);
  });

  it('returns the message to SQS retry when final state persistence fails after verifier success', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-sqs-store-timeout';
    const bundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    storeMocks.completeVerificationResult.mockRejectedValueOnce(new Error('simulated store timeout'));

    vi.mocked(downloadFromS3).mockResolvedValue(
      await buildZipBuffer({
        'public-input.json': { schema: 'stark-ballot.public_input', version: '1.0', votes: [] },
        'election-manifest.json': { electionId: 'election-1' },
        'close-statement.json': { treeSize: 1 },
        'receipt.json': { receipt: true },
        'journal.json': { journal: true },
      }),
    );
    vi.mocked(invokeVerifierService).mockImplementation(async ({ bundlePath, reportPath }) => {
      const report = {
        status: 'success' as const,
        verifier_version: 'test',
        verified_at: '2026-06-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: '0x' + '1'.repeat(64),
        receipt_image_id: '0x' + '1'.repeat(64),
        dev_mode_receipt: false,
      };
      await fs.writeFile(reportPath, JSON.stringify(report), 'utf-8');
      return {
        status: 'success',
        bundlePath,
        reportPath,
        report,
      };
    });

    const response = await handler({
      Records: [
        {
          messageId: 'message-store-timeout',
          body: JSON.stringify({
            messageVersion: 'v1',
            sessionId,
            executionId,
            queuedAt: 1_700_000_000_000,
            bundleKey,
            expectedImageId: '0x' + '1'.repeat(64),
          }),
        },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-store-timeout' }] });
    expect(storeMocks.recordAwsVerificationDeliveryMetadata).toHaveBeenCalledTimes(1);
    expect(storeMocks.completeVerificationResult).toHaveBeenCalledTimes(1);
  });
});

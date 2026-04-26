import { Buffer } from 'buffer';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { DEFAULT_POC_IMAGE_ID } from './routeConstants';
import { getExpectedImageId } from '@/lib/verification/image-id-verifier';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { getDefaultExecutor } from '@/lib/zkvm/executor-factory';
import { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';
import { addHexPrefix } from '@/lib/utils/hex';
import { getRecordProperty, getStringProperty } from '@/lib/utils/guards';
import type { SessionData, VoteData } from '@/types/server';
import { BOT_COUNT, VOTE_CHOICES } from '@/shared/constants';
import { invokeVerifierService } from '@/lib/verification/verifier-service-client';
import {
  persistVerificationBundle,
  createVerificationBundleArchive,
  uploadVerificationBundleToS3,
  type VerificationBundleContext,
} from '@/lib/verification/verification-bundle';
import { ErrorCode } from '@/lib/errors';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import type { VoteStore } from '@/types/voteStore';
import type { ZkVMExecutor } from '@/lib/zkvm/executor-factory';
import type { ZkVMExecutionResult } from '@/lib/zkvm/executor';
import { computeCommitment, CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { buildDefaultElectionConfig, getDefaultElectionConfigHash } from '@/lib/zkvm/election-config';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { deriveLegacyJournalCountCompatibility } from '@/lib/zkvm/journal-count-compat';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock dependencies
vi.mock('@/lib/store/storeInstance');
vi.mock('@/lib/zkvm/executor-factory');
vi.mock('@/lib/verification/verifier-service-client');
vi.mock('@/lib/verification/verification-bundle');
vi.mock('@/lib/verification/image-id-verifier', () => ({
  getExpectedImageId: vi.fn().mockResolvedValue('0x98465a16a6776bd5fc35299e06dfea5886f87d2f94aac5fd79353af50caa01f4'),
}));

function createVoteData(overrides: Partial<VoteData> = {}): VoteData {
  return {
    vote: 'A',
    commit: '0x' + '1'.repeat(64),
    rand: '0x' + '2'.repeat(64),
    path: [],
    ...overrides,
  };
}

function createBaseSession(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  const electionConfig = buildDefaultElectionConfig();
  return {
    sessionId: 'session-base',
    contractGeneration: resolveCurrentContractGeneration(),
    electionConfigHash: getDefaultElectionConfigHash(),
    electionConfig,
    votes: new Map<number, VoteData>(),
    botCount: 0,
    finalized: false,
    createdAt: now,
    lastActivity: now,
    ...overrides,
  };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function ensureRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

async function readJsonRecord(response: Response, label: string): Promise<JsonRecord> {
  const payload: unknown = await response.json();
  return ensureRecord(payload, label);
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    throw new Error(`${label} response is empty`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

describe('POST /api/finalize', () => {
  let mockStore: VoteStore;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;
  let updateSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['updateSession']>>>;
  let finalizeSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['finalizeSession']>>>;
  let executor: ZkVMExecutor;
  const imageId = DEFAULT_POC_IMAGE_ID;
  const modernReceiptPayload = {
    seal: 'A'.repeat(4096),
    journal: { bytes: [1, 2, 3, 4, 5] },
  };
  const fakeReceiptPayload = {
    inner: {
      Fake: {
        claim: {
          Value: {
            exit_code: { Halted: 0 },
          },
        },
      },
    },
    journal: { bytes: [9, 8, 7, 6] },
    metadata: {
      note: 'dev-mode',
    },
  };
  const createMockExecutionResult = (overrides: Partial<ZkVMExecutionResult> = {}): ZkVMExecutionResult => {
    const result: ZkVMExecutionResult = {
      verifiedTally: [30, 13, 8, 7, 6],
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 64,
      totalExpected: 64,
      totalVotes: 64,
      validVotes: 64,
      invalidVotes: 0,
      seenIndicesCount: 64,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      seenBitmapRoot: '0x' + '6'.repeat(64),
      includedBitmapRoot: '0x' + '2'.repeat(64),
      excludedSlots: 0,
      inputCommitment: '0x' + '3'.repeat(64),
      methodVersion: CURRENT_METHOD_VERSION,
      electionId: '550e8400-e29b-41d4-a716-446655440000',
      electionConfigHash: '0x' + '4'.repeat(64),
      sthDigest: '0x' + '5'.repeat(64),
      imageId,
      ...overrides,
    };

    return {
      ...result,
      ...deriveLegacyJournalCountCompatibility(result),
    };
  };

  const toBase64 = (values: number[]): string => Buffer.from(Uint8Array.from(values)).toString('base64');

  let originalExpectedImageIdEnv: string | undefined;
  let originalDevModeEnv: string | undefined;
  let originalSessionCapabilitySecret: string | undefined;
  let originalRuntimeDeploymentEnv: string | undefined;
  const originalTurnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  const originalTurnstileBypass = process.env.TURNSTILE_BYPASS;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExpectedImageIdEnv = process.env.EXPECTED_IMAGE_ID;
    originalDevModeEnv = process.env.RISC0_DEV_MODE;
    originalSessionCapabilitySecret = process.env.SESSION_CAPABILITY_SECRET;
    originalRuntimeDeploymentEnv = process.env.RUNTIME_DEPLOYMENT_ENV;
    process.env.EXPECTED_IMAGE_ID = imageId;
    vi.mocked(getExpectedImageId).mockResolvedValue(imageId);
    delete process.env.RISC0_DEV_MODE;
    setTestSessionCapabilitySecret();
    process.env.TURNSTILE_BYPASS = '1';
    process.env.RUNTIME_DEPLOYMENT_ENV = 'develop';
    delete process.env.TURNSTILE_SECRET_KEY;

    // Setup default executor mock (can be overridden per test)
    executor = {
      type: 'real',
      version: '1.0',
      execute: vi.fn().mockResolvedValue(
        createMockExecutionResult({
          receipt: {
            imageId,
            payload: modernReceiptPayload,
            raw: {
              receipt: modernReceiptPayload,
              image_id: imageId,
            },
          },
        }),
      ),
    };
    vi.mocked(getDefaultExecutor).mockResolvedValue(executor);

    // Setup mock store
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    updateSessionMock = vi.fn<NonNullable<VoteStore['updateSession']>>();
    finalizeSessionMock = vi.fn<NonNullable<VoteStore['finalizeSession']>>();
    mockStore = createMockVoteStore({
      getSession: getSessionMock,
      updateSession: updateSessionMock,
      finalizeSession: finalizeSessionMock,
    });

    vi.mocked(getGlobalStore).mockReturnValue(mockStore);
    vi.mocked(persistVerificationBundle).mockImplementation((context: VerificationBundleContext) =>
      Promise.resolve({
        bundlePath: '/tmp/bundle',
        receiptPath: '/tmp/bundle/receipt.json',
        inputPath: '/tmp/bundle/input.json',
        journalPath: '/tmp/bundle/journal.json',
        electionManifestPath: '/tmp/bundle/election-manifest.json',
        closeStatementPath: '/tmp/bundle/close-statement.json',
        metadataPath: '/tmp/bundle/metadata.json',
        reportPath: '/tmp/bundle/verification.json',
        sessionId: context.sessionId,
        executionId: 'exec-123',
      }),
    );
    vi.mocked(createVerificationBundleArchive).mockResolvedValue('/tmp/bundle/bundle.zip');
    vi.mocked(uploadVerificationBundleToS3).mockResolvedValue({});
    vi.mocked(invokeVerifierService).mockResolvedValue({
      status: 'success',
      reportPath: '/tmp/bundle/verification.json',
      bundlePath: '/tmp/bundle',
      report: {
        status: 'success',
        verifier_version: '0.1.0',
        verified_at: '2025-10-16T00:00:00Z',
        duration_ms: 42,
        expected_image_id: imageId,
        receipt_image_id: imageId,
        bundle_path: '/tmp/bundle',
        receipt_path: '/tmp/bundle/receipt.json',
        dev_mode_receipt: false,
        errors: [],
      },
    });

    // Set test environment
    process.env.USE_MOCK_STORE = 'true';
  });

  afterEach(() => {
    if (originalExpectedImageIdEnv === undefined) {
      delete process.env.EXPECTED_IMAGE_ID;
    } else {
      process.env.EXPECTED_IMAGE_ID = originalExpectedImageIdEnv;
    }
    if (originalDevModeEnv === undefined) {
      delete process.env.RISC0_DEV_MODE;
    } else {
      process.env.RISC0_DEV_MODE = originalDevModeEnv;
    }
    if (originalSessionCapabilitySecret === undefined) {
      delete process.env.SESSION_CAPABILITY_SECRET;
    } else {
      process.env.SESSION_CAPABILITY_SECRET = originalSessionCapabilitySecret;
    }
    if (originalRuntimeDeploymentEnv === undefined) {
      delete process.env.RUNTIME_DEPLOYMENT_ENV;
    } else {
      process.env.RUNTIME_DEPLOYMENT_ENV = originalRuntimeDeploymentEnv;
    }

    if (originalTurnstileSecret === undefined) {
      delete process.env.TURNSTILE_SECRET_KEY;
    } else {
      process.env.TURNSTILE_SECRET_KEY = originalTurnstileSecret;
    }

    if (originalTurnstileBypass === undefined) {
      delete process.env.TURNSTILE_BYPASS;
    } else {
      process.env.TURNSTILE_BYPASS = originalTurnstileBypass;
    }
  });

  it('rejects finalize requests without Turnstile token when enforcement is enabled', async () => {
    process.env.TURNSTILE_BYPASS = '0';
    process.env.TURNSTILE_SECRET_KEY = 'live-secret';
    const sessionId = 'session-finalize-1';
    getSessionMock.mockResolvedValue(createBaseSession({ sessionId }));

    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    const data = await readJsonRecord(response, 'finalize response');

    expect(response.status).toBe(403);
    expect(data.error).toBe(ErrorCode.CAPTCHA_FAILED);
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it('returns 401 when capability token is missing', async () => {
    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': 'session-finalize-1',
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    const data = await readJsonRecord(response, 'finalize missing capability response');

    expect(response.status).toBe(401);
    expect(data.error).toBe(ErrorCode.SESSION_CAPABILITY_REQUIRED);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('returns 401 before parsing malformed JSON when capability token is missing', async () => {
    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': 'session-finalize-malformed',
      },
      body: '{',
    });

    const response = await POST(request);
    const data = await readJsonRecord(response, 'finalize malformed missing capability response');

    expect(response.status).toBe(401);
    expect(data.error).toBe(ErrorCode.SESSION_CAPABILITY_REQUIRED);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('returns 413 when finalize payload exceeds body limit', async () => {
    const originalBodyLimit = process.env.API_REQUEST_BODY_LIMIT_BYTES;
    process.env.API_REQUEST_BODY_LIMIT_BYTES = '130';
    const sessionId = 'session-finalize-too-large';
    getSessionMock.mockResolvedValue(createBaseSession({ sessionId }));

    try {
      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': sessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(sessionId),
        },
        body: JSON.stringify({
          scenarioId: 'S0',
          turnstileToken: 'x'.repeat(256),
        }),
      });

      const response = await POST(request);
      const data = await readJsonRecord(response, 'finalize oversized response');

      expect(response.status).toBe(413);
      expect(data.error).toBe('PAYLOAD_TOO_LARGE');
      expect(finalizeSessionMock).not.toHaveBeenCalled();
    } finally {
      if (originalBodyLimit === undefined) {
        delete process.env.API_REQUEST_BODY_LIMIT_BYTES;
      } else {
        process.env.API_REQUEST_BODY_LIMIT_BYTES = originalBodyLimit;
      }
    }
  });

  it('returns 401 when capability token is invalid', async () => {
    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': 'session-finalize-1',
        [SESSION_CAPABILITY_HEADER]: 'invalid-capability-token',
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    const data = await readJsonRecord(response, 'finalize invalid capability response');

    expect(response.status).toBe(401);
    expect(data.error).toBe(ErrorCode.SESSION_CAPABILITY_INVALID);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('returns 401 when capability token is expired', async () => {
    const expiredToken = createTestSessionCapabilityToken('session-finalize-1', {
      nowMs: Date.now() - 10_000,
      ttlSeconds: 1,
    });

    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': 'session-finalize-1',
        [SESSION_CAPABILITY_HEADER]: expiredToken,
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    const data = await readJsonRecord(response, 'finalize expired capability response');

    expect(response.status).toBe(401);
    expect(data.error).toBe(ErrorCode.SESSION_CAPABILITY_EXPIRED);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  describe('inputCommitment integration', () => {
    it('should compute and return inputCommitment in response', async () => {
      // Arrange
      const mockSessionId = 'test-session-123';
      const mockSession: SessionData = withBulletin(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          logId: '0x' + '0'.repeat(64),
          votes: new Map([
            [0, createVoteData({ vote: 'A', commit: '0x' + 'a'.repeat(64), rand: '0x' + '1'.repeat(64) })],
            [1, createVoteData({ vote: 'B', commit: '0x' + 'b'.repeat(64), rand: '0x' + '2'.repeat(64) })],
            [2, createVoteData({ vote: 'C', commit: '0x' + 'c'.repeat(64), rand: '0x' + '3'.repeat(64) })],
          ]),
          userVoteIndex: 0,
          botCount: 63,
          finalized: false,
        }),
      );

      getSessionMock.mockResolvedValue(mockSession);

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      // Act
      const response = await POST(request);
      const responsePayload = await readJson(response, 'Finalize');
      const responseBody = ensureRecord(responsePayload, 'Finalize response');
      const data = ensureRecord(responseBody.data, 'Finalize response data');

      // Assert
      expect(response.status).toBe(200);
      expect(data).toBeDefined();
      expect(data.tally).toBeDefined();
      expect(data.receipt).toEqual({
        seal: modernReceiptPayload.seal,
        journal: toBase64(modernReceiptPayload.journal.bytes),
        imageId,
      });

      expect(data.imageId).toBe(imageId);
      expect(ensureString(data.inputCommitment, 'inputCommitment')).toBeDefined();

      expect(finalizeSessionMock).toHaveBeenCalled();
      const finalizeCall = finalizeSessionMock.mock.calls[0] ?? [];
      expect(finalizeCall[0]).toBe(mockSessionId);
      expect(finalizeCall[2]).toBe(resolveCurrentContractGeneration());
      const finalizePayload = ensureRecord(finalizeCall[1], 'finalize payload');
      const receiptPayload = ensureRecord(finalizePayload.receipt, 'receipt');
      expect(ensureString(receiptPayload.seal, 'receipt.seal')).toBe(modernReceiptPayload.seal);
      expect(ensureString(receiptPayload.journal, 'receipt.journal')).toBe(
        toBase64(modernReceiptPayload.journal.bytes),
      );
      expect(ensureString(receiptPayload.imageId, 'receipt.imageId')).toBe(imageId);
      expect(finalizePayload.receiptRaw).toEqual(modernReceiptPayload);
      const verificationResult = ensureRecord(finalizePayload.verificationResult, 'verificationResult');
      expect(ensureString(verificationResult.status, 'verificationResult.status')).toBe('success');
      expect(verificationResult).not.toHaveProperty('bundlePath');
      expect(verificationResult).not.toHaveProperty('reportPath');
      expect(verificationResult).not.toHaveProperty('bundleArchivePath');
      expect(verificationResult).not.toHaveProperty('bundleUrl');
      expect(verificationResult).not.toHaveProperty('reportUrl');
      const report = ensureRecord(verificationResult.report, 'verificationResult.report');
      expect(ensureString(report.status, 'verificationResult.report.status')).toBe('success');

      expect(data.verificationStatus).toBe('success');
      expect(data.verificationExecutionId).toBe('exec-123');
      const publicVerificationReport = ensureRecord(data.verificationReport, 'verificationReport');
      expect(publicVerificationReport).not.toHaveProperty('bundle_path');
      expect(publicVerificationReport).not.toHaveProperty('receipt_path');
    });

    it('accepts composite receipts returned by the zkVM host', async () => {
      // Composite receipts are the default format from RISC Zero default_prover()
      const compositeSealWords = Array.from({ length: 128 }, (_, i) => (0x01020304 + i) >>> 0);
      const compositeJournalBytes = Array.from({ length: 64 }, (_, i) => (i * 5) % 256);

      const compositePayload = {
        inner: {
          Composite: {
            segments: [
              {
                seal: compositeSealWords,
                journalDigest: [1, 2, 3],
              },
            ],
          },
        },
        journal: { bytes: compositeJournalBytes },
      };

      const compositeExecutor: ZkVMExecutor = {
        type: 'real',
        version: '1.0',
        execute: vi.fn().mockResolvedValue(
          createMockExecutionResult({
            verifiedTally: [1, 2, 3, 4, 54],
            bulletinRoot: '0x' + '7'.repeat(64),
            seenBitmapRoot: '0x' + 'c'.repeat(64),
            includedBitmapRoot: '0x' + '8'.repeat(64),
            inputCommitment: '0x' + '9'.repeat(64),
            electionId: '550e8400-e29b-41d4-a716-446655440000',
            electionConfigHash: '0x' + 'a'.repeat(64),
            sthDigest: '0x' + 'b'.repeat(64),
            imageId,
            receipt: {
              imageId,
              payload: compositePayload,
              raw: {
                receipt: compositePayload,
                image_id: imageId,
              },
            },
          }),
        ),
      };
      vi.mocked(getDefaultExecutor).mockResolvedValue(compositeExecutor);

      const mockSessionId = 'test-session-composite';
      const baseSession = createBaseSession({
        sessionId: mockSessionId,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        logId: '0x' + '0'.repeat(64),
        userVoteIndex: 0,
        botCount: 63,
        votes: new Map(),
        finalized: false,
      });

      for (let i = 0; i < 64; i++) {
        baseSession.votes.set(
          i,
          createVoteData({
            vote: 'A',
            commit: '0x' + (i + 10).toString(16).padStart(64, '0'),
            rand: '0x' + (i + 20).toString(16).padStart(64, '0'),
            path: [],
            timestamp: Date.now(),
          }),
        );
      }

      const mockSession = withBulletin(baseSession);

      getSessionMock.mockResolvedValue(mockSession);

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      const response = await POST(request);
      const responsePayload = await readJson(response, 'Finalize');
      const responseBody = ensureRecord(responsePayload, 'Finalize response');
      const data = ensureRecord(responseBody.data, 'Finalize response data');

      // Composite receipts should be accepted and processed correctly
      expect(response.status).toBe(200);
      expect(data).toBeDefined();
      expect(data.receipt).toBeDefined();
      const responseReceipt = ensureRecord(data.receipt, 'response receipt');
      expect(ensureString(responseReceipt.seal, 'response receipt.seal')).toBeDefined();
      expect(ensureString(responseReceipt.journal, 'response receipt.journal')).toBeDefined();
      expect(ensureString(responseReceipt.imageId, 'response receipt.imageId')).toBe(imageId);
      const responseJournal = ensureRecord(data.journal, 'response journal');
      expect(getStringProperty(responseJournal, 'bulletinRoot')).toBe(getStringProperty(data, 'bulletinRoot'));
      expect(getStringProperty(responseJournal, 'inputCommitment')).toBe(getStringProperty(data, 'inputCommitment'));
      expect(data.excludedSlots).toBe(0);
      expect(data).not.toHaveProperty('excludedCount');
      expect(data.seenIndicesCount).toBe(64);

      expect(finalizeSessionMock).toHaveBeenCalled();
      const finalizeCall = finalizeSessionMock.mock.calls[0] ?? [];
      expect(finalizeCall[0]).toBe(mockSessionId);
      expect(finalizeCall[2]).toBe(resolveCurrentContractGeneration());
      const finalizePayload = ensureRecord(finalizeCall[1], 'finalize payload');
      const receiptPayload = ensureRecord(finalizePayload.receipt, 'finalize receipt');
      expect(ensureString(receiptPayload.seal, 'finalize receipt.seal')).toBeDefined();
      expect(ensureString(receiptPayload.journal, 'finalize receipt.journal')).toBeDefined();
      expect(ensureString(receiptPayload.imageId, 'finalize receipt.imageId')).toBe(imageId);
    });

    describe('S3 integration', () => {
      const buildReadySession = (sessionId: string): SessionData => {
        const baseSession = createBaseSession({
          sessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          logId: '0x' + '0'.repeat(64),
          userVoteIndex: 0,
          botCount: 63,
          finalized: false,
          votes: new Map(),
        });

        for (let i = 0; i < 64; i++) {
          const choice = VOTE_CHOICES[i % VOTE_CHOICES.length];
          baseSession.votes.set(
            i,
            createVoteData({
              vote: choice,
              commit: '0x' + (i + 10).toString(16).padStart(64, '0'),
              rand: '0x' + (i + 20).toString(16).padStart(64, '0'),
              path: [],
              timestamp: Date.now(),
            }),
          );
        }

        baseSession.votes.set(
          0,
          createVoteData({
            vote: 'A',
            commit: '0x' + 'a'.repeat(64),
            rand: '0x' + '1'.repeat(64),
            path: [],
            timestamp: Date.now(),
          }),
        );

        return withBulletin(baseSession);
      };

      it('stores S3 bundle metadata without exposing it in the public response', async () => {
        const mockSessionId = 's3-success-session';
        const mockSession = buildReadySession(mockSessionId);
        getSessionMock.mockResolvedValue(mockSession);

        const s3Meta = {
          s3BundleUrl: 'https://example.com/bundle.zip',
          s3BundleKey: 'sessions/s3-success-session/exec-123/bundle.zip',
          s3UploadedAt: '2025-10-19T05:30:00Z',
        };
        vi.mocked(uploadVerificationBundleToS3).mockResolvedValueOnce(s3Meta);

        const request = new NextRequest('http://localhost:3000/api/finalize', {
          method: 'POST',
          headers: {
            'X-Session-ID': mockSessionId,
            [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scenarioId: 'S0' }),
        });

        const response = await POST(request);
        const body = await readJsonRecord(response, 'finalize async response');
        const data = ensureRecord(body.data, 'finalize async response data');

        expect(response.status).toBe(200);
        expect(data).not.toHaveProperty('s3BundleUrl');
        expect(data).not.toHaveProperty('s3BundleKey');
        expect(data).not.toHaveProperty('s3UploadedAt');
        expect(data).not.toHaveProperty('s3BundleExpiresAt');
        expect(data.verificationExecutionId).toBe('exec-123');

        expect(finalizeSessionMock).toHaveBeenCalled();
        const finalizeCall = finalizeSessionMock.mock.calls[0] ?? [];
        expect(finalizeCall[0]).toBe(mockSessionId);
        expect(finalizeCall[2]).toBe(resolveCurrentContractGeneration());
        const finalizePayload = ensureRecord(finalizeCall[1], 'finalize payload');
        expect(finalizePayload).not.toHaveProperty('s3BundleUrl');
        expect(finalizePayload).not.toHaveProperty('s3BundleExpiresAt');
        expect(getStringProperty(finalizePayload, 's3BundleKey')).toBe(s3Meta.s3BundleKey);
        expect(getStringProperty(finalizePayload, 's3UploadedAt')).toBe(s3Meta.s3UploadedAt);
        expect(finalizePayload.receipt).toBeUndefined();
        const journalPayload = ensureRecord(finalizePayload.journal, 'finalize journal');
        expect(getStringProperty(journalPayload, 'bulletinRoot')).toBe('0x' + '1'.repeat(64));
        expect(getStringProperty(journalPayload, 'inputCommitment')).toBe('0x' + '3'.repeat(64));
      });

      it('falls back to local artifacts when S3 upload fails', async () => {
        const mockSessionId = 's3-failure-session';
        const mockSession = buildReadySession(mockSessionId);
        getSessionMock.mockResolvedValue(mockSession);

        vi.mocked(uploadVerificationBundleToS3).mockResolvedValueOnce({});

        const request = new NextRequest('http://localhost:3000/api/finalize', {
          method: 'POST',
          headers: {
            'X-Session-ID': mockSessionId,
            [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scenarioId: 'S0' }),
        });

        const response = await POST(request);
        const body = await readJsonRecord(response, 'finalize async response');
        const data = ensureRecord(body.data, 'finalize async response data');

        expect(response.status).toBe(200);
        expect(data.s3BundleUrl).toBeUndefined();
        expect(data.s3BundleKey).toBeUndefined();
        expect(data.s3UploadedAt).toBeUndefined();
        expect(data.receipt).toBeDefined();

        expect(finalizeSessionMock).toHaveBeenCalled();
        const finalizeCall = finalizeSessionMock.mock.calls[0] ?? [];
        expect(finalizeCall[0]).toBe(mockSessionId);
        expect(finalizeCall[2]).toBe(resolveCurrentContractGeneration());
        const finalizePayload = ensureRecord(finalizeCall[1], 'finalize payload');
        expect(finalizePayload.s3BundleUrl).toBeUndefined();
        const receiptPayload = ensureRecord(finalizePayload.receipt, 'finalize receipt');
        expect(ensureString(receiptPayload.seal, 'finalize receipt.seal')).toBeDefined();
        expect(ensureString(receiptPayload.journal, 'finalize receipt.journal')).toBeDefined();
        expect(ensureString(receiptPayload.imageId, 'finalize receipt.imageId')).toBe(imageId);
        const journalPayload = ensureRecord(finalizePayload.journal, 'finalize journal');
        expect(journalPayload).toBeDefined();
      });
    });

    it('should fail when session is not found', async () => {
      // Arrange
      const mockSessionId = 'non-existent-session';
      getSessionMock.mockResolvedValue(null);

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      // Act
      const response = await POST(request);
      const responsePayload = await readJson(response, 'Finalize');
      const responseBody = ensureRecord(responsePayload, 'Finalize response');
      const errorMessage = ensureString(responseBody.error, 'error');

      // Assert
      expect(response.status).toBe(404);
      expect(errorMessage).toBeDefined();
    });
  });

  describe('ImageID Verification', () => {
    it('should reject receipt with invalid ImageID', async () => {
      // Arrange
      const mockSessionId = 'test-session-id';
      const votes = new Map<number, VoteData>();
      votes.set(
        0,
        createVoteData({
          vote: 'A',
          commit: '0x' + 'a'.repeat(64),
          rand: '0x' + 'b'.repeat(64),
          path: [],
          timestamp: Date.now(),
        }),
      );
      for (let i = 0; i < 63; i++) {
        votes.set(
          i + 1,
          createVoteData({
            vote: 'B',
            commit: '0x' + 'a'.repeat(64),
            rand: '0x' + 'b'.repeat(64),
            path: [],
            timestamp: Date.now(),
          }),
        );
      }
      const mockSession: SessionData = withBulletin(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          logId: '0x' + '0'.repeat(64),
          userVoteIndex: 0,
          botCount: 63,
          finalized: false,
          votes,
        }),
      );

      getSessionMock.mockResolvedValue(mockSession);

      // Override the default mock to return invalid ImageID for this test
      const invalidImageExecutor: ZkVMExecutor = {
        type: 'mock',
        version: '1.0',
        execute: vi.fn().mockResolvedValue(
          createMockExecutionResult({
            imageId: '0x0000000000000000000000000000000000000000000000000000000000000000',
          }),
        ),
      };
      vi.mocked(getDefaultExecutor).mockResolvedValue(invalidImageExecutor);

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      // Act

      const response = await POST(request);
      const responsePayload = await readJson(response, 'Finalize');
      const responseBody = ensureRecord(responsePayload, 'Finalize response');
      const errorMessage = ensureString(responseBody.error, 'error');
      const details = ensureRecord(responseBody.details, 'error details');

      // Assert
      expect(response.status).toBe(400);
      expect(errorMessage).toContain('Invalid ImageID');
      expect(details).toEqual({
        expected: DEFAULT_POC_IMAGE_ID,
        actual: '0x0000000000000000000000000000000000000000000000000000000000000000',
      });
    });

    it('should accept valid production receipts', async () => {
      // Arrange
      const mockSessionId = 'test-session-id';
      const votes = new Map<number, VoteData>();
      votes.set(
        0,
        createVoteData({
          vote: 'A',
          commit: '0x' + 'a'.repeat(64),
          rand: '0x' + 'b'.repeat(64),
          path: [],
          timestamp: Date.now(),
        }),
      );
      for (let i = 0; i < 63; i++) {
        votes.set(
          i + 1,
          createVoteData({
            vote: 'B',
            commit: '0x' + 'a'.repeat(64),
            rand: '0x' + 'b'.repeat(64),
            path: [],
            timestamp: Date.now(),
          }),
        );
      }
      const mockSession: SessionData = withBulletin(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          logId: '0x' + '0'.repeat(64),
          userVoteIndex: 0,
          botCount: 63,
          finalized: false,
          votes,
        }),
      );

      getSessionMock.mockResolvedValue(mockSession);

      // Use default mock (valid production receipt) - no override needed
      // The beforeEach setup already provides a valid imageId and no dev mode seal

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      // Act
      const response = await POST(request);
      const responseBody = await readJsonRecord(response, 'finalize response');
      const responseData = ensureRecord(responseBody.data, 'finalize response data');

      // Assert
      expect(response.status).toBe(200);
      expect(responseData).toBeDefined();
      expect(responseBody.error).toBeUndefined();
    });
  });

  it('falls back to default ImageID when EXPECTED_IMAGE_ID is unset', async () => {
    delete process.env.EXPECTED_IMAGE_ID;

    const mockSessionId = 'fallback-session';
    const votes = new Map<number, VoteData>([
      [
        0,
        createVoteData({
          vote: 'A',
          commit: '0x' + '1'.repeat(64),
          rand: '0x' + '2'.repeat(64),
          path: [],
          timestamp: Date.now(),
        }),
      ],
    ]);
    const mockSession: SessionData = withBulletin(
      createBaseSession({
        sessionId: mockSessionId,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        logId: '0x' + '0'.repeat(64),
        userVoteIndex: 0,
        botCount: 63,
        finalized: false,
        votes,
      }),
    );

    getSessionMock.mockResolvedValue(mockSession);

    const request = new NextRequest('http://localhost:3000/api/finalize', {
      method: 'POST',
      headers: {
        'X-Session-ID': mockSessionId,
        [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenarioId: 'S0' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const responseBody = await readJsonRecord(response, 'finalize response');
    const responseData = ensureRecord(responseBody.data, 'finalize response data');
    expect(ensureString(responseData.imageId, 'finalize response imageId')).toBe(DEFAULT_POC_IMAGE_ID);
  });

  describe('Error handling', () => {
    it('should return error when session ID header is missing', async () => {
      // Arrange
      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      // Act
      const response = await POST(request);
      const data = await readJsonRecord(response, 'finalize response');

      // Assert
      expect(response.status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('should pass correct zkVM input structure to executor', async () => {
      const mockSessionId = 'test-session-input';
      const electionId = '550e8400-e29b-41d4-a716-446655440000';
      const logId = '0x' + '0'.repeat(64);
      const mockSession: SessionData = createBaseSession({
        sessionId: mockSessionId,
        electionId,
        logId,
        userVoteIndex: 0,
        botCount: BOT_COUNT,
        finalized: false,
      });

      for (let i = 0; i < BOT_COUNT + 1; i++) {
        mockSession.votes.set(
          i,
          createVoteData({
            vote: 'A',
            commit: '0x' + '9'.repeat(64),
            rand: '0x' + (i + 1).toString(16).padStart(64, '0'),
            path: [],
          }),
        );
      }

      withBulletin(mockSession);
      getSessionMock.mockResolvedValue(mockSession);

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(executor.execute).toHaveBeenCalledTimes(1);

      const [zkvmInput] = vi.mocked(executor.execute).mock.calls[0];
      expect(zkvmInput.electionId).toBe(electionId);
      expect(zkvmInput.totalExpected).toBe(BOT_COUNT + 1);
      expect(zkvmInput.votes).toHaveLength(BOT_COUNT + 1);

      const firstVote = mockSession.votes.get(0);
      if (!firstVote) {
        throw new Error('Missing vote data');
      }
      const expectedCommitment = computeCommitment(electionId, 0, firstVote.rand);
      expect(zkvmInput.votes[0].commitment).toBe(expectedCommitment);
      expect(zkvmInput.votes[0].choice).toBe(0);
      expect(zkvmInput.votes[0].random).toBe(firstVote.rand.toLowerCase());
    });

    it('should handle large sessions correctly', async () => {
      // Arrange
      const mockSessionId = 'test-session-large';
      const mockSession: SessionData = createBaseSession({
        sessionId: mockSessionId,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        logId: '0x' + '0'.repeat(64),
        votes: new Map(),
        userVoteIndex: 0,
        botCount: 63,
        finalized: false,
        bulletinRootHistory: [{ root: '0x' + 'e'.repeat(64), timestamp: Date.now(), treeSize: 64 }],
      });

      // Add all 64 votes (1 user + 63 bots)
      for (let i = 0; i < 64; i++) {
        mockSession.votes.set(
          i,
          createVoteData({
            vote: VOTE_CHOICES[i % VOTE_CHOICES.length],
            commit: '0x' + (i + 100).toString(16).padStart(64, '0'),
            rand: '0x' + (i + 200).toString(16).padStart(64, '0'),
            path: [],
          }),
        );
      }

      withBulletin(mockSession);

      getSessionMock.mockResolvedValue(mockSession);

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      // Act
      const response = await POST(request);
      const responsePayload = await readJson(response, 'Finalize');
      const responseBody = ensureRecord(responsePayload, 'Finalize response');
      const data = ensureRecord(responseBody.data, 'Finalize response data');
      const tally = ensureRecord(data.tally, 'Finalize tally');
      const counts = ensureRecord(tally.counts, 'Finalize tally counts');

      // Assert
      expect(response.status).toBe(200);
      expect(data).toBeDefined();
      expect(data.tally).toBeDefined();
      expect(Object.keys(counts)).toHaveLength(5);

      expect(Array.isArray(data.verifiedTally)).toBe(true);

      // Verify that all 64 votes are accounted for
      const countValues = Object.values(counts);
      if (!countValues.every((value) => typeof value === 'number')) {
        throw new Error('Finalize tally counts must be numbers');
      }
      const totalCount = countValues.reduce((sum, count) => sum + count, 0);
      expect(totalCount).toBe(64);
    });
  });

  describe('Verifier service failure handling', () => {
    it('returns error when verifier-service reports failure', async () => {
      const mockSessionId = 'failed-session';
      const mockSession: SessionData = withBulletin(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          logId: '0x' + '0'.repeat(64),
          votes: new Map([
            [0, createVoteData({ vote: 'A', commit: '0x' + 'a'.repeat(64), rand: '0x' + '1'.repeat(64) })],
          ]),
          userVoteIndex: 0,
          botCount: 63,
          finalized: false,
        }),
      );

      getSessionMock.mockResolvedValue(mockSession);

      vi.mocked(invokeVerifierService).mockResolvedValue({
        status: 'failed',
        reportPath: '/tmp/bundle/verification.json',
        bundlePath: '/tmp/bundle',
        report: {
          status: 'failed',
          verifier_version: '0.1.0',
          verified_at: '2025-10-16T00:00:00Z',
          duration_ms: 10,
          expected_image_id: imageId,
          receipt_image_id: null,
          bundle_path: '/tmp/bundle',
          receipt_path: '/tmp/bundle/receipt.json',
          dev_mode_receipt: false,
          errors: ['ImageID mismatch'],
        },
      });

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      const response = await POST(request);
      const data = await readJsonRecord(response, 'finalize response');

      expect(response.status).toBe(400);
      expect(data.error).toBe(ErrorCode.VERIFICATION_FAILED);
      expect(data.status).toBe('failed');
      expect(data.verificationExecutionId).toBe('exec-123');
      expect(data.bundleUrl).toBeUndefined();
      expect(data.reportUrl).toBeUndefined();
      const verificationReport = ensureRecord(data.verificationReport, 'verificationReport');
      expect(verificationReport.status).toBe('failed');
      expect(verificationReport.bundle_path).toBeUndefined();
      expect(verificationReport.receipt_path).toBeUndefined();
    });

    it('returns error when verifier-service reports dev_mode', async () => {
      const mockSessionId = 'dev-mode-session';
      const mockSession: SessionData = withBulletin(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          logId: '0x' + '0'.repeat(64),
          votes: new Map([
            [0, createVoteData({ vote: 'A', commit: '0x' + 'a'.repeat(64), rand: '0x' + '1'.repeat(64) })],
          ]),
          userVoteIndex: 0,
          botCount: 63,
          finalized: false,
        }),
      );

      getSessionMock.mockResolvedValue(mockSession);

      vi.mocked(invokeVerifierService).mockResolvedValue({
        status: 'dev_mode',
        reportPath: '/tmp/bundle/verification.json',
        bundlePath: '/tmp/bundle',
        report: {
          status: 'dev_mode',
          verifier_version: '0.1.0',
          verified_at: '2025-10-16T00:00:00Z',
          duration_ms: 10,
          expected_image_id: imageId,
          receipt_image_id: imageId,
          bundle_path: '/tmp/bundle',
          receipt_path: '/tmp/bundle/receipt.json',
          dev_mode_receipt: true,
          errors: [],
        },
      });

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      const response = await POST(request);
      const data = await readJsonRecord(response, 'finalize response');

      expect(response.status).toBe(400);
      expect(data.error).toBe(ErrorCode.VERIFICATION_FAILED);
      expect(data.status).toBe('dev_mode');
      expect(data.verificationExecutionId).toBe('exec-123');
      const verificationReport = ensureRecord(data.verificationReport, 'verificationReport');
      expect(verificationReport.status).toBe('dev_mode');
      expect(verificationReport.bundle_path).toBeUndefined();
      expect(verificationReport.receipt_path).toBeUndefined();
    });

    it('allows dev-mode receipts without seal when RISC0_DEV_MODE=1', async () => {
      process.env.RISC0_DEV_MODE = '1';

      const mockSessionId = 'dev-mode-allowed';
      const mockSession: SessionData = withBulletin(
        createBaseSession({
          sessionId: mockSessionId,
          electionId: '550e8400-e29b-41d4-a716-446655440000',
          logId: '0x' + '0'.repeat(64),
          votes: new Map([
            [0, createVoteData({ vote: 'A', commit: '0x' + 'a'.repeat(64), rand: '0x' + '1'.repeat(64) })],
          ]),
          userVoteIndex: 0,
          botCount: 63,
          finalized: false,
        }),
      );

      getSessionMock.mockResolvedValue(mockSession);

      const devModeExecutor: ZkVMExecutor = {
        type: 'real',
        version: '1.0',
        execute: vi.fn().mockResolvedValue(
          createMockExecutionResult({
            receipt: {
              imageId,
              payload: fakeReceiptPayload,
              raw: {
                receipt: fakeReceiptPayload,
                image_id: imageId,
              },
            },
          }),
        ),
      };
      vi.mocked(getDefaultExecutor).mockResolvedValueOnce(devModeExecutor);

      vi.mocked(invokeVerifierService).mockResolvedValueOnce({
        status: 'dev_mode',
        reportPath: '/tmp/bundle/verification.json',
        bundlePath: '/tmp/bundle',
        report: {
          status: 'dev_mode',
          verifier_version: '0.1.0',
          verified_at: '2025-10-16T00:00:00Z',
          duration_ms: 10,
          expected_image_id: imageId,
          receipt_image_id: imageId,
          bundle_path: '/tmp/bundle',
          receipt_path: '/tmp/bundle/receipt.json',
          dev_mode_receipt: true,
          errors: [],
        },
      });

      const request = new NextRequest('http://localhost:3000/api/finalize', {
        method: 'POST',
        headers: {
          'X-Session-ID': mockSessionId,
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken(mockSessionId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scenarioId: 'S0' }),
      });

      const response = await POST(request);
      const responseBody = await readJsonRecord(response, 'finalize response');
      const responseData = ensureRecord(responseBody.data, 'finalize response data');

      expect(response.status).toBe(200);
      expect(responseData.verificationStatus).toBe('dev_mode');
      const receipt = ensureRecord(responseData.receipt, 'finalize receipt');
      const metadata = ensureRecord(getRecordProperty(receipt, 'metadata'), 'finalize receipt metadata');
      expect(metadata.isFake).toBe(true);
      const seal = ensureString(getStringProperty(receipt, 'seal'), 'finalize receipt seal');
      expect(seal.length).toBeGreaterThan(0);
    });
  });
});

function withBulletin(session: SessionData): SessionData {
  const board = new SimpleBulletinBoard(session.logId ?? '0x' + '0'.repeat(64));
  const seen = new Set<string>();

  for (const [index, vote] of session.votes.entries()) {
    const assignedId = vote.voteId && typeof vote.voteId === 'string' ? vote.voteId : deterministicVoteId(index);
    vote.voteId = assignedId;

    let normalizedCommitment = normalizeCommitment(vote.commit);
    while (seen.has(normalizedCommitment)) {
      normalizedCommitment = incrementHex(normalizedCommitment);
    }
    seen.add(normalizedCommitment);

    vote.commit = addHexPrefix(normalizedCommitment);
    const appendResult = board.appendVote(assignedId, normalizedCommitment);
    vote.rootAtCast = addHexPrefix(appendResult.rootAtAppend);
  }

  session.bulletin = board;
  session.bulletinRootHistory = [
    {
      root: addHexPrefix(board.getCurrentRoot()),
      timestamp: Date.now(),
      treeSize: board.getSize(),
    },
  ];

  return session;
}

function normalizeCommitment(commitment: string): string {
  if (!commitment) {
    return '0'.repeat(64);
  }
  const normalized = commitment.startsWith('0x') ? commitment.slice(2) : commitment;
  return normalized.length > 0 ? normalized : '0'.repeat(64);
}

function deterministicVoteId(index: number): string {
  const suffix = (index + 1).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${suffix}`;
}

function incrementHex(hex: string): string {
  const value = BigInt('0x' + hex) + 1n;
  return value.toString(16).padStart(hex.length, '0');
}

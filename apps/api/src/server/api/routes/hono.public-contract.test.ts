import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHonoApp as createConfiguredHonoApp, type HonoAppOptions } from './hono';
import { getGlobalStore } from '@stark-ballot/aws-adapters/store/storeInstance';
import { createMockVoteStore, type MockVoteStore } from '../../__tests__/support/mockVoteStore';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import type {
  FinalizationResultAuthority,
  FinalizationScenarioContext,
  FinalizationState,
} from '@stark-ballot/application/finalize/finalization-types';
import type { VerificationResultRecord } from '@stark-ballot/application/finalize/finalization-result-store';
import type { ArtifactReader } from '@stark-ballot/application/verification/artifact-reader';
import type { AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { createTestPublicInputArtifact } from '@stark-ballot/test-support/testing/public-input-artifact';
import { createSessionCapabilityToken } from '@stark-ballot/domain/security/sessionCapabilityToken';
import { SESSION_CAPABILITY_HEADER } from '@stark-ballot/domain/session/capability';
import type {
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
} from '@stark-ballot/domain/types/sessionRecords';
import {
  resolveVerificationObservationRecord,
  type VerificationObservation,
} from '@stark-ballot/domain/types/verificationObservation';
import {
  getApiErrorCode,
  readJsonRecord,
  requireDataRecord,
} from '@stark-ballot/test-support/testing/response-helpers';
import {
  getArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
} from '@stark-ballot/validation/unknown-value-guards';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { computeInputCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { buildDefaultElectionConfig, hashElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { buildCanonicalZkVMInputFromSession } from '@stark-ballot/application/zkvm-input/private-input-contract';
import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import { localRuntimeProfile } from '@stark-ballot/runtime-config/env/__tests__/runtimeProfileFixtures';
import { resolveConsistencyProofData } from '../handlers/bulletin';

vi.mock('@stark-ballot/aws-adapters/store/storeInstance', () => ({
  getGlobalStore: vi.fn(),
}));

const capabilitySecret = 'mounted-hono-public-contract-secret-0123456789abcdef';
const sessionId = 'session-mounted-1';
const finalizationId = 'execution-mounted-1';
const bundleKey = `sessions/${sessionId}/${finalizationId}/bundle.zip`;
const reportKey = `sessions/${sessionId}/${finalizationId}/verification.json`;
const runtimeProfile = localRuntimeProfile('static-mock-e2e');
const artifactRead = vi.fn<ArtifactReader['read']>();
const artifactReader: ArtifactReader = { read: artifactRead };

function createHonoApp(options: HonoAppOptions = {}) {
  return createConfiguredHonoApp({
    basePath: '/api',
    mode: 'lambda',
    runtimeProfile,
    artifactDeliveryDependencyOverrides: { artifactReader },
    ...options,
  });
}

function buildFinalizationResult(): FinalizationResultAuthority {
  const oneBitBitmapRoot = computeIncludedBitmapRoot([true]);
  const journal = {
    ...createTestJournal({
      validVotes: 1,
      totalExpected: 1,
      seenIndicesCount: 1,
    }),
    verifiedTally: [1, 0, 0, 0, 0],
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
      finalizationId,
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
    bitmapProofSource: 'real',
  };
}

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

type SucceededFinalizationState = Extract<FinalizationState, { status: 'succeeded' }>;

interface MountedSessionRecords {
  identity: SessionIdentityRecord;
  voting: SessionVotingRecord;
  finalization: FinalizationRecord;
  verification: VerificationResultRecord | null;
  deliveryMetadata: AwsVerificationDeliveryMetadataInput | undefined;
}

interface MountedSessionRecordOverrides {
  identity?: Partial<SessionIdentityRecord>;
  voting?: Partial<SessionVotingRecord>;
  finalizationResult?: FinalizationResultAuthority;
  finalizationState?: SucceededFinalizationState;
  scenarioContext?: FinalizationScenarioContext;
  verificationResult?: VerificationResult | null;
  deliveryMetadata?: AwsVerificationDeliveryMetadataInput;
}

function buildFinalizedRecords(overrides: MountedSessionRecordOverrides = {}): MountedSessionRecords {
  const now = Date.now();
  const authority = overrides.finalizationResult ?? buildFinalizationResult();
  const identity: SessionIdentityRecord = {
    sessionId,
    electionId: authority.journal.electionId,
    electionConfigHash: authority.journal.electionConfigHash,
    electionConfig: {
      totalExpected: authority.journal.totalExpected,
      choices: ['A', 'B', 'C', 'D', 'E'],
      version: 'test-v1',
      botCount: Math.max(0, authority.journal.totalExpected - 1),
      merkleTreeDepth: Math.max(1, Math.ceil(Math.log2(Math.max(2, authority.journal.totalExpected)))),
    },
    logId: `0x${'56'.repeat(32)}`,
    createdAtMs: now,
    ...overrides.identity,
  };
  const voting: SessionVotingRecord = {
    sessionId: identity.sessionId,
    votes: new Map(),
    bulletin: new SimpleBulletinBoard(identity.logId),
    bulletinRootHistory: [],
    botCount: 0,
    userParticipation: { status: 'cast', voteIndex: 0 },
    lastActivityMs: now,
    ...overrides.voting,
  };
  const state: SucceededFinalizationState = overrides.finalizationState ?? {
    status: 'succeeded',
    finalizationId,
    queuedAtMs: now - 2_000,
    startedAtMs: now - 1_000,
    completedAtMs: now,
  };
  const finalization: FinalizationRecord = {
    sessionId: identity.sessionId,
    finalizationId,
    scenarioContext: overrides.scenarioContext ?? scenarioContext,
    state,
    finalizationResult: {
      finalizationId,
      ...authority,
    },
  };
  const verificationResult =
    overrides.verificationResult === undefined ? { status: 'success' as const } : overrides.verificationResult;

  return {
    identity,
    voting,
    finalization,
    verification:
      verificationResult === null
        ? null
        : {
            sessionId: identity.sessionId,
            finalizationId,
            verificationResult,
          },
    deliveryMetadata: overrides.deliveryMetadata ?? {
      s3BundleKey: bundleKey,
      s3ReportKey: reportKey,
    },
  };
}

function buildCanonicalEvidenceRecords(): MountedSessionRecords {
  const voteId = '550e8400-e29b-41d4-a716-446655440000';
  const vote: StoredVoteRecord = {
    voteId,
    vote: 'A' as const,
    rand: `0x${'01'.repeat(32)}`,
    commit: `0x${'34'.repeat(32)}`,
    timestamp: 1_750_000_000_000,
    rootAtCast: '',
  };
  const logId = `0x${'56'.repeat(32)}`;
  const bulletin = new SimpleBulletinBoard(logId);
  const append = bulletin.appendVote(voteId, vote.commit.slice(2));
  vote.rootAtCast = append.rootAtAppend;
  const electionConfig = buildDefaultElectionConfig();

  return buildFinalizedRecords({
    identity: {
      electionId: '550e8400-e29b-41d4-a716-446655440001',
      electionConfig,
      electionConfigHash: hashElectionConfig(electionConfig),
      logId,
    },
    voting: {
      votes: new Map([[0, vote]]),
      bulletin,
      bulletinRootHistory: [
        {
          timestamp: vote.timestamp,
          root: append.rootAtAppend,
          treeSize: 1,
        },
      ],
      userParticipation: { status: 'cast', voteIndex: 0 },
    },
  });
}

function createStoreWithRecords(
  records: MountedSessionRecords = buildFinalizedRecords(),
  overrides: Partial<MockVoteStore> = {},
): MockVoteStore {
  let observation: VerificationObservation | undefined;
  return createMockVoteStore({
    getSessionIdentity: (requestedSessionId) =>
      Promise.resolve(requestedSessionId === records.identity.sessionId ? records.identity : null),
    getVotingRecord: (requestedSessionId) =>
      Promise.resolve(requestedSessionId === records.identity.sessionId ? records.voting : null),
    getCurrentFinalizationRecord: (requestedSessionId) =>
      Promise.resolve(requestedSessionId === records.identity.sessionId ? records.finalization : null),
    getFinalizationRecord: (requestedSessionId, requestedFinalizationId) =>
      Promise.resolve(
        requestedSessionId === records.identity.sessionId &&
          requestedFinalizationId === records.finalization.finalizationId
          ? records.finalization
          : null,
      ),
    getVerificationResultRecord: (requestedSessionId, requestedFinalizationId) =>
      Promise.resolve(
        requestedSessionId === records.identity.sessionId && requestedFinalizationId === finalizationId
          ? records.verification
          : null,
      ),
    getAwsVerificationDeliveryMetadata: (requestedSessionId, requestedFinalizationId) =>
      Promise.resolve(
        requestedSessionId === records.identity.sessionId && requestedFinalizationId === finalizationId
          ? records.deliveryMetadata
          : undefined,
      ),
    recordVerificationObservation: (requestedSessionId, requestedFinalizationId, write) => {
      if (requestedSessionId !== records.identity.sessionId) {
        return Promise.resolve({ status: 'conflict', reason: 'finalization_mismatch' });
      }
      const requested: VerificationObservation = {
        finalizationId: requestedFinalizationId,
        ...write,
      };
      const resolution = resolveVerificationObservationRecord(
        records.finalization.finalizationId,
        observation,
        requested,
      );
      if (resolution.status === 'recorded') {
        observation = requested;
      }
      return Promise.resolve(resolution);
    },
    ...overrides,
  });
}

function authHeaders(id = sessionId): Record<string, string> {
  return {
    [SESSION_CAPABILITY_HEADER]: createSessionCapabilityToken({ sessionId: id }, capabilitySecret),
  };
}

const expectedVerificationFailures = [
  { stage: 'recorded', checkId: 'recorded_commitment_in_bulletin' },
  { stage: 'recorded', checkId: 'recorded_root_at_cast_consistent' },
  { stage: 'recorded', checkId: 'recorded_inclusion_proof' },
  { stage: 'recorded', checkId: 'recorded_consistency_proof' },
  { stage: 'counted', checkId: 'counted_tally_consistent' },
] as const;

type ExpectedLoggerWarning =
  | { kind: 'http_request'; status: number }
  | { kind: 'verification_failed'; stage: string; checkId: string }
  | { kind: 'bundle_download_failed'; finalizationId: string };

function httpRequestWarning(status: number): ExpectedLoggerWarning {
  return { kind: 'http_request', status };
}

function verificationFailureWarnings(repetitions = 1, includeCountedTally = true): ExpectedLoggerWarning[] {
  const failures = includeCountedTally ? expectedVerificationFailures : expectedVerificationFailures.slice(0, -1);
  return Array.from({ length: repetitions }, () =>
    failures.map(({ stage, checkId }) => ({ kind: 'verification_failed' as const, stage, checkId })),
  ).flat();
}

function bundleDownloadWarning(requestedFinalizationId: string): ExpectedLoggerWarning {
  return { kind: 'bundle_download_failed', finalizationId: requestedFinalizationId };
}

function expectLoggerWarnings(
  spy: MockInstance<typeof logger.warn> | undefined,
  expected: readonly ExpectedLoggerWarning[],
): void {
  expect(spy?.mock.calls).toHaveLength(expected.length);
  for (const [index, warning] of expected.entries()) {
    const call = spy?.mock.calls[index];
    const fields = call?.[1];

    if (warning.kind === 'http_request') {
      expect(call?.[0]).toBe('request completed');
      expect(getStringProperty(fields, 'event')).toBe('http_request');
      expect(getNumberProperty(getRecordProperty(fields, 'http'), 'status')).toBe(warning.status);
      continue;
    }

    if (warning.kind === 'verification_failed') {
      const verification = getRecordProperty(fields, 'verification');
      expect(call?.[0]).toBe('verification check failed');
      expect(getStringProperty(fields, 'event')).toBe('verification_failed');
      expect(getStringProperty(verification, 'stage')).toBe(warning.stage);
      expect(getStringProperty(verification, 'check_id')).toBe(warning.checkId);
      expect(getStringProperty(verification, 'reason')).toBe('failed');
      continue;
    }

    expect(call?.[0]).toBe('bundle_download_failed');
    expect(getStringProperty(fields, 'event')).toBe('bundle_download_failed');
    expect(getStringProperty(fields, 'endpoint')).toBe('bundle');
    expect(getNumberProperty(fields, 'http_status')).toBe(404);
    expect(getStringProperty(fields, 's3_error_code')).toBe('no_such_key');
    expect(getStringProperty(fields, 'finalization_id')).toBe(warning.finalizationId);
  }
}

describe('mounted Hono public contract behavior', () => {
  let originalEnv: Record<string, string | undefined>;
  let loggerWarnSpy: MockInstance<typeof logger.warn> | undefined;
  let expectedLoggerWarnCalls: ExpectedLoggerWarning[] | undefined;

  function captureExpectedWarnings(calls: ExpectedLoggerWarning[]): void {
    expectedLoggerWarnCalls = calls;
    loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  }

  beforeEach(() => {
    originalEnv = {
      SESSION_CAPABILITY_SECRET: process.env['SESSION_CAPABILITY_SECRET'],
      VITE_STH_SOURCES: process.env['VITE_STH_SOURCES'],
      VITE_STH_MIN_MATCHES: process.env['VITE_STH_MIN_MATCHES'],
    };
    process.env['SESSION_CAPABILITY_SECRET'] = capabilitySecret;
    vi.clearAllMocks();
    artifactRead.mockResolvedValue({ kind: 'notFound' });
    loggerWarnSpy = undefined;
    expectedLoggerWarnCalls = undefined;
  });

  afterEach(() => {
    try {
      if (expectedLoggerWarnCalls) {
        expectLoggerWarnings(loggerWarnSpy, expectedLoggerWarnCalls);
      }
    } finally {
      try {
        vi.unstubAllGlobals();
        for (const [key, value] of Object.entries(originalEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      } finally {
        vi.restoreAllMocks();
      }
    }
  });

  it('preserves mounted auth failure, CORS, cache, binary range, and report behavior for bundle endpoints', async () => {
    captureExpectedWarnings([httpRequestWarning(401)]);
    const store = createStoreWithRecords();
    vi.mocked(getGlobalStore).mockReturnValue(store);
    artifactRead.mockImplementation((request) => {
      if (request.artifact === 'bundle') {
        return Promise.resolve({
          kind: 'range',
          bytes: Uint8Array.from([2, 3, 4]),
          totalBytes: 8,
          start: 1,
          end: 3,
          representation: {
            etag: '"bundle-etag"',
            versionId: 'bundle-version',
          },
        });
      }
      return Promise.resolve({
        kind: 'full',
        bytes: Uint8Array.from([123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125]),
        totalBytes: 11,
        representation: {
          etag: '"report-etag"',
          versionId: 'report-version',
        },
      });
    });

    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const artifactBase = `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/artifacts`;
    const preflight = await app.request(`${artifactBase}/bundle`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Session-Capability, Range',
      },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('range');

    const missingCapability = await app.request(`${artifactBase}/bundle`);
    const missingPayload = await readJsonRecord(missingCapability, 'missing capability');
    expect(missingCapability.status).toBe(401);
    expect(getApiErrorCode(missingPayload)).toBe('SESSION_CAPABILITY_REQUIRED');

    const rangedBundle = await app.request(`${artifactBase}/bundle`, {
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

    const report = await app.request(`${artifactBase}/report`, {
      headers: authHeaders(),
    });
    expect(report.status).toBe(200);
    expect(report.headers.get('Content-Type')).toBe('application/json');
    expect(report.headers.get('Cache-Control')).toBe('no-store');
    expect(await report.json()).toEqual({ ok: true });
  });

  it('fails closed for stale finalization IDs and delivery metadata without current authority before artifact reads', async () => {
    captureExpectedWarnings([
      bundleDownloadWarning('execution-stale'),
      httpRequestWarning(404),
      bundleDownloadWarning(finalizationId),
      httpRequestWarning(404),
    ]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(createStoreWithRecords());

    const stale = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/execution-stale/artifacts/bundle`,
      {
        headers: authHeaders(),
      },
    );
    expect(stale.status).toBe(404);
    expect(getApiErrorCode(await readJsonRecord(stale, 'stale execution'))).toBe('BUNDLE_NOT_FOUND');

    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(buildFinalizedRecords(), {
        getCurrentFinalizationRecord: () => Promise.resolve(null),
        getAwsVerificationDeliveryMetadata: () =>
          Promise.resolve({
            s3BundleKey: `archive/${sessionId}/${finalizationId}/bundle.zip`,
          }),
      }),
    );

    const metadataOnly = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/artifacts/bundle`,
      {
        headers: authHeaders(),
      },
    );
    expect(metadataOnly.status).toBe(404);
    expect(getApiErrorCode(await readJsonRecord(metadataOnly, 'metadata-only artifact'))).toBe('BUNDLE_NOT_FOUND');
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('preserves the mounted vote-proof code when exact CT evidence is unavailable', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
    const voteId = '550e8400-e29b-41d4-a716-446655440000';
    const vote: StoredVoteRecord = {
      voteId,
      vote: 'A' as const,
      rand: `0x${'01'.repeat(32)}`,
      commit: `0x${'34'.repeat(32)}`,
      timestamp: 1,
      rootAtCast: `0x${'0'.repeat(64)}`,
    };
    const records = buildFinalizedRecords({
      voting: {
        votes: new Map([[0, vote]]),
        userParticipation: { status: 'cast', voteIndex: 0 },
      },
    });
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getVoteByIdWithProof: () => Promise.reject(new Error('CT_PROOF_UNAVAILABLE')),
      }),
    );

    const response = await createHonoApp({ basePath: '/api', mode: 'lambda' }).request(
      `http://localhost/api/sessions/${sessionId}/votes/${voteId}/inclusion-proof`,
      { headers: authHeaders() },
    );
    const payload = await readJsonRecord(response, 'vote proof unavailable');

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(getApiErrorCode(payload)).toBe('VERIFICATION_FAILED');
    expect(payload).not.toHaveProperty('statusCode');
  });

  it('preserves exact inclusion evidence and capability-sensitive caching on the canonical route', async () => {
    const records = buildCanonicalEvidenceRecords();
    const vote = records.voting.votes.get(0);
    if (!vote?.voteId) {
      throw new Error('Expected canonical evidence vote');
    }
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getVoteByIdWithProof: () =>
          Promise.resolve({
            voteData: vote,
            leafIndex: 0,
            merklePath: [],
            bulletinRootAtCast: records.voting.bulletin.getCurrentRoot(),
            treeSize: 1,
          }),
      }),
    );

    const response = await createHonoApp({ basePath: '/api', mode: 'lambda' }).request(
      `http://localhost/api/sessions/${sessionId}/votes/${vote.voteId}/inclusion-proof`,
      { headers: authHeaders() },
    );
    const payload = await readJsonRecord(response, 'canonical inclusion proof');
    const data = requireDataRecord(payload, 'canonical inclusion proof data');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('X-Session-Capability, Origin');
    expect(data).toMatchObject({
      voteId: vote.voteId,
      proof: {
        leafIndex: 0,
        merklePath: [],
        treeSize: 1,
      },
    });
  });

  it('projects canonical bulletin pagination and consistency fields without changing Merkle evidence', async () => {
    const records = buildCanonicalEvidenceRecords();
    vi.mocked(getGlobalStore).mockReturnValue(createStoreWithRecords(records));
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const bulletin = await app.request(`http://localhost/api/sessions/${sessionId}/bulletin?offset=0&limit=1`, {
      headers: authHeaders(),
    });
    const bulletinPayload = await readJsonRecord(bulletin, 'canonical bulletin');
    const bulletinData = requireDataRecord(bulletinPayload, 'canonical bulletin data');

    expect(bulletin.status).toBe(200);
    expect(bulletinData).toMatchObject({
      commitments: [records.voting.votes.get(0)?.commit],
      treeSize: 1,
      rootHistory: [
        {
          recordedAtMs: 1_750_000_000_000,
          treeSize: 1,
        },
      ],
    });
    expect(bulletinData).not.toHaveProperty('timestamp');
    expect(bulletinData).not.toHaveProperty('nextOffset');
    expect(bulletinData).not.toHaveProperty('hasMore');
    expect(getRecordProperty(bulletinPayload, 'meta')).toMatchObject({
      page: {
        nextOffset: null,
        hasMore: false,
      },
    });

    const consistency = await app.request(
      `http://localhost/api/sessions/${sessionId}/bulletin/consistency-proof?fromTreeSize=0&toTreeSize=1`,
      { headers: authHeaders() },
    );
    const consistencyPayload = await readJsonRecord(consistency, 'canonical consistency proof');
    const consistencyData = requireDataRecord(consistencyPayload, 'canonical consistency proof data');

    expect(consistency.status).toBe(200);
    expect(consistencyData).toMatchObject({
      fromTreeSize: 0,
      toTreeSize: 1,
      rootAtToTreeSize: normalizeHex(records.voting.bulletin.getCurrentRoot(), { allowEmpty: true }),
      proofNodes: [],
    });
    expect(typeof bulletinData['generatedAtMs']).toBe('number');
    expect(typeof consistencyData['rootAtFromTreeSize']).toBe('string');
    expect(typeof consistencyData['generatedAtMs']).toBe('number');
    expect(consistencyData).not.toHaveProperty('oldSize');
    expect(consistencyData).not.toHaveProperty('newSize');
    expect(consistencyData).not.toHaveProperty('timestamp');
  });

  it('normalizes every consistency-proof hash array at the public projection boundary', () => {
    const session = buildCanonicalEvidenceRecords();
    const bulletin = session.voting.bulletin;
    const rawRoot = 'ab'.repeat(32);
    const rawProofNode = 'cd'.repeat(32);
    const rawOldSubtree = 'de'.repeat(32);
    const rawAppendSubtree = 'ef'.repeat(32);
    vi.spyOn(bulletin, 'getSize').mockReturnValue(2);
    vi.spyOn(bulletin, 'getRootAtSize').mockReturnValue(rawRoot);
    vi.spyOn(bulletin, 'getConsistencyProof').mockReturnValue({
      oldSize: 1,
      newSize: 2,
      proofNodes: [rawProofNode],
      oldSubtreeHashes: [rawOldSubtree],
      appendSubtreeHashes: [rawAppendSubtree],
    });

    const resolution = resolveConsistencyProofData({
      session: session.voting,
      fromTreeSize: 1,
      toTreeSize: 2,
      generatedAtMs: 1_750_000_000_000,
    });

    expect(resolution).toMatchObject({
      ok: true,
      data: {
        proofNodes: [`0x${rawProofNode}`],
        oldSubtreeHashes: [`0x${rawOldSubtree}`],
        appendSubtreeHashes: [`0x${rawAppendSubtree}`],
      },
    });
  });

  it('retains protocol STH timestamp and exact canonical input commitment bytes', async () => {
    const session = buildCanonicalEvidenceRecords();
    const expectedInputCommitment = computeInputCommitment(buildCanonicalZkVMInputFromSession(session));
    vi.mocked(getGlobalStore).mockReturnValue(createStoreWithRecords(session));
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });

    const sth = await app.request(`http://localhost/api/sessions/${sessionId}/bulletin/sth?auditorId=auditor-b`, {
      headers: authHeaders(),
    });
    const sthData = requireDataRecord(await readJsonRecord(sth, 'canonical STH'), 'canonical STH data');

    expect(sth.status).toBe(200);
    expect(getRecordProperty(sthData, 'sth')).toMatchObject({
      timestamp: session.voting.lastActivityMs,
      logId: session.identity.logId,
    });

    const inputCommitment = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/input-commitment`,
      { headers: authHeaders() },
    );
    const inputCommitmentData = requireDataRecord(
      await readJsonRecord(inputCommitment, 'canonical input commitment'),
      'canonical input commitment data',
    );

    expect(inputCommitment.status).toBe(200);
    expect(inputCommitmentData).toEqual({ inputCommitment: expectedInputCommitment });
  });

  it('preserves mounted current-finalization cache privacy and finalization projection behavior', async () => {
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(
        buildFinalizedRecords({
          finalizationState: {
            status: 'succeeded',
            finalizationId,
            queuedAtMs: 1,
            startedAtMs: 2,
            completedAtMs: 3,
          },
        }),
      ),
    );

    const status = await app.request(`http://localhost/api/sessions/${sessionId}/finalizations/current`, {
      headers: authHeaders(),
    });
    const payload = await readJsonRecord(status, 'current finalization');
    const data = requireDataRecord(payload, 'current finalization data');

    expect(status.status).toBe(200);
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect(getStringProperty(data, 'finalizationId')).toBe(finalizationId);
    expect(getStringProperty(data, 'status')).toBe('succeeded');
    expect(getRecordProperty(data, 'result')).not.toBeUndefined();
    expect(data).not.toHaveProperty('sessionId');
  });

  it('rejects missing exact current finalization without repairing from delivery metadata', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(buildFinalizedRecords(), {
        getCurrentFinalizationRecord: () => Promise.resolve(null),
        getAwsVerificationDeliveryMetadata: () =>
          Promise.resolve({
            s3BundleKey: bundleKey,
            s3ReportKey: reportKey,
          }),
      }),
    );

    const verify = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification`,
      {
        headers: authHeaders(),
      },
    );
    const payload = await readJsonRecord(verify, 'verify fail-closed response');

    expect(verify.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('SESSION_NOT_FINALIZED');
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('includes the exact current journal when requested on the canonical verification route', async () => {
    captureExpectedWarnings(verificationFailureWarnings(1, false));
    delete process.env['VITE_STH_SOURCES'];
    delete process.env['VITE_STH_MIN_MATCHES'];

    const currentFinalizationResult = buildFinalizationResult();
    const vote: StoredVoteRecord = {
      voteId: 'vote-mounted-journal',
      vote: 'A' as const,
      rand: `0x${'01'.repeat(32)}`,
      commit: `0x${'34'.repeat(32)}`,
      timestamp: 1,
      rootAtCast: currentFinalizationResult.journal.bulletinRoot,
    };
    const currentSession = buildFinalizedRecords({
      identity: {
        electionId: currentFinalizationResult.journal.electionId,
        electionConfigHash: currentFinalizationResult.journal.electionConfigHash,
        logId: `0x${'56'.repeat(32)}`,
      },
      voting: {
        votes: new Map([[0, vote]]),
        userParticipation: { status: 'cast', voteIndex: 0 },
      },
      finalizationResult: currentFinalizationResult,
    });
    const getBitmapData = vi.fn(() =>
      Promise.resolve({
        sessionId,
        finalizationId,
        includedBitmap: [true],
        includedBitmapRoot: computeIncludedBitmapRoot([true]),
        seenBitmap: [true],
        seenBitmapRoot: computeIncludedBitmapRoot([true]),
        treeSize: 1,
        finalizedAtMs: 1,
      }),
    );
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(currentSession, {
        getVoteByIdWithProof: () =>
          Promise.resolve({
            voteData: vote,
            leafIndex: 0,
            merklePath: [],
            bulletinRootAtCast: currentFinalizationResult.journal.bulletinRoot,
            treeSize: 1,
          }),
        getBitmapData,
      }),
    );

    const response = await createHonoApp({ basePath: '/api', mode: 'lambda' }).request(
      `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification?include=journal`,
      {
        headers: authHeaders(),
      },
    );
    const data = requireDataRecord(await readJsonRecord(response, 'verification with journal'));

    expect(response.status).toBe(200);
    expect(getStringProperty(data, 'availability')).toBe('available');
    expect(getBitmapData).toHaveBeenCalledTimes(2);
    expect(getRecordProperty(data, 'journal')).toEqual({
      representation: 'included',
      value: currentFinalizationResult.journal,
    });
  });

  it.each([
    {
      defect: 'root',
      bitmapData: {
        sessionId,
        finalizationId,
        includedBitmap: [true],
        includedBitmapRoot: computeIncludedBitmapRoot([false]),
        seenBitmap: [true],
        seenBitmapRoot: computeIncludedBitmapRoot([true]),
        treeSize: 1,
        finalizedAtMs: 1,
      },
    },
    {
      defect: 'tree size',
      bitmapData: {
        sessionId,
        finalizationId,
        includedBitmap: [true, true],
        includedBitmapRoot: computeIncludedBitmapRoot([true, true]),
        seenBitmap: [true, true],
        seenBitmapRoot: computeIncludedBitmapRoot([true, true]),
        treeSize: 2,
        finalizedAtMs: 1,
      },
    },
    {
      defect: 'bitmap length',
      bitmapData: {
        sessionId,
        finalizationId,
        includedBitmap: [true, true],
        includedBitmapRoot: computeIncludedBitmapRoot([true, true]),
        seenBitmap: [true],
        seenBitmapRoot: computeIncludedBitmapRoot([true]),
        treeSize: 1,
        finalizedAtMs: 1,
      },
    },
  ])('does not admit a persisted bitmap with mismatched $defect in verification', async ({ defect, bitmapData }) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    delete process.env['VITE_STH_SOURCES'];
    delete process.env['VITE_STH_MIN_MATCHES'];

    const finalizationResult = buildFinalizationResult();
    const vote: StoredVoteRecord = {
      voteId: 'vote-invalid-bitmap-evidence',
      vote: 'A',
      rand: `0x${'01'.repeat(32)}`,
      commit: `0x${'34'.repeat(32)}`,
      timestamp: 1,
      rootAtCast: finalizationResult.journal.bulletinRoot,
    };
    const records = buildFinalizedRecords({
      identity: {
        electionId: finalizationResult.journal.electionId,
        electionConfigHash: finalizationResult.journal.electionConfigHash,
      },
      voting: {
        votes: new Map([[0, vote]]),
        userParticipation: { status: 'cast', voteIndex: 0 },
      },
      finalizationResult,
    });
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getVoteByIdWithProof: () =>
          Promise.resolve({
            voteData: vote,
            leafIndex: 0,
            merklePath: [],
            bulletinRootAtCast: finalizationResult.journal.bulletinRoot,
            treeSize: 1,
          }),
        getBitmapData: () => Promise.resolve(bitmapData),
      }),
    );

    const response = await createHonoApp().request(
      `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification`,
      { headers: authHeaders() },
    );
    const data = requireDataRecord(await readJsonRecord(response, `verification with mismatched ${defect}`));
    const checks = getArrayProperty(getRecordProperty(data, 'verification'), 'checks');
    const includedCheck = checks?.find(
      (check) => getStringProperty(getRecordProperty({ check }, 'check'), 'id') === 'counted_my_vote_included',
    );

    expect(response.status).toBe(200);
    expect(getStringProperty(getRecordProperty({ includedCheck }, 'includedCheck'), 'status')).not.toBe('success');
  });

  it('keeps mock-profile verifier evidence successful but ineligible for the Verified label', async () => {
    captureExpectedWarnings(verificationFailureWarnings(1, false));
    delete process.env['VITE_STH_SOURCES'];
    delete process.env['VITE_STH_MIN_MATCHES'];

    const currentFinalizationResult = buildFinalizationResult();
    const vote: StoredVoteRecord = {
      voteId: 'vote-mounted-mock-evidence',
      vote: 'A',
      rand: `0x${'01'.repeat(32)}`,
      commit: `0x${'34'.repeat(32)}`,
      timestamp: 1,
      rootAtCast: currentFinalizationResult.journal.bulletinRoot,
    };
    const currentSession = buildFinalizedRecords({
      identity: {
        electionId: currentFinalizationResult.journal.electionId,
        electionConfigHash: currentFinalizationResult.journal.electionConfigHash,
        logId: `0x${'56'.repeat(32)}`,
      },
      voting: {
        votes: new Map([[0, vote]]),
        userParticipation: { status: 'cast', voteIndex: 0 },
      },
      finalizationResult: currentFinalizationResult,
      verificationResult: {
        status: 'dev_mode',
        report: {
          status: 'dev_mode',
          verifier_version: 'mock-bundle',
          verified_at: '2026-07-30T00:00:00.000Z',
          duration_ms: 0,
          expected_image_id: currentFinalizationResult.imageId,
          receipt_image_id: currentFinalizationResult.imageId,
          dev_mode_receipt: true,
          errors: [],
        },
      },
    });
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(currentSession, {
        getVoteByIdWithProof: () =>
          Promise.resolve({
            voteData: vote,
            leafIndex: 0,
            merklePath: [],
            bulletinRootAtCast: currentFinalizationResult.journal.bulletinRoot,
            treeSize: 1,
          }),
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            finalizationId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [true],
            seenBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAtMs: 1,
          }),
      }),
    );

    const response = await createHonoApp({ basePath: '/api', mode: 'lambda' }).request(
      `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification`,
      {
        headers: authHeaders(),
      },
    );
    const data = requireDataRecord(await readJsonRecord(response, 'mock verification evidence'));
    const checks = getArrayProperty(getRecordProperty(data, 'verification'), 'checks') ?? [];
    const starkReceiptCheck = checks.find((check) => getStringProperty(check, 'id') === 'stark_receipt_verify');
    const presentation = getRecordProperty(data, 'presentation');
    const policy = getRecordProperty(presentation ?? {}, 'policy');

    expect(response.status).toBe(200);
    expect(getStringProperty(getRecordProperty(data, 'verifierResult') ?? {}, 'status')).toBe('dev_mode');
    expect(getStringProperty(starkReceiptCheck, 'status')).toBe('success');
    expect(policy).toMatchObject({
      devModeEvidence: true,
      fullyVerifiedLabelEligible: false,
    });
    expect(getStringProperty(getRecordProperty(policy ?? {}, 'display') ?? {}, 'renderedStatus')).not.toBe('verified');
  });

  it('does not mount the retired verification paths', async () => {
    captureExpectedWarnings([httpRequestWarning(404), httpRequestWarning(404), httpRequestWarning(404)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const [read, run, observation] = await Promise.all([
      app.request('http://localhost/api/verify'),
      app.request('http://localhost/api/verification/run', { method: 'POST' }),
      app.request('http://localhost/api/verification/observation', { method: 'POST' }),
    ]);

    expect([read.status, run.status, observation.status]).toEqual([404, 404, 404]);
  });

  it('does not authorize canonical verification bindings with the obsolete identity header', async () => {
    captureExpectedWarnings([httpRequestWarning(401), httpRequestWarning(401), httpRequestWarning(401)]);
    const getSessionIdentity = vi.fn(() => Promise.resolve(buildFinalizedRecords().identity));
    vi.mocked(getGlobalStore).mockReturnValue(createMockVoteStore({ getSessionIdentity }));
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const verificationUrl = `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification`;
    const headers = {
      'X-Session-ID': sessionId,
      'Content-Type': 'application/json',
    };
    const [read, run, observation] = await Promise.all([
      app.request(verificationUrl, { headers }),
      app.request(verificationUrl, {
        method: 'POST',
        headers,
        body: '{}',
      }),
      app.request(`${verificationUrl}/observations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          castChecks: {
            cast_receipt_present: 'success',
            cast_choice_range: 'success',
            cast_random_format: 'success',
            cast_commitment_match: 'success',
          },
        }),
      }),
    ]);

    for (const [label, response] of [
      ['read', read],
      ['run', run],
      ['observation', observation],
    ] as const) {
      expect(response.status, label).toBe(401);
      expect(getApiErrorCode(await readJsonRecord(response, `${label} obsolete identity failure`)), label).toBe(
        'SESSION_CAPABILITY_REQUIRED',
      );
    }
    expect(getSessionIdentity).not.toHaveBeenCalled();
  });

  it('preserves SESSION_NOT_FOUND across every canonical verification binding', async () => {
    captureExpectedWarnings([httpRequestWarning(404), httpRequestWarning(404), httpRequestWarning(404)]);
    const getSessionIdentity = vi.fn(() => Promise.resolve(null));
    vi.mocked(getGlobalStore).mockReturnValue(createMockVoteStore({ getSessionIdentity }));
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const verificationUrl = `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification`;
    const headers = {
      ...authHeaders(),
      'Content-Type': 'application/json',
    };
    const [read, run, observation] = await Promise.all([
      app.request(verificationUrl, { headers }),
      app.request(verificationUrl, {
        method: 'POST',
        headers,
        body: '{}',
      }),
      app.request(`${verificationUrl}/observations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          castChecks: {
            cast_receipt_present: 'success',
            cast_choice_range: 'success',
            cast_random_format: 'success',
            cast_commitment_match: 'success',
          },
        }),
      }),
    ]);

    for (const [label, response] of [
      ['read', read],
      ['run', run],
      ['observation', observation],
    ] as const) {
      expect(response.status, label).toBe(404);
      expect(getApiErrorCode(await readJsonRecord(response, `${label} missing session`)), label).toBe(
        'SESSION_NOT_FOUND',
      );
    }
    expect(getSessionIdentity).toHaveBeenCalledTimes(3);
  });

  it('preserves USER_NOT_VOTED through the mounted verification observation binding', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
    const records = buildFinalizedRecords({
      voting: {
        userParticipation: { status: 'not_cast' },
      },
    });
    vi.mocked(getGlobalStore).mockReturnValue(createStoreWithRecords(records));
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const response = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification/observations`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          castChecks: {
            cast_receipt_present: 'success',
            cast_choice_range: 'success',
            cast_random_format: 'success',
            cast_commitment_match: 'success',
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(getApiErrorCode(await readJsonRecord(response, 'observation without a user vote'))).toBe('USER_NOT_VOTED');
  });

  it('emits the mounted final verification summary only after the bounded browser observation', async () => {
    captureExpectedWarnings(verificationFailureWarnings(3));
    process.env['VITE_STH_SOURCES'] = '/api/sessions/:sessionId/bulletin/sth';
    process.env['VITE_STH_MIN_MATCHES'] = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('forbidden', { status: 403 }))),
    );

    const finalizationResult = buildFinalizationResult();
    finalizationResult.journal.verifiedTally = [0, 1, 0, 0, 0];
    finalizationResult.scenarios = ['S2'];
    const verificationResult: VerificationResult = {
      status: 'success',
      report: {
        status: 'success',
        verifier_version: '0.1.0',
        verified_at: '2026-07-13T00:00:00.000Z',
        duration_ms: 42,
        expected_image_id: finalizationResult.imageId,
        receipt_image_id: finalizationResult.imageId,
        dev_mode_receipt: false,
        errors: [],
      },
    };
    const vote: StoredVoteRecord = {
      voteId: 'vote-mounted-user',
      vote: 'A' as const,
      rand: `0x${'01'.repeat(32)}`,
      commit: `0x${'34'.repeat(32)}`,
      timestamp: 1,
      rootAtCast: finalizationResult.journal.bulletinRoot,
    };
    const records = buildFinalizedRecords({
      identity: {
        electionId: finalizationResult.journal.electionId,
        electionConfigHash: finalizationResult.journal.electionConfigHash,
        logId: `0x${'56'.repeat(32)}`,
      },
      voting: {
        votes: new Map([[0, vote]]),
        userParticipation: { status: 'cast', voteIndex: 0 },
      },
      finalizationResult,
      verificationResult,
    });
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
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
            finalizationId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [true],
            seenBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAtMs: 1,
          }),
      }),
    );

    const loggerInfo = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const verificationUrl = `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification`;
    const verify = await app.request(verificationUrl, {
      headers: authHeaders(),
    });
    const payload = await readJsonRecord(verify, 'verify response');
    const data = getRecordProperty(payload, 'data');
    const checks = getRecordProperty(data ?? {}, 'verification')?.['checks'];
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
    expect(loggerInfo).not.toHaveBeenCalledWith('verification_run_summary', expect.anything());

    const observation = await app.request(`${verificationUrl}/observations`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        castChecks: {
          cast_receipt_present: 'success',
          cast_choice_range: 'success',
          cast_random_format: 'success',
          cast_commitment_match: 'success',
        },
      }),
    });
    expect(observation.status).toBe(200);
    expect(observation.headers.get('Cache-Control')).toBe('no-store');
    expect(getStringProperty(getRecordProperty(await readJsonRecord(observation), 'data') ?? {}, 'status')).toBe(
      'recorded',
    );
    expect(loggerInfo).toHaveBeenCalledWith('verification_run_summary', {
      event: 'verification_run_summary',
      outcome: 'recorded_integrity_failed',
      failure_category: 'none',
      scenario_id: 'S2',
      failed_required_count: 5,
      dev_mode_receipt: false,
      session_id_hash: hashSessionIdForLogging(sessionId),
      finalization_id: finalizationId,
    });

    const duplicateObservation = await app.request(`${verificationUrl}/observations`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        castChecks: {
          cast_receipt_present: 'success',
          cast_choice_range: 'success',
          cast_random_format: 'success',
          cast_commitment_match: 'success',
        },
      }),
    });
    expect(duplicateObservation.status).toBe(200);
    expect(
      getStringProperty(getRecordProperty(await readJsonRecord(duplicateObservation), 'data') ?? {}, 'status'),
    ).toBe('idempotent');
    expect(loggerInfo.mock.calls.filter(([message]) => message === 'verification_run_summary')).toHaveLength(1);
    loggerInfo.mockRestore();
  });

  it('authenticates the mounted verification observation before parsing its body', async () => {
    captureExpectedWarnings([httpRequestWarning(401), httpRequestWarning(400)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(createStoreWithRecords());

    const observationUrl = `http://localhost/api/sessions/${sessionId}/finalizations/${finalizationId}/verification/observations`;
    const unauthorized = await app.request(observationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    expect(unauthorized.status).toBe(401);
    expect(getApiErrorCode(await readJsonRecord(unauthorized))).toBe('SESSION_CAPABILITY_REQUIRED');

    const malformed = await app.request(observationUrl, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(getApiErrorCode(await readJsonRecord(malformed))).toBe('INVALID_REQUEST');
  });

  it('preserves mounted bitmap-proof auth, cache, ETag, and conditional response behavior', async () => {
    captureExpectedWarnings([httpRequestWarning(401), httpRequestWarning(401)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(buildFinalizedRecords(), {
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            finalizationId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [true],
            seenBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAtMs: 1,
          }),
      }),
    );

    const bitmapProofUrl = `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/0`;
    const missingCapability = await app.request(bitmapProofUrl);
    expect(missingCapability.status).toBe(401);
    expect(getApiErrorCode(await readJsonRecord(missingCapability, 'bitmap auth failure'))).toBe(
      'SESSION_CAPABILITY_REQUIRED',
    );

    const legacyIdentity = await app.request(bitmapProofUrl, {
      headers: {
        'X-Session-ID': sessionId,
      },
    });
    expect(legacyIdentity.status).toBe(401);
    expect(getApiErrorCode(await readJsonRecord(legacyIdentity, 'bitmap obsolete identity failure'))).toBe(
      'SESSION_CAPABILITY_REQUIRED',
    );

    const proof = await app.request(bitmapProofUrl, {
      headers: authHeaders(),
    });
    const proofPayload = await readJsonRecord(proof, 'bitmap proof');
    const proofData = requireDataRecord(proofPayload, 'bitmap proof data');
    const etag = proof.headers.get('ETag');

    expect(proof.status).toBe(200);
    expect(proof.headers.get('Cache-Control')).toContain('private');
    expect(proof.headers.get('Vary')).toBe('X-Session-Capability, Origin');
    expect(etag).toMatch(/^W\/"/);
    expect(getStringProperty(proofData, 'leafChunk')).toMatch(/^[0-9a-f]{64}$/);

    const notModified = await app.request(bitmapProofUrl, {
      headers: {
        ...authHeaders(),
        'If-None-Match': etag ?? '',
      },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('ETag')).toBe(etag);
    expect(await notModified.text()).toBe('');
  });

  it('fails closed when bitmap sidecar roots do not match the finalized journal', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const records = buildFinalizedRecords();
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            finalizationId,
            includedBitmap: [false],
            includedBitmapRoot: computeIncludedBitmapRoot([false]),
            treeSize: 1,
            finalizedAtMs: 1,
          }),
      }),
    );

    const proof = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/0`,
      {
        headers: authHeaders(),
      },
    );
    const payload = await readJsonRecord(proof, 'bitmap proof root mismatch');

    expect(proof.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('fails closed when bitmap data is unavailable after finalization', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const records = buildFinalizedRecords();
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getBitmapData: () => Promise.resolve(null),
      }),
    );

    const proof = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/0`,
      {
        headers: authHeaders(),
      },
    );
    const payload = await readJsonRecord(proof, 'missing bitmap data');

    expect(proof.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('fails closed when the included bitmap sidecar is unavailable', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const records = buildFinalizedRecords();
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            finalizationId,
            includedBitmap: undefined as unknown as boolean[],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [true],
            seenBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAtMs: 1,
          }),
      }),
    );

    const proof = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/0`,
      {
        headers: authHeaders(),
      },
    );
    const payload = await readJsonRecord(proof, 'missing included bitmap sidecar');

    expect(proof.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('fails closed when the seen bitmap sidecar is unavailable', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const records = buildFinalizedRecords();
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            finalizationId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            treeSize: 1,
            finalizedAtMs: 1,
          }),
      }),
    );

    const proof = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/seen/0`,
      {
        headers: authHeaders(),
      },
    );
    const payload = await readJsonRecord(proof, 'missing seen bitmap sidecar');

    expect(proof.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('fails closed when the seen bitmap sidecar root does not match the finalized journal', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
    const app = createHonoApp({ basePath: '/api', mode: 'lambda' });
    const records = buildFinalizedRecords();
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            finalizationId,
            includedBitmap: [true],
            includedBitmapRoot: computeIncludedBitmapRoot([true]),
            seenBitmap: [false],
            seenBitmapRoot: computeIncludedBitmapRoot([false]),
            treeSize: 1,
            finalizedAtMs: 1,
          }),
      }),
    );

    const proof = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/seen/0`,
      {
        headers: authHeaders(),
      },
    );
    const payload = await readJsonRecord(proof, 'seen bitmap root mismatch');

    expect(proof.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_BITMAP_PROOF_REQUEST');
  });

  it('rejects normal bitmap-proof requests for indices other than the session user vote', async () => {
    captureExpectedWarnings([httpRequestWarning(400)]);
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
    const records = buildFinalizedRecords({
      voting: {
        userParticipation: { status: 'cast', voteIndex: 0 },
      },
      finalizationResult,
    });
    vi.mocked(getGlobalStore).mockReturnValue(
      createStoreWithRecords(records, {
        getBitmapData: () =>
          Promise.resolve({
            sessionId,
            finalizationId,
            includedBitmap: bitmap,
            includedBitmapRoot: bitmapRoot,
            seenBitmap: bitmap,
            seenBitmapRoot: bitmapRoot,
            treeSize: 2,
            finalizedAtMs: 1,
          }),
      }),
    );

    const proof = await app.request(
      `http://localhost/api/sessions/${sessionId}/finalizations/current/bitmap-proofs/included/1`,
      {
        headers: authHeaders(),
      },
    );
    const payload = await readJsonRecord(proof, 'non-user bitmap proof rejection');

    expect(proof.status).toBe(400);
    expect(getApiErrorCode(payload)).toBe('INVALID_BITMAP_PROOF_REQUEST');
    expect(getRecordProperty(payload, 'error')).not.toHaveProperty('details');
  });
});

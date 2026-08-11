import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as yazl from 'yazl';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import {
  assertAuthenticatedVerificationReport,
  assertIndependentFinalizationImageId,
  assertExpectedOverallVerdict,
  assertGatedSmokeScenarioSemantics,
  completeFinalizedVerificationAcceptance,
  createPositiveOwnerFlowConfig,
  createPositiveOwnerFlowConfigs,
  downloadAuthenticatedBundle,
  expectCloudFrontGateRejected,
  expectJsonErrorCodeRejected,
  operatorHeaders,
  resolveBaseUrl,
  resolveGatedSmokeExpectedImageId,
  resolveGatedSmokeScenarioExpectation,
  resolveGatedSmokeScenarios,
  runVerificationAcceptance,
  runDirectOriginCheck,
  runNegativeGateChecks,
  runWrongCapabilityCheck,
} from '../tests/develop-gated-smoke';
import type { ImageIdMapping } from '@stark-ballot/verification/image-id-types';
import { VERIFICATION_CHECK_DEFINITIONS, type VerificationCheck } from '@stark-ballot/verification/checks';
import packageJson from '../../package.json';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { AvailableVerificationResource } from '@stark-ballot/api-contract/schemas/verification';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';

function responseJson(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function apiSuccessResponse(data: unknown): Response {
  return responseJson({
    data,
    meta: { requestId: 'request-verification' },
  });
}

function errorResponseJson(code: ErrorCode, status: number): Response {
  return responseJson(
    {
      error: { code, message: code },
      meta: { requestId: `request-${code.toLowerCase()}` },
    },
    status,
  );
}

function cloudFrontDenial(status = 403): Response {
  return new Response('Forbidden', {
    status,
    headers: {
      Server: 'CloudFront',
      Via: '1.1 example.cloudfront.net (CloudFront)',
      'X-Cache': 'Error from cloudfront',
    },
  });
}

function callHeaders(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): Headers {
  const call = fetchMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected fetch call ${callIndex} to exist.`);
  }
  const init = call[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error('Unexpected zip output chunk.');
}

async function buildZipBuffer(entries: ReadonlyArray<{ name: string; content: string }>): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zipfile.outputStream.on('data', (chunk: unknown) => chunks.push(toBuffer(chunk)));
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) {
      zipfile.addBuffer(Buffer.from(entry.content), entry.name, { mtime: new Date(0), compress: false });
    }
    zipfile.end();
  });
}

function buildSuccessfulVerificationChecks(): VerificationCheck[] {
  return VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    status: 'success',
    evidence: definition.evidence,
    inputs: definition.inputs,
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));
}

function buildServerVerificationChecks(): VerificationCheck[] {
  return buildSuccessfulVerificationChecks().map((check) =>
    check.id.startsWith('cast_') ? { ...check, status: 'not_run' } : check,
  );
}

function failCheck(checks: VerificationCheck[], checkId: VerificationCheck['id']): VerificationCheck[] {
  return checks.map((check) => (check.id === checkId ? { ...check, status: 'failed' } : check));
}

function buildSuccessfulVerificationReport(expectedImageId: string): Record<string, unknown> {
  return {
    status: 'success',
    verifier_version: '0.1.0',
    verified_at: '2026-07-12T00:00:00.000Z',
    duration_ms: 123,
    expected_image_id: expectedImageId,
    receipt_image_id: expectedImageId,
    dev_mode_receipt: false,
    errors: [],
  };
}

function successfulVerificationReportResponse(expectedImageId: string, finalizationId = 'finalization-1'): Response {
  return responseJson(buildSuccessfulVerificationReport(expectedImageId), 200, {
    'Content-Disposition': `inline; filename="${finalizationId}-verification.json"`,
  });
}

function groupedVerificationResource(options: {
  status: 'running' | 'not_run' | 'success' | 'failed' | 'dev_mode';
  expectedImageId: string;
  finalizationId?: string;
  electionId?: string;
  random?: string;
  checks?: VerificationCheck[];
  journalRepresentation?: 'included' | 'omitted';
  voterEvidenceAvailability?: 'available' | 'unavailable';
}): AvailableVerificationResource {
  const finalizationId = options.finalizationId ?? 'finalization-1';
  const electionId = options.electionId ?? '550e8400-e29b-41d4-a716-446655440000';
  const random = options.random ?? `0x${'3'.repeat(64)}`;
  const commitment = computeCommitment(electionId, 0, random);
  const journal = createTestJournal({
    electionId,
    totalExpected: 1,
    validVotes: 1,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    seenIndicesCount: 1,
  });
  const checks = options.checks ?? buildServerVerificationChecks();
  const policy = deriveVerificationPresentationPolicy({
    availability: 'available',
    checks,
    context: {
      missingSlots: journal.missingSlots,
      invalidPresentedSlots: journal.invalidPresentedSlots,
      rejectedRecords: journal.rejectedRecords,
      excludedSlots: journal.excludedSlots,
      sthSourcesConfigured: true,
    },
    verificationStatus: options.status,
  });
  const tally = {
    A: journal.verifiedTally[0] ?? 0,
    B: journal.verifiedTally[1] ?? 0,
    C: journal.verifiedTally[2] ?? 0,
    D: journal.verifiedTally[3] ?? 0,
    E: journal.verifiedTally[4] ?? 0,
  };

  return {
    availability: 'available',
    finalizationId,
    proofAuthority: {
      electionId,
      electionConfigHash: journal.electionConfigHash,
      logId: 'log-1',
      bulletinRoot: journal.bulletinRoot,
      imageId: options.expectedImageId,
      verifiedTally: [...journal.verifiedTally],
      missingSlots: journal.missingSlots,
      invalidPresentedSlots: journal.invalidPresentedSlots,
      rejectedRecords: journal.rejectedRecords,
      totalExpected: journal.totalExpected,
      treeSize: journal.treeSize,
      excludedSlots: journal.excludedSlots,
      sthDigest: journal.sthDigest,
      seenBitmapRoot: journal.seenBitmapRoot,
      includedBitmapRoot: journal.includedBitmapRoot,
      inputCommitment: journal.inputCommitment,
      seenIndicesCount: journal.seenIndicesCount,
    },
    presentation: {
      tally: {
        counts: tally,
        totalVotes: journal.totalVotes,
        tamperedCount: 0,
      },
      scenarioId: 'S0',
      policy,
    },
    verifierResult: { status: options.status },
    verification: {
      checks,
      steps: [
        {
          id: 'cast_as_intended',
          status: policy.stageStatuses.cast_as_intended,
          inputs: [],
        },
        {
          id: 'recorded_as_cast',
          status: policy.stageStatuses.recorded_as_cast,
          inputs: [],
        },
        {
          id: 'counted_as_recorded',
          status: policy.stageStatuses.counted_as_recorded,
          inputs: [],
        },
        {
          id: 'stark_verification',
          status: policy.stageStatuses.stark_verification,
          inputs: [],
        },
      ],
    },
    voterEvidence:
      options.voterEvidenceAvailability === 'unavailable'
        ? {
            availability: 'unavailable',
            reason: 'exact_proof_unavailable',
            userVote: { commitment },
          }
        : {
            availability: 'available',
            voteReceipt: {
              voteId: 'vote-1',
              commitment,
              bulletinIndex: 0,
              bulletinRootAtCast: journal.bulletinRoot,
              castAtMs: 1,
              inputCommitment: journal.inputCommitment,
            },
            userVote: {
              commitment,
              voteId: 'vote-1',
              proof: {
                leafIndex: 0,
                treeSize: 1,
                merklePath: [],
                bulletinRootAtCast: journal.bulletinRoot,
              },
            },
          },
    journal:
      options.journalRepresentation === 'omitted'
        ? { representation: 'omitted' }
        : { representation: 'included', value: journal },
  };
}

function groupedVerificationResponse(resource: AvailableVerificationResource): Response {
  return apiSuccessResponse(resource);
}

function verificationRunResponse(
  overrides: Partial<{
    verificationStatus: 'running' | 'success' | 'failed' | 'not_run' | 'dev_mode';
    finalizationId: string;
    estimatedDurationMs: number;
    idempotent: boolean;
  }> = {},
): Response {
  return apiSuccessResponse({
    verificationStatus: 'running',
    finalizationId: 'finalization-1',
    estimatedDurationMs: 4000,
    idempotent: false,
    ...overrides,
  });
}

describe('develop gated smoke contract', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses localhost unless explicit local non-acceptance mode is enabled', () => {
    vi.stubEnv('STARK_BALLOT_DEVELOP_BASE_URL', 'http://localhost:3000/path');

    expect(() => resolveBaseUrl()).toThrow('develop gated smoke refuses localhost');

    vi.stubEnv('STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE', '1');

    expect(resolveBaseUrl()).toBe('http://localhost:3000');
  });

  it('requires and returns the operator auth header pair', () => {
    vi.stubEnv('STARK_BALLOT_OPERATOR_AUTH_HEADER', 'Cookie');

    expect(() => operatorHeaders()).toThrow('STARK_BALLOT_OPERATOR_AUTH_VALUE must be set.');

    vi.stubEnv('STARK_BALLOT_OPERATOR_AUTH_VALUE', 'CloudFront-Policy=policy; CloudFront-Signature=sig');

    expect(operatorHeaders()).toEqual({
      Cookie: 'CloudFront-Policy=policy; CloudFront-Signature=sig',
    });
  });

  it('requires direct-origin evidence for non-local acceptance smoke', async () => {
    await expect(runDirectOriginCheck({}, 'https://develop.stark-ballot-sim.hwatanabe.dev')).rejects.toThrow(
      'STARK_BALLOT_DIRECT_API_ORIGIN must be set for develop gated smoke acceptance',
    );
  });

  it('skips direct-origin evidence only in explicit local non-acceptance mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE', '1');

    await runDirectOriginCheck({}, 'http://127.0.0.1:3000');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts only CloudFront-shaped unauthenticated gate denials', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(cloudFrontDenial());
    vi.stubGlobal('fetch', fetchMock);

    await expectCloudFrontGateRejected('unauthenticated GET /', 'https://develop.example/');
  });

  it('rejects ordinary application errors as unauthenticated gate evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errorResponseJson(ErrorCode.INVALID_REQUEST, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(expectCloudFrontGateRejected('unauthenticated GET /', 'https://develop.example/')).rejects.toThrow(
      'expected a CloudFront signed-cookie gate denial',
    );
  });

  it('checks all unauthenticated develop hostname probes for CloudFront gate denials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(cloudFrontDenial());
    vi.stubGlobal('fetch', fetchMock);

    await runNegativeGateChecks('https://develop.example');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://develop.example/',
      'https://develop.example/api/sessions',
      'https://develop.example/api/sessions/gate-probe/finalizations/gate-probe/verification',
    ]);
  });

  it('accepts only the expected JSON API error code for app-origin rejections', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errorResponseJson(ErrorCode.SAME_ORIGIN_REQUIRED, 403));
    vi.stubGlobal('fetch', fetchMock);

    await expectJsonErrorCodeRejected(
      'direct-origin POST /api/sessions',
      'https://abc123.execute-api.ap-northeast-1.amazonaws.com/api/sessions',
      ErrorCode.SAME_ORIGIN_REQUIRED,
    );
  });

  it('rejects a successful status even if it carries the expected JSON error code', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(errorResponseJson(ErrorCode.SAME_ORIGIN_REQUIRED, 200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      expectJsonErrorCodeRejected(
        'direct-origin POST /api/sessions',
        'https://abc123.execute-api.ap-northeast-1.amazonaws.com/api/sessions',
        ErrorCode.SAME_ORIGIN_REQUIRED,
      ),
    ).rejects.toThrow('returned 200 with error SAME_ORIGIN_REQUIRED');
  });

  it('sends operator credentials to the direct-origin probe and expects the origin guard error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponseJson(ErrorCode.SAME_ORIGIN_REQUIRED, 403));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('STARK_BALLOT_DIRECT_API_ORIGIN', 'https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod');

    await runDirectOriginCheck(
      { Cookie: 'CloudFront-Policy=policy; CloudFront-Signature=sig' },
      'https://develop.example',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://abc123.execute-api.ap-northeast-1.amazonaws.com/api/sessions',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    );
    const headers = callHeaders(fetchMock, 0);
    expect(headers.get('Cookie')).toBe('CloudFront-Policy=policy; CloudFront-Signature=sig');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('fails closed when the direct-origin probe returns a normal response instead of the origin guard error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('STARK_BALLOT_DIRECT_API_ORIGIN', 'https://abc123.execute-api.ap-northeast-1.amazonaws.com');

    await expect(runDirectOriginCheck({}, 'https://develop.example')).rejects.toThrow(
      'expected JSON error SAME_ORIGIN_REQUIRED',
    );
  });

  it('fails closed when the direct-origin probe returns an ordinary app error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponseJson(ErrorCode.INVALID_REQUEST, 400));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('STARK_BALLOT_DIRECT_API_ORIGIN', 'https://abc123.execute-api.ap-northeast-1.amazonaws.com');

    await expect(runDirectOriginCheck({}, 'https://develop.example')).rejects.toThrow(
      'returned 400 with error INVALID_REQUEST',
    );
  });

  it('uses operator credentials for session creation and wrong-capability rejection checks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responseJson({
          data: {
            electionId: 'election-1',
            sessionId: 'session-1',
            capabilityToken: 'capability-1',
          },
          meta: { requestId: 'request-session' },
        }),
      )
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401));
    vi.stubGlobal('fetch', fetchMock);

    await runWrongCapabilityCheck('https://develop.example', {
      Cookie: 'CloudFront-Policy=policy; CloudFront-Signature=sig; CloudFront-Key-Pair-Id=key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://develop.example/api/sessions');
    expect(callHeaders(fetchMock, 0).get('Cookie')).toContain('CloudFront-Policy=policy');

    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://develop.example/api/sessions/session-1/progress');
    const wrongCapabilityHeaders = callHeaders(fetchMock, 1);
    expect(wrongCapabilityHeaders.get('Cookie')).toContain('CloudFront-Key-Pair-Id=key');
    expect(wrongCapabilityHeaders.get('X-Session-Capability')).toBe('wrong-capability-token');
  });

  it('constructs the positive owner flow with production STARK verification required', () => {
    expect(createPositiveOwnerFlowConfig()).toEqual({
      scenarios: [],
      useRealZkVM: true,
      realMode: 'prod',
      verbose: false,
      outputFormat: 'table',
      allScenarios: false,
      scenario: 'S0',
      userChoice: 'A',
      skipBuild: true,
    });
  });

  it('resolves the independent develop ImageID from the current default mapping variant', () => {
    const mapping: ImageIdMapping = {
      mappingType: 'image-id-mapping',
      current: '14',
      deprecated: [],
      mappings: {
        '14': {
          methodVersion: 14,
          variants: {
            default: {
              state: 'confirmed',
              imageId: `0x${'1'.repeat(64)}`,
              provenance: {
                evidenceType: 'accepted-prover-release',
                sourceSha: '3'.repeat(40),
                proverImageDigest: `sha256:${'4'.repeat(64)}`,
                candidateMetadataSha256: '5'.repeat(64),
                releaseRecordSha256: '6'.repeat(64),
                toolchainArtifactRecordSha256: '7'.repeat(64),
              },
            },
            x86_64: {
              state: 'confirmed',
              imageId: `0x${'2'.repeat(64)}`,
              provenance: {
                evidenceType: 'accepted-prover-release',
                sourceSha: '3'.repeat(40),
                proverImageDigest: `sha256:${'4'.repeat(64)}`,
                candidateMetadataSha256: '5'.repeat(64),
                releaseRecordSha256: '6'.repeat(64),
                toolchainArtifactRecordSha256: '7'.repeat(64),
              },
            },
          },
          description: 'test mapping',
          features: [],
        },
      },
      metadata: {
        lastUpdated: '2026-07-26T00:00:00Z',
        purpose: 'test fixture',
        notes: 'test fixture',
      },
    };
    vi.stubEnv('EXPECTED_IMAGE_ID_VARIANT', 'x86_64');

    expect(resolveGatedSmokeExpectedImageId(mapping)).toBe(`0x${'1'.repeat(64)}`);
  });

  it('does not override the target default ImageID variant in the package entrypoint', () => {
    expect(packageJson.scripts['test:develop:gated-smoke']).toBe('pnpm tsx scripts/tests/develop-gated-smoke.ts');
  });

  it('binds every available finalization ImageID projection to the independent authority', () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;

    expect(() =>
      assertIndependentFinalizationImageId(
        {
          imageId: expectedImageId,
          proof: { imageId: expectedImageId },
          journal: { imageId: expectedImageId },
        },
        expectedImageId,
      ),
    ).not.toThrow();
    expect(() =>
      assertIndependentFinalizationImageId(
        { imageId: expectedImageId, proof: { imageId: `0x${'2'.repeat(64)}` } },
        expectedImageId,
      ),
    ).toThrow('proof ImageID mismatch');
    expect(() => assertIndependentFinalizationImageId({}, expectedImageId)).toThrow('top-level ImageID mismatch');
  });

  it('completes verification acceptance for the finalized session and returns the polled payload', async () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const electionId = '550e8400-e29b-41d4-a716-446655440000';
    const random = `0x${'3'.repeat(64)}`;
    const commitment = computeCommitment(electionId, 0, random);
    const runAcceptance = vi.fn().mockResolvedValue({
      resource: groupedVerificationResource({
        status: 'success',
        expectedImageId,
        electionId,
        random,
      }),
    });

    const result = await completeFinalizedVerificationAcceptance(
      {
        data: {
          verificationStatus: 'not_run',
          imageId: expectedImageId,
        },
      },
      {
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId,
        expectedTerminalVerificationStatus: 'success',
        expectedOverallVerdict: 'fully_verified',
        scenario: 'S0',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        localVote: {
          voteId: 'vote-1',
          leafIndex: 0,
          merklePath: [],
          commitment,
          choice: 'A',
          random,
        },
      },
      runAcceptance,
    );

    expect(runAcceptance).toHaveBeenCalledWith({
      baseUrl: 'https://develop.example',
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      expectedImageId,
      expectedTerminalVerificationStatus: 'success',
      authHeaders: { 'X-Session-Capability': 'capability-1' },
    });
    expect(result.data).toMatchObject({ verificationStatus: 'success', imageId: expectedImageId });
  });

  it('rejects a fresh verifier result that omits checks instead of reusing pre-run checks', async () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const preRunChecks = buildSuccessfulVerificationChecks();
    const incompleteChecks = buildServerVerificationChecks().slice(1);
    const runAcceptance = vi.fn().mockResolvedValue({
      resource: groupedVerificationResource({
        status: 'success',
        expectedImageId,
        checks: incompleteChecks,
      }),
    });

    await expect(
      completeFinalizedVerificationAcceptance(
        {
          data: {
            verificationStatus: 'not_run',
            imageId: expectedImageId,
            verificationChecks: preRunChecks,
          },
        },
        {
          baseUrl: 'https://develop.example',
          sessionId: 'session-1',
          finalizationId: 'finalization-1',
          expectedImageId,
          expectedTerminalVerificationStatus: 'success',
          expectedOverallVerdict: 'fully_verified',
          scenario: 'S0',
          authHeaders: { 'X-Session-Capability': 'capability-1' },
          localVote: {
            voteId: 'vote-1',
            leafIndex: 0,
            merklePath: [],
            commitment: `0x${'1'.repeat(64)}`,
            choice: 'A',
            random: `0x${'3'.repeat(64)}`,
          },
        },
        runAcceptance,
      ),
    ).rejects.toThrow(/incomplete|verification check inventory/i);
  });

  it('requires S0 to be fully verified and tamper scenarios to have a failed overall verdict', () => {
    const allSuccess = buildSuccessfulVerificationChecks();
    expect(() =>
      assertExpectedOverallVerdict({ verificationChecks: allSuccess, excludedSlots: 0 }, 'fully_verified'),
    ).not.toThrow();

    const exclusionChecks = failCheck(allSuccess, 'counted_missing_indices_zero');
    expect(() =>
      assertExpectedOverallVerdict(
        { verificationChecks: exclusionChecks, missingSlots: 1, excludedSlots: 1 },
        'fail_closed',
      ),
    ).not.toThrow();

    const claimedTallyChecks = failCheck(allSuccess, 'counted_tally_consistent');
    expect(() =>
      assertExpectedOverallVerdict({ verificationChecks: claimedTallyChecks, excludedSlots: 0 }, 'fail_closed'),
    ).not.toThrow();
    expect(() =>
      assertExpectedOverallVerdict({ verificationChecks: allSuccess, excludedSlots: 0 }, 'fail_closed'),
    ).toThrow('expected a failed overall verdict');

    expect(() =>
      assertExpectedOverallVerdict(
        {
          verificationChecks: allSuccess.filter((check) => check.id !== 'recorded_sth_third_party'),
          excludedSlots: 0,
        },
        'fully_verified',
      ),
    ).toThrow('Expected a fully verified overall verdict');
  });

  it('requires each educational scenario to fail only through its intended verification semantics', () => {
    const allSuccess = buildSuccessfulVerificationChecks();
    const s1Checks = failCheck(failCheck(allSuccess, 'counted_missing_indices_zero'), 'counted_my_vote_included');
    const s2Checks = failCheck(allSuccess, 'counted_tally_consistent');
    const s3Checks = failCheck(allSuccess, 'counted_missing_indices_zero');
    const s4Checks = failCheck(allSuccess, 'counted_tally_consistent');
    const s5Checks = failCheck(allSuccess, 'counted_missing_indices_zero');

    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: allSuccess, missingSlots: 0, invalidPresentedSlots: 0, excludedSlots: 0 },
        'S0',
      ),
    ).not.toThrow();
    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: s1Checks, missingSlots: 1, invalidPresentedSlots: 0, excludedSlots: 1 },
        'S1',
      ),
    ).not.toThrow();
    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: s2Checks, missingSlots: 0, invalidPresentedSlots: 0, excludedSlots: 0 },
        'S2',
      ),
    ).not.toThrow();
    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: s3Checks, missingSlots: 1, invalidPresentedSlots: 0, excludedSlots: 1 },
        'S3',
      ),
    ).not.toThrow();
    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: s4Checks, missingSlots: 0, invalidPresentedSlots: 0, excludedSlots: 0 },
        'S4',
      ),
    ).not.toThrow();
    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: s5Checks, missingSlots: 1, invalidPresentedSlots: 0, excludedSlots: 1 },
        'S5',
      ),
    ).not.toThrow();
  });

  it('rejects the wrong failure class and unrelated core-check failures in tamper scenarios', () => {
    const allSuccess = buildSuccessfulVerificationChecks();
    const exclusionInsteadOfTally = failCheck(allSuccess, 'counted_missing_indices_zero');
    const s1WithBrokenConsistency = failCheck(
      failCheck(failCheck(allSuccess, 'counted_missing_indices_zero'), 'counted_my_vote_included'),
      'recorded_consistency_proof',
    );
    const s2WithBrokenReceipt = failCheck(failCheck(allSuccess, 'counted_tally_consistent'), 'stark_receipt_verify');

    expect(() =>
      assertGatedSmokeScenarioSemantics(
        {
          verificationChecks: exclusionInsteadOfTally,
          missingSlots: 1,
          invalidPresentedSlots: 0,
          excludedSlots: 1,
        },
        'S2',
      ),
    ).toThrow(/S2.*counted_tally_consistent|claimed-tally/i);
    expect(() =>
      assertGatedSmokeScenarioSemantics(
        {
          verificationChecks: s1WithBrokenConsistency,
          missingSlots: 1,
          invalidPresentedSlots: 0,
          excludedSlots: 1,
        },
        'S1',
      ),
    ).toThrow(/recorded_consistency_proof/);
    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: s2WithBrokenReceipt, missingSlots: 0, invalidPresentedSlots: 0, excludedSlots: 0 },
        'S2',
      ),
    ).toThrow(/stark_receipt_verify/);
  });

  it('requires a fresh complete and duplicate-free verification check set', () => {
    const allSuccess = buildSuccessfulVerificationChecks();
    const missingCheck = allSuccess.filter((check) => check.id !== 'recorded_inclusion_proof');
    const firstCheck = allSuccess[0];
    if (!firstCheck) {
      throw new Error('Expected at least one verification check fixture.');
    }
    const duplicateCheck = [...allSuccess, firstCheck];

    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: missingCheck, missingSlots: 0, invalidPresentedSlots: 0, excludedSlots: 0 },
        'S0',
      ),
    ).toThrow(/missing.*recorded_inclusion_proof/i);
    expect(() =>
      assertGatedSmokeScenarioSemantics(
        { verificationChecks: duplicateCheck, missingSlots: 0, invalidPresentedSlots: 0, excludedSlots: 0 },
        'S0',
      ),
    ).toThrow(/duplicate/i);
  });

  it('validates the authenticated verifier report against status, ImageID, and finalization scope', () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const expectedFinalizationId = 'finalization-1';
    const validReport = buildSuccessfulVerificationReport(expectedImageId);
    const validHeaders = new Headers({
      'Content-Type': 'application/json',
      'Content-Disposition': `inline; filename="${expectedFinalizationId}-verification.json"`,
    });

    expect(() =>
      assertAuthenticatedVerificationReport(validReport, validHeaders, {
        expectedImageId,
        expectedFinalizationId,
        expectedStatus: 'success',
      }),
    ).not.toThrow();
    expect(() =>
      assertAuthenticatedVerificationReport({}, validHeaders, {
        expectedImageId,
        expectedFinalizationId,
        expectedStatus: 'success',
      }),
    ).toThrow(/status|verifier/i);
    expect(() =>
      assertAuthenticatedVerificationReport(
        { ...validReport, expected_image_id: `0x${'2'.repeat(64)}` },
        validHeaders,
        { expectedImageId, expectedFinalizationId, expectedStatus: 'success' },
      ),
    ).toThrow(/expected_image_id/i);
    expect(() =>
      assertAuthenticatedVerificationReport({ ...validReport, receipt_image_id: `0x${'2'.repeat(64)}` }, validHeaders, {
        expectedImageId,
        expectedFinalizationId,
        expectedStatus: 'success',
      }),
    ).toThrow(/receipt_image_id/i);
    expect(() =>
      assertAuthenticatedVerificationReport({ ...validReport, dev_mode_receipt: true }, validHeaders, {
        expectedImageId,
        expectedFinalizationId,
        expectedStatus: 'success',
      }),
    ).toThrow(/dev_mode_receipt/i);
    expect(() =>
      assertAuthenticatedVerificationReport({ ...validReport, errors: ['unexpected verifier warning'] }, validHeaders, {
        expectedImageId,
        expectedFinalizationId,
        expectedStatus: 'success',
      }),
    ).toThrow(/errors/i);
    expect(() =>
      assertAuthenticatedVerificationReport(
        validReport,
        new Headers({
          'Content-Type': 'application/json',
          'Content-Disposition': 'inline; filename="other-exec-verification.json"',
        }),
        { expectedImageId, expectedFinalizationId, expectedStatus: 'success' },
      ),
    ).toThrow(/finalization|Content-Disposition/i);
  });

  it('defaults to a compact S0, exclusion, and claimed-tally scenario matrix', () => {
    expect(resolveGatedSmokeScenarios()).toEqual(['S0', 'S1', 'S2']);
    expect(createPositiveOwnerFlowConfigs().map((config) => config.scenario)).toEqual(['S0', 'S1', 'S2']);
    expect(resolveGatedSmokeScenarioExpectation('S0')).toEqual({
      terminalVerificationStatus: 'success',
      overallVerdict: 'fully_verified',
    });
    expect(resolveGatedSmokeScenarioExpectation('S1')).toEqual({
      terminalVerificationStatus: 'success',
      overallVerdict: 'fail_closed',
    });
    expect(resolveGatedSmokeScenarioExpectation('S2')).toEqual({
      terminalVerificationStatus: 'success',
      overallVerdict: 'fail_closed',
    });
  });

  it('accepts a full scenario matrix and rejects incomplete acceptance matrices', () => {
    expect(resolveGatedSmokeScenarios('S0,S1,S2,S3,S4,S5')).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
    expect(() => resolveGatedSmokeScenarios('S0,S2')).toThrow('must include an exclusion scenario');
    expect(() => resolveGatedSmokeScenarios('S0,S1')).toThrow('must include a claimed-tally scenario');
    expect(() => resolveGatedSmokeScenarios('S0,S1,S2,S6')).toThrow('unsupported scenario');
  });

  it('runs durable verification, polls to success, checks artifact auth, and enforces the public ZIP boundary', async () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const bundle = await buildZipBuffer([
      { name: 'public-input.json', content: '{}' },
      { name: 'receipt.json', content: '{}' },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse())
      .mockResolvedValueOnce(
        groupedVerificationResponse(groupedVerificationResource({ status: 'running', expectedImageId })),
      )
      .mockResolvedValueOnce(
        groupedVerificationResponse(groupedVerificationResource({ status: 'success', expectedImageId })),
      )
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401))
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401))
      .mockResolvedValueOnce(
        new Response(Uint8Array.from(bundle), { status: 200, headers: { 'Content-Type': 'application/zip' } }),
      )
      .mockResolvedValueOnce(successfulVerificationReportResponse(expectedImageId));
    vi.stubGlobal('fetch', fetchMock);

    const verificationData = await runVerificationAcceptance({
      baseUrl: 'https://develop.example',
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
      expectedImageId,
      expectedTerminalVerificationStatus: 'success',
      authHeaders: {
        Cookie: 'CloudFront-Policy=policy',
        'X-Session-Capability': 'capability-1',
      },
      pollDelayMs: 0,
    });

    expect(verificationData).toMatchObject({
      resource: {
        availability: 'available',
        finalizationId: 'finalization-1',
        proofAuthority: { imageId: expectedImageId },
        verifierResult: { status: 'success' },
      },
      publicReceipt: {},
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://develop.example/api/sessions/session-1/finalizations/finalization-1/verification',
      'https://develop.example/api/sessions/session-1/finalizations/finalization-1/verification?include=journal',
      'https://develop.example/api/sessions/session-1/finalizations/finalization-1/verification?include=journal',
      'https://develop.example/api/sessions/session-1/finalizations/finalization-1/artifacts/bundle',
      'https://develop.example/api/sessions/session-1/finalizations/finalization-1/artifacts/report',
      'https://develop.example/api/sessions/session-1/finalizations/finalization-1/artifacts/bundle',
      'https://develop.example/api/sessions/session-1/finalizations/finalization-1/artifacts/report',
    ]);
    expect(callHeaders(fetchMock, 0).get('X-Session-Capability')).toBe('capability-1');
    expect(callHeaders(fetchMock, 3).get('X-Session-Capability')).toBe('wrong-capability-token');
    expect(callHeaders(fetchMock, 4).get('X-Session-Capability')).toBe('wrong-capability-token');
  });

  it.each([
    [
      'unavailable',
      {
        availability: 'unavailable',
        finalizationId: 'finalization-1',
        reason: 'finalization_not_current',
        message: 'Unsupported artifact',
      },
    ],
    [
      'corrupt',
      {
        availability: 'corrupt',
        finalizationId: 'finalization-1',
        reason: 'invalid_artifact',
        message: 'Corrupt artifact',
      },
    ],
  ] as const)('fails closed on a %s verification resource', async (availability, resource) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse())
      .mockResolvedValueOnce(apiSuccessResponse(resource));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId: `0x${'1'.repeat(64)}`,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
      }),
    ).rejects.toThrow(`availability ${availability}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a verification resource for a different finalization', async () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse())
      .mockResolvedValueOnce(
        groupedVerificationResponse(
          groupedVerificationResource({
            finalizationId: 'finalization-2',
            status: 'success',
            expectedImageId,
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
      }),
    ).rejects.toThrow('finalizationId mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown response after a valid running snapshot without reusing stale data', async () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse())
      .mockResolvedValueOnce(
        groupedVerificationResponse(groupedVerificationResource({ status: 'running', expectedImageId })),
      )
      .mockResolvedValueOnce(
        apiSuccessResponse({
          availability: 'future-success',
          finalizationId: 'finalization-1',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
        maxPollAttempts: 2,
      }),
    ).rejects.toThrow('invalid response');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['included journal', { journalRepresentation: 'omitted' as const }, 'journal'],
    ['exact voter evidence', { voterEvidenceAvailability: 'unavailable' as const }, 'voter evidence'],
  ])('requires %s in every admitted verification resource', async (_label, overrides, expectedError) => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse())
      .mockResolvedValueOnce(
        groupedVerificationResponse(groupedVerificationResource({ status: 'success', expectedImageId, ...overrides })),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
      }),
    ).rejects.toThrow(expectedError);
  });

  it('strictly parses the verification run response before polling', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      responseJson({
        data: {
          verificationStatus: 'running',
          finalizationId: 'finalization-1',
          estimatedDurationMs: 4000,
          idempotent: false,
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId: `0x${'1'.repeat(64)}`,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
      }),
    ).rejects.toThrow('invalid response');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects an authenticated report whose body does not satisfy the verifier report contract', async () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const bundle = await buildZipBuffer([{ name: 'public-input.json', content: '{}' }]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse())
      .mockResolvedValueOnce(
        groupedVerificationResponse(groupedVerificationResource({ status: 'success', expectedImageId })),
      )
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401))
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401))
      .mockResolvedValueOnce(new Response(Uint8Array.from(bundle), { status: 200 }))
      .mockResolvedValueOnce(
        responseJson({}, 200, {
          'Content-Disposition': 'inline; filename="finalization-1-verification.json"',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
      }),
    ).rejects.toThrow(/report status|verifier/i);
  });

  it('downloads a large authenticated bundle through contiguous byte ranges', async () => {
    const bundle = await buildZipBuffer([
      { name: 'public-input.json', content: '{}' },
      { name: 'receipt.json', content: 'receipt' },
    ]);
    const splitAt = Math.floor(bundle.byteLength / 2);
    const first = bundle.subarray(0, splitAt);
    const second = bundle.subarray(splitAt);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(Uint8Array.from(first), {
          status: 206,
          headers: {
            'Content-Range': `bytes 0-${splitAt - 1}/${bundle.byteLength}`,
            'X-Stark-Bundle-Range-Chunk-Size': String(bundle.byteLength),
            ETag: '"bundle-etag"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from(second), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${splitAt}-${bundle.byteLength - 1}/${bundle.byteLength}`,
            ETag: '"bundle-etag"',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const downloaded = await downloadAuthenticatedBundle('https://develop.example/bundle', {
      'X-Session-Capability': 'capability-1',
    });

    expect(downloaded).toEqual(bundle);
    expect(callHeaders(fetchMock, 0).get('Range')).toBe('bytes=0-4194303');
    expect(callHeaders(fetchMock, 1).get('Range')).toBe(`bytes=${splitAt}-${bundle.byteLength - 1}`);
  });

  it('rejects a ranged bundle when a response body length disagrees with Content-Range', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(Uint8Array.from(Buffer.from('x')), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/4', ETag: '"bundle-etag"' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadAuthenticatedBundle('https://develop.example/bundle', {})).rejects.toThrow(/body length/i);
  });

  it('rejects an initial 206 response that exceeds the requested four-MiB range', async () => {
    const oversizedFirstRange = Buffer.alloc(4 * 1024 * 1024 + 1);
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(Uint8Array.from(oversizedFirstRange), {
        status: 206,
        headers: { 'Content-Range': `bytes 0-${oversizedFirstRange.byteLength - 1}/${oversizedFirstRange.byteLength}` },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadAuthenticatedBundle('https://develop.example/bundle', {})).rejects.toThrow(
      /requested.*range|range.*requested/i,
    );
  });

  it('rejects a ranged bundle without an ETag or version identity', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(Uint8Array.from(Buffer.from('ab')), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-1/2' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadAuthenticatedBundle('https://develop.example/bundle', {})).rejects.toThrow(
      /representation identity/i,
    );
  });

  it('rejects a bundle whose declared total exceeds the configured download limit', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(Uint8Array.from(Buffer.from('xx')), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-1/2' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadAuthenticatedBundle('https://develop.example/bundle', {}, { maxTotalBytes: 1 }),
    ).rejects.toThrow(/download limit/i);
  });

  it('rejects an oversized non-range response from Content-Length before accepting its body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(Uint8Array.from(Buffer.from('x')), {
        status: 200,
        headers: { 'Content-Length': '2' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadAuthenticatedBundle('https://develop.example/bundle', {}, { maxTotalBytes: 1 }),
    ).rejects.toThrow(/download limit/i);
  });

  it('stops a non-range response stream when its actual body crosses the download limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1]));
        controller.enqueue(Uint8Array.from([2]));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      downloadAuthenticatedBundle('https://develop.example/bundle', {}, { maxTotalBytes: 1 }),
    ).rejects.toThrow(/download limit/i);
  });

  it.each([
    ['ETag', '"bundle-v1"', '"bundle-v2"'], // operational-versioning-allow: external-version
    ['X-Amz-Version-Id', 'version-1', 'version-2'],
  ])('rejects a ranged bundle when %s changes between chunks', async (headerName, firstIdentity, secondIdentity) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(Uint8Array.from(Buffer.from('ab')), {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-1/4',
            'X-Stark-Bundle-Range-Chunk-Size': '2',
            [headerName]: firstIdentity,
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Uint8Array.from(Buffer.from('cd')), {
          status: 206,
          headers: { 'Content-Range': 'bytes 2-3/4', [headerName]: secondIdentity },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadAuthenticatedBundle('https://develop.example/bundle', {})).rejects.toThrow(
      /representation|ETag|version/i,
    );
  });

  it('rejects a verification run that does not prove a newly queued durable execution', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse({ verificationStatus: 'success', idempotent: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId: `0x${'1'.repeat(64)}`,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
      }),
    ).rejects.toThrow('new durable verification queue work');
  });

  it('rejects a public bundle containing any private artifact filename', async () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const bundle = await buildZipBuffer([
      { name: 'public-input.json', content: '{}' },
      { name: 'verification.json', content: '{}' },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse())
      .mockResolvedValueOnce(
        groupedVerificationResponse(groupedVerificationResource({ status: 'success', expectedImageId })),
      )
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401))
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401))
      .mockResolvedValueOnce(new Response(Uint8Array.from(bundle), { status: 200 }))
      .mockResolvedValueOnce(responseJson({ status: 'success' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
      }),
    ).rejects.toThrow('verification.json');
  });

  it('rejects a public bundle containing a private artifact under a nested path', async () => {
    const expectedImageId = `0x${'1'.repeat(64)}`;
    const bundle = await buildZipBuffer([
      { name: 'public-input.json', content: '{}' },
      { name: 'nested/verification.json', content: '{}' },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(verificationRunResponse())
      .mockResolvedValueOnce(
        groupedVerificationResponse(groupedVerificationResource({ status: 'success', expectedImageId })),
      )
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401))
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_CAPABILITY_INVALID, 401))
      .mockResolvedValueOnce(new Response(Uint8Array.from(bundle), { status: 200 }))
      .mockResolvedValueOnce(responseJson({ status: 'success' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runVerificationAcceptance({
        baseUrl: 'https://develop.example',
        sessionId: 'session-1',
        finalizationId: 'finalization-1',
        expectedImageId,
        expectedTerminalVerificationStatus: 'success',
        authHeaders: { 'X-Session-Capability': 'capability-1' },
        pollDelayMs: 0,
      }),
    ).rejects.toThrow('nested/verification.json');
  });

  it('fails closed when the wrong-capability probe returns an unrelated app error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responseJson({
          data: {
            electionId: 'election-1',
            sessionId: 'session-1',
            capabilityToken: 'capability-1',
          },
        }),
      )
      .mockResolvedValueOnce(errorResponseJson(ErrorCode.SESSION_NOT_FOUND, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runWrongCapabilityCheck('https://develop.example', {})).rejects.toThrow(
      'expected JSON error SESSION_CAPABILITY_INVALID',
    );
  });
});

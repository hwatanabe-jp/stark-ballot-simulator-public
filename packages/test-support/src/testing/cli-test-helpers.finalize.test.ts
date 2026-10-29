import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('./finalization-status-client', async () => {
  const actual = await vi.importActual<typeof import('./finalization-status-client')>('./finalization-status-client');
  return {
    ...actual,
    fetchCurrentFinalization: vi.fn(),
  };
});

import { fetchCurrentFinalization } from './finalization-status-client';
import { CLITestHelpers, getFinalizeTimeoutMs } from './cli-test-helpers';
import { HOST_RESPONSE_TIMEOUT_MS } from '@stark-ballot/node-adapters/zkvm/executor';
import { createTestJournal } from './test-helpers';
import type { FinalizationResource } from '@stark-ballot/api-contract/schemas/finalizations';
import type {
  AvailableVerificationResource,
  VerificationResource,
  VerificationStatus,
} from '@stark-ballot/api-contract/schemas/verification';
import {
  getVerificationStepInputs,
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

const baseUrl = 'http://localhost:3000';
const hash = (character: string): string => `0x${character.repeat(64)}`;
const verificationUrl = `${baseUrl}/api/sessions/session-123/finalizations/finalization-1/verification?include=journal`;

function computeSingleLeafRoot(commitment: string): string {
  return `0x${createHash('sha256')
    .update(Buffer.from([0]))
    .update('stark-ballot:leaf|v1')
    .update(Buffer.from(commitment.slice(2), 'hex'))
    .digest('hex')}`;
}

function buildVerifierResult(status: VerificationStatus): AvailableVerificationResource['verifierResult'] {
  const common = {
    verifier_version: 'test-verifier',
    verified_at: '2026-08-12T00:00:00Z',
    duration_ms: 1,
    expected_image_id: hash('e'),
  } as const;
  switch (status) {
    case 'not_run':
    case 'running':
      return { status };
    case 'success':
      return {
        status,
        report: { status, ...common, receipt_image_id: hash('e'), dev_mode_receipt: false },
      };
    case 'dev_mode':
      return {
        status,
        report: { status, ...common, receipt_image_id: hash('e'), dev_mode_receipt: true },
      };
    case 'failed':
      return {
        status,
        report: {
          status,
          ...common,
          receipt_image_id: null,
          dev_mode_receipt: false,
          errors: ['Verification failed'],
        },
      };
  }
}

function buildSucceededFinalizationResource(options?: {
  finalizationId?: string;
  counts?: { A: number; B: number; C: number; D: number; E: number };
  userCommitment?: string;
}): Extract<FinalizationResource, { status: 'succeeded' }> {
  const counts = options?.counts ?? { A: 1, B: 0, C: 0, D: 0, E: 0 };
  const totalVotes = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const commitment = options?.userCommitment ?? hash('a');
  const bulletinRootAtCast = computeSingleLeafRoot(commitment);
  const baseJournal = createTestJournal({
    totalExpected: totalVotes,
    validVotes: totalVotes,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    seenIndicesCount: totalVotes,
  });
  const journal = {
    ...baseJournal,
    bulletinRoot: totalVotes === 1 ? bulletinRootAtCast : baseJournal.bulletinRoot,
    verifiedTally: [counts.A, counts.B, counts.C, counts.D, counts.E] as [number, number, number, number, number],
  };
  return {
    finalizationId: options?.finalizationId ?? 'finalization-1',
    status: 'succeeded',
    queuedAtMs: 1_700_000_000_000,
    startedAtMs: 1_700_000_000_100,
    completedAtMs: 1_700_000_000_200,
    runtimeDiagnostics: { asyncMode: 'disabled' },
    result: {
      authority: {
        imageId: hash('e'),
        journal,
        receipt: {
          imageId: hash('e'),
          seal: 'mock-receipt',
        },
      },
      presentation: {
        tally: {
          counts,
          totalVotes,
          tamperedCount: 0,
        },
        verifiedTally: [...journal.verifiedTally],
        bulletinRoot: journal.bulletinRoot,
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
        verificationStatus: 'not_run',
        tamperDetected: false,
        scenarios: [],
      },
      voterEvidence: {
        state: 'available',
        voteReceipt: {
          voteId: 'vote-1',
          commitment,
          bulletinIndex: 0,
          bulletinRootAtCast,
          castAtMs: 1_700_000_000_000,
          inputCommitment: journal.inputCommitment,
        },
        userVote: {
          commitment,
          voteId: 'vote-1',
          proof: {
            leafIndex: 0,
            treeSize: 1,
            merklePath: [],
            bulletinRootAtCast,
          },
        },
      },
      artifactAvailability: {
        bundle: 'available',
        report: 'unavailable',
        includedBitmap: 'available',
        seenBitmap: 'available',
      },
    },
  };
}

function buildAvailableVerificationResource(
  options: {
    finalizationId?: string;
    counts?: { A: number; B: number; C: number; D: number; E: number };
    userCommitment?: string;
    verificationStatus?: VerificationStatus;
    checkStatuses?: Partial<Record<VerificationCheckId, VerificationCheck['status']>>;
  } = {},
): AvailableVerificationResource {
  const finalizationId = options.finalizationId ?? 'finalization-1';
  const counts = options.counts ?? { A: 1, B: 0, C: 0, D: 0, E: 0 };
  const commitment = options.userCommitment ?? hash('a');
  const verificationStatus = options.verificationStatus ?? 'success';
  const totalVotes = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const bulletinRootAtCast = computeSingleLeafRoot(commitment);
  const baseJournal = createTestJournal({
    electionId: '00000000-0000-4000-8000-000000000001',
    totalExpected: totalVotes,
    validVotes: totalVotes,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    seenIndicesCount: totalVotes,
  });
  const journal = {
    ...baseJournal,
    bulletinRoot: totalVotes === 1 ? bulletinRootAtCast : baseJournal.bulletinRoot,
    verifiedTally: [counts.A, counts.B, counts.C, counts.D, counts.E] as [number, number, number, number, number],
  };
  const checks = VERIFICATION_CHECK_DEFINITIONS.map((definition): VerificationCheck => ({
    id: definition.id,
    status:
      options.checkStatuses?.[definition.id] ?? (definition.category === 'cast_as_intended' ? 'not_run' : 'success'),
    evidence: definition.evidence,
    inputs: [...definition.inputs],
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));
  const policy = deriveVerificationPresentationPolicy({
    availability: 'available',
    checks,
    context: {
      missingSlots: journal.missingSlots,
      invalidPresentedSlots: journal.invalidPresentedSlots,
      rejectedRecords: journal.rejectedRecords,
      excludedSlots: journal.excludedSlots,
      sthSourcesConfigured: false,
      devModeEvidence: verificationStatus === 'dev_mode',
    },
    verificationStatus,
    verificationReportStatus: verificationStatus,
  });
  const stepIds = ['cast_as_intended', 'recorded_as_cast', 'counted_as_recorded', 'stark_verification'] as const;

  return {
    availability: 'available',
    finalizationId,
    proofAuthority: {
      electionId: journal.electionId,
      electionConfigHash: journal.electionConfigHash,
      logId: hash('9'),
      bulletinRoot: journal.bulletinRoot,
      imageId: hash('e'),
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
        counts,
        totalVotes,
        tamperedCount: 0,
      },
      scenarioId: 'S0',
      tamperDetected: false,
      policy,
    },
    verifierResult: buildVerifierResult(verificationStatus),
    verification: {
      checks,
      steps: stepIds.map((id) => ({
        id,
        status: policy.stageStatuses[id],
        inputs: getVerificationStepInputs(id),
      })),
    },
    voterEvidence: {
      availability: 'available',
      voteReceipt: {
        voteId: 'vote-1',
        commitment,
        bulletinIndex: 0,
        bulletinRootAtCast,
        castAtMs: 1_700_000_000_000,
        inputCommitment: journal.inputCommitment,
      },
      userVote: {
        commitment,
        voteId: 'vote-1',
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: [],
          bulletinRootAtCast,
        },
      },
    },
    journal: {
      representation: 'included',
      value: journal,
    },
  };
}

function buildJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: () => Promise.resolve(payload),
  };
}

type FetchInput = Parameters<typeof fetch>[0];

function extractUrl(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  throw new Error('Unexpected fetch input type');
}

describe('finalization HTTP deadline', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('allows the real host deadline and bounded shutdown to be reported', () => {
    vi.stubEnv('CLI_FINALIZE_TIMEOUT_MS', '600000');
    expect(getFinalizeTimeoutMs({ executor: 'risc0', evidence: 'production' })).toBe(HOST_RESPONSE_TIMEOUT_MS);
    expect(getFinalizeTimeoutMs({ executor: 'risc0', evidence: 'development' })).toBe(HOST_RESPONSE_TIMEOUT_MS);
  });

  it('preserves a longer explicit wait and a short mock wait', () => {
    vi.stubEnv('CLI_FINALIZE_TIMEOUT_MS', '1000000');
    expect(getFinalizeTimeoutMs({ executor: 'risc0', evidence: 'production' })).toBe(1_000_000);
    vi.stubEnv('CLI_FINALIZE_TIMEOUT_MS', '50');
    expect(getFinalizeTimeoutMs({ executor: 'mock', evidence: 'mock' })).toBe(50);
  });

  it('rejects a timer value that Node would truncate or overflow', () => {
    for (const invalid of ['0.5', '2147483648']) {
      vi.stubEnv('CLI_FINALIZE_TIMEOUT_MS', invalid);
      expect(() => getFinalizeTimeoutMs()).toThrow('positive bounded integer');
    }
  });
});

describe('CLITestHelpers.finalizeWithScenarios', () => {
  let helpers: CLITestHelpers;
  let consoleLogSpy: MockInstance<typeof console.log>;
  let expectedSuccessLogCount: number;

  beforeEach(() => {
    vi.resetAllMocks();
    helpers = new CLITestHelpers(baseUrl);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expectedSuccessLogCount = 1;
  });

  afterEach(() => {
    try {
      expect(consoleLogSpy.mock.calls).toEqual(
        Array.from({ length: expectedSuccessLogCount }, () => [
          '[CLI] Finalization succeeded at 2023-11-14T22:13:20.200Z (finalizationId=finalization-1)',
        ]),
      );
    } finally {
      consoleLogSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('sends scenarioId payload for sync finalization', async () => {
    const fetchMock = vi.fn((input: FetchInput, init?: RequestInit) => {
      const url = extractUrl(input);
      if (url === `${baseUrl}/api/sessions`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
            meta: { requestId: 'request-session' },
          }),
        );
      }

      if (url === `${baseUrl}/api/sessions/session-123/finalizations`) {
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
        expect(body).toEqual({ scenarioId: 'S3' });

        const capabilityHeader = new Headers(init?.headers).get('X-Session-Capability');
        expect(capabilityHeader).toBe('capability-token-123');

        return Promise.resolve(
          buildJsonResponse({
            data: buildSucceededFinalizationResource(),
            meta: { requestId: 'request-finalize' },
          }),
        );
      }
      if (url === verificationUrl) {
        const headers = new Headers(init?.headers);
        expect(headers.get('X-Session-Capability')).toBe('capability-token-123');
        return Promise.resolve(
          buildJsonResponse({
            data: buildAvailableVerificationResource(),
            meta: { requestId: 'request-verify' },
          }),
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();
    const result = await helpers.finalizeWithScenarios(sessionId, 'S3');

    expect(result.meta?.mode).toBe('sync');
    expect(result.data.result?.counts).toEqual({ A: 1, B: 0, C: 0, D: 0, E: 0 });
    expect(result.data.receipt).toEqual({
      imageId: hash('e'),
      seal: 'mock-receipt',
    });
    expect(result.data.verificationChecks).toHaveLength(VERIFICATION_CHECK_DEFINITIONS.length);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps finalize payload fields while overlaying verification-specific sync fields', async () => {
    const fetchMock = vi.fn((input: FetchInput) => {
      const url = extractUrl(input);
      if (url === `${baseUrl}/api/sessions`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
            meta: { requestId: 'request-session' },
          }),
        );
      }

      if (url === `${baseUrl}/api/sessions/session-123/finalizations`) {
        return Promise.resolve(
          buildJsonResponse({
            data: buildSucceededFinalizationResource({
              userCommitment: hash('c'),
            }),
            meta: { requestId: 'request-finalize' },
          }),
        );
      }

      if (url === verificationUrl) {
        return Promise.resolve(
          buildJsonResponse({
            data: buildAvailableVerificationResource({
              counts: { A: 9, B: 0, C: 0, D: 0, E: 0 },
              userCommitment: hash('d'),
            }),
            meta: { requestId: 'request-verify' },
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();
    const result = await helpers.finalizeWithScenarios(sessionId, 'S0');
    const tally = result.data.tally;
    if (!tally || typeof tally['bulletinRoot'] !== 'string') {
      throw new Error('Expected projected tally with a bulletin root');
    }
    expect(tally['bulletinRoot']).toMatch(/^0x[0-9a-f]{64}$/);

    expect(tally).toEqual({
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      bulletinRoot: tally['bulletinRoot'],
      totalVotes: 1,
      tamperedCount: 0,
    });
    expect(result.data.userVote).toMatchObject({
      commitment: hash('c'),
      merklePath: [],
      leafIndex: 0,
      treeSize: 1,
    });
    expect(result.data.treeSize).toBe(1);
    expect(result.data.totalExpected).toBe(1);
    expect(result.data.verificationStatus).toBe('success');
    expect(result.data.finalizationId).toBe('finalization-1');
    expect(result.data.verificationChecks).toHaveLength(VERIFICATION_CHECK_DEFINITIONS.length);
    expect(result.data.verificationSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'counted_as_recorded', status: 'success' }),
        expect.objectContaining({ id: 'stark_verification', status: 'success' }),
      ]),
    );
    expect(result.data.presentationPolicy).toMatchObject({
      stageStatuses: {
        cast_as_intended: 'not_run',
        recorded_as_cast: 'success',
        counted_as_recorded: 'success',
        stark_verification: 'success',
      },
      fullyVerifiedLabelEligible: false,
    });
    expect(result.data.journal).toMatchObject({
      methodVersion: CURRENT_METHOD_VERSION,
      electionId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('returns async metadata and refreshes verification for 202 responses', async () => {
    const asyncState = buildSucceededFinalizationResource({ finalizationId: 'finalization-1' });

    const fetchMock = vi.fn((input: FetchInput, init?: RequestInit) => {
      const url = extractUrl(input);
      if (url === `${baseUrl}/api/sessions`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
            meta: { requestId: 'request-session' },
          }),
        );
      }

      if (url === `${baseUrl}/api/sessions/session-123/finalizations`) {
        const capabilityHeader = new Headers(init?.headers).get('X-Session-Capability');
        expect(capabilityHeader).toBe('capability-token-123');

        return Promise.resolve(
          buildJsonResponse(
            {
              data: asyncState,
              meta: { requestId: 'request-finalize' },
            },
            202,
          ),
        );
      }

      if (url === verificationUrl) {
        const capabilityHeader = new Headers(init?.headers).get('X-Session-Capability');
        expect(capabilityHeader).toBe('capability-token-123');

        return Promise.resolve(
          buildJsonResponse({
            data: buildAvailableVerificationResource(),
            meta: { requestId: 'request-verify' },
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();
    const result = await helpers.finalizeWithScenarios(sessionId, 'S0');

    expect(result.meta?.mode).toBe('async');
    expect(result.meta?.finalizationId).toBe('finalization-1');
    expect(result.meta?.finalizationState.status).toBe('succeeded');
    expect(result.meta?.finalizationHistory?.length).toBe(1);
    expect(fetchCurrentFinalization).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: 'unavailable',
      resource: {
        availability: 'unavailable',
        finalizationId: 'finalization-1',
        reason: 'finalization_not_current',
        message: 'Finalization is not current',
      } satisfies VerificationResource,
      expectedError: /verification result is unavailable/i,
    },
    {
      name: 'corrupt',
      resource: {
        availability: 'corrupt',
        finalizationId: 'finalization-1',
        reason: 'invalid_artifact',
        message: 'Invalid finalization artifact',
      } satisfies VerificationResource,
      expectedError: /verification result is corrupt/i,
    },
    {
      name: 'malformed',
      resource: {
        availability: 'available',
        finalizationId: 'finalization-1',
        verificationStatus: 'success',
      },
      expectedError: /invalid verification result response/i,
    },
    {
      name: 'finalization-mismatched',
      resource: buildAvailableVerificationResource({
        finalizationId: 'different-finalization',
      }),
      expectedError: /verification finalization identity mismatch/i,
    },
  ])('rejects a $name verification resource', async ({ resource, expectedError }) => {
    const fetchMock = vi.fn((input: FetchInput) => {
      const url = extractUrl(input);
      if (url === `${baseUrl}/api/sessions`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
            meta: { requestId: 'request-session' },
          }),
        );
      }
      if (url === `${baseUrl}/api/sessions/session-123/finalizations`) {
        return Promise.resolve(
          buildJsonResponse({
            data: buildSucceededFinalizationResource(),
            meta: { requestId: 'request-finalize' },
          }),
        );
      }
      if (url === verificationUrl) {
        return Promise.resolve(
          buildJsonResponse({
            data: resource,
            meta: { requestId: 'request-verify' },
          }),
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();

    await expect(helpers.finalizeWithScenarios(sessionId, 'S0')).rejects.toThrow(expectedError);
  });

  it('does not retain a prior available payload when a later read is unavailable', async () => {
    expectedSuccessLogCount = 2;
    let verificationReads = 0;
    const fetchMock = vi.fn((input: FetchInput) => {
      const url = extractUrl(input);
      if (url === `${baseUrl}/api/sessions`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
            meta: { requestId: 'request-session' },
          }),
        );
      }
      if (url === `${baseUrl}/api/sessions/session-123/finalizations`) {
        return Promise.resolve(
          buildJsonResponse({
            data: buildSucceededFinalizationResource(),
            meta: { requestId: 'request-finalize' },
          }),
        );
      }
      if (url === verificationUrl) {
        verificationReads += 1;
        const resource: VerificationResource =
          verificationReads === 1
            ? buildAvailableVerificationResource()
            : {
                availability: 'unavailable',
                finalizationId: 'finalization-1',
                reason: 'finalization_not_current',
                message: 'Finalization is not current',
              };
        return Promise.resolve(
          buildJsonResponse({
            data: resource,
            meta: { requestId: `request-verify-${verificationReads}` },
          }),
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();
    const firstResult = await helpers.finalizeWithScenarios(sessionId, 'S0');
    expect(firstResult.data.verificationStatus).toBe('success');

    await expect(helpers.finalizeWithScenarios(sessionId, 'S0')).rejects.toThrow(/verification result is unavailable/i);
  });
});

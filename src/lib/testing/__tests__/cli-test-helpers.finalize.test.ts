import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/finalize/finalization-status-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/finalize/finalization-status-client')>(
    '@/lib/finalize/finalization-status-client',
  );
  return {
    ...actual,
    fetchFinalizationStatus: vi.fn(),
  };
});

import { fetchFinalizationStatus } from '@/lib/finalize/finalization-status-client';
import { CLITestHelpers } from '../cli-test-helpers';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';

const baseUrl = 'http://localhost:3000';

function buildJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  };
}

function extractUrl(input: RequestInfo | URL): string {
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

describe('CLITestHelpers.finalizeWithScenarios', () => {
  let helpers: CLITestHelpers;

  beforeEach(() => {
    helpers = new CLITestHelpers(baseUrl);
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends scenarioId payload for sync finalization', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = extractUrl(input);
      if (url === `${baseUrl}/api/session`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
          }),
        );
      }

      if (url === `${baseUrl}/api/finalize`) {
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
        expect(body).toEqual({ scenarioId: 'S3' });

        const headerValue =
          init?.headers instanceof Headers
            ? init.headers.get('X-Session-ID')
            : (init?.headers as Record<string, string> | undefined)?.['X-Session-ID'];
        expect(headerValue).toBe('session-123');

        const capabilityHeader =
          init?.headers instanceof Headers
            ? init.headers.get('X-Session-Capability')
            : (init?.headers as Record<string, string> | undefined)?.['X-Session-Capability'];
        expect(capabilityHeader).toBe('capability-token-123');

        return Promise.resolve(
          buildJsonResponse({
            data: {
              result: {
                counts: { A: 1 },
                bulletinRoot: '0xroot',
              },
              receipt: { seal: 'mock-receipt' },
            },
          }),
        );
      }
      if (url === `${baseUrl}/api/verify?includeJournal=1`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              verificationSteps: [
                {
                  id: 'counted_as_recorded',
                  status: 'success',
                  inputs: [],
                },
                {
                  id: 'stark_verification',
                  status: 'success',
                  inputs: [],
                },
              ],
              verificationChecks: [
                {
                  id: 'counted_expected_vs_tree_size',
                  status: 'success',
                  evidence: 'public',
                  inputs: ['totalExpected', 'treeSize'],
                },
                {
                  id: 'counted_election_manifest_consistent',
                  status: 'success',
                  evidence: 'public',
                  inputs: ['electionManifest'],
                },
                {
                  id: 'counted_close_statement_consistent',
                  status: 'success',
                  evidence: 'public',
                  inputs: ['closeStatement'],
                },
                {
                  id: 'stark_receipt_verify',
                  status: 'success',
                  evidence: 'zk',
                  inputs: ['proofBundleStatus'],
                },
              ],
              journal: {
                electionId: 'election-123',
                electionConfigHash: '0x' + '1'.repeat(64),
                bulletinRoot: '0x' + '2'.repeat(64),
                treeSize: 1,
                totalExpected: 1,
                sthDigest: '0x' + '3'.repeat(64),
                verifiedTally: [1, 0, 0, 0, 0],
                totalVotes: 1,
                validVotes: 1,
                invalidVotes: 0,
                seenIndicesCount: 1,
                missingSlots: 0,
                invalidPresentedSlots: 0,
                rejectedRecords: 0,
                seenBitmapRoot: '0x' + '6'.repeat(64),
                includedBitmapRoot: '0x' + '4'.repeat(64),
                excludedSlots: 0,
                inputCommitment: '0x' + '5'.repeat(64),
                methodVersion: CURRENT_METHOD_VERSION,
              },
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();
    const result = await helpers.finalizeWithScenarios(sessionId, 'S3');

    expect(result.meta?.mode).toBe('sync');
    expect(result.data.result?.counts).toEqual({ A: 1 });
    expect(result.data.receipt).toEqual({ seal: 'mock-receipt' });
    expect(result.data.verificationChecks).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps finalize payload fields while overlaying verification-specific sync fields', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = extractUrl(input);
      if (url === `${baseUrl}/api/session`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
          }),
        );
      }

      if (url === `${baseUrl}/api/finalize`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              tally: {
                counts: { A: 1 },
                bulletinRoot: '0xfinalize-root',
                totalVotes: 1,
                tamperedCount: 0,
              },
              userVote: {
                commitment: '0xfinalize-commit',
                merklePath: ['0xfinalize-path'],
                leafIndex: 3,
                treeSize: 7,
              },
              treeSize: 7,
              totalExpected: 7,
              verificationStatus: 'not_run',
            },
          }),
        );
      }

      if (url === `${baseUrl}/api/verify?includeJournal=1`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              tally: {
                counts: { A: 9 },
                bulletinRoot: '0xverify-root',
                totalVotes: 9,
                tamperedCount: 9,
              },
              userVote: {
                commitment: '0xverify-commit',
                merklePath: ['0xverify-path'],
                leafIndex: 9,
                treeSize: 99,
              },
              treeSize: 99,
              totalExpected: 99,
              verificationStatus: 'success',
              verificationSteps: [
                {
                  id: 'counted_as_recorded',
                  status: 'success',
                  inputs: [],
                },
                {
                  id: 'stark_verification',
                  status: 'success',
                  inputs: [],
                },
              ],
              verificationChecks: [
                {
                  id: 'counted_expected_vs_tree_size',
                  status: 'success',
                  evidence: 'public',
                  inputs: ['totalExpected', 'treeSize'],
                },
                {
                  id: 'counted_election_manifest_consistent',
                  status: 'success',
                  evidence: 'public',
                  inputs: ['electionManifest'],
                },
                {
                  id: 'counted_close_statement_consistent',
                  status: 'success',
                  evidence: 'public',
                  inputs: ['closeStatement'],
                },
                {
                  id: 'stark_receipt_verify',
                  status: 'success',
                  evidence: 'zk',
                  inputs: ['proofBundleStatus'],
                },
              ],
              verificationExecutionId: 'verify-exec-1',
              journal: {
                methodVersion: CURRENT_METHOD_VERSION,
              },
            },
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();
    const result = await helpers.finalizeWithScenarios(sessionId, 'S0');

    expect(result.data.tally).toEqual({
      counts: { A: 1 },
      bulletinRoot: '0xfinalize-root',
      totalVotes: 1,
      tamperedCount: 0,
    });
    expect(result.data.userVote).toEqual({
      commitment: '0xfinalize-commit',
      merklePath: ['0xfinalize-path'],
      leafIndex: 3,
      treeSize: 7,
    });
    expect(result.data.treeSize).toBe(7);
    expect(result.data.totalExpected).toBe(7);
    expect(result.data.verificationStatus).toBe('success');
    expect(result.data.verificationExecutionId).toBe('verify-exec-1');
    expect(result.data.verificationChecks).toHaveLength(4);
    expect(result.data.journal).toEqual({ methodVersion: CURRENT_METHOD_VERSION });
  });

  it('returns async metadata and refreshes verification for 202 responses', async () => {
    const asyncState = {
      status: 'succeeded',
      executionId: 'exec-1',
      queuedAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_100,
      completedAt: 1_700_000_000_200,
    };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = extractUrl(input);
      if (url === `${baseUrl}/api/session`) {
        return Promise.resolve(
          buildJsonResponse({
            data: {
              sessionId: 'session-123',
              electionId: 'election-123',
              capabilityToken: 'capability-token-123',
            },
          }),
        );
      }

      if (url === `${baseUrl}/api/finalize`) {
        const capabilityHeader =
          init?.headers instanceof Headers
            ? init.headers.get('X-Session-Capability')
            : (init?.headers as Record<string, string> | undefined)?.['X-Session-Capability'];
        expect(capabilityHeader).toBe('capability-token-123');

        return Promise.resolve(
          buildJsonResponse(
            {
              executionId: 'exec-1',
              state: asyncState,
            },
            202,
          ),
        );
      }

      if (url === `${baseUrl}/api/verify?includeJournal=1`) {
        const sessionHeader =
          init?.headers instanceof Headers
            ? init.headers.get('X-Session-ID')
            : (init?.headers as Record<string, string> | undefined)?.['X-Session-ID'];
        expect(sessionHeader).toBe('session-123');

        const capabilityHeader =
          init?.headers instanceof Headers
            ? init.headers.get('X-Session-Capability')
            : (init?.headers as Record<string, string> | undefined)?.['X-Session-Capability'];
        expect(capabilityHeader).toBe('capability-token-123');

        return Promise.resolve(
          buildJsonResponse({
            data: {
              result: {
                counts: { A: 2 },
                bulletinRoot: '0xroot',
              },
              journal: {
                methodVersion: CURRENT_METHOD_VERSION,
              },
            },
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const sessionId = await helpers.createSession();
    const result = await helpers.finalizeWithScenarios(sessionId, 'S0');

    expect(result.meta?.mode).toBe('async');
    expect(result.meta?.executionId).toBe('exec-1');
    expect(result.meta?.finalizationState?.status).toBe('succeeded');
    expect(result.meta?.finalizationHistory?.length).toBe(1);
    expect(fetchFinalizationStatus).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

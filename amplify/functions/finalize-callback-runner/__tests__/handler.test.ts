/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCurrentContractGeneration } from '../../../../src/lib/contract/index.js';
import { createTestPublicInputArtifact } from '../../../../src/lib/testing/public-input-artifact.js';
import { createTestJournal } from '../../../../src/lib/testing/test-helpers.js';
import {
  parseStoredFinalizationPayload,
  serializeStoredFinalizationPayload,
} from '../../../../src/lib/store/amplify/finalization.js';

const signedAppSyncFetchMock = vi.fn();
const createAppSyncSignerMock = vi.fn(() => ({ sign: vi.fn() }));
const restoreReceiptFromS3Mock = vi.fn();
const generateBundlePresignedUrlMock = vi.fn();

vi.mock('../../../../src/lib/aws/appsyncSignedFetch.js', () => ({
  createAppSyncSigner: createAppSyncSignerMock,
  signedAppSyncFetch: signedAppSyncFetchMock,
}));

vi.mock('../../../../src/lib/aws/appsyncRegionResolver.js', () => ({
  resolveAppSyncRegion: vi.fn(() => 'ap-northeast-1'),
}));

vi.mock('../../../../src/lib/aws/bundle-restore.js', () => ({
  restoreReceiptFromS3: restoreReceiptFromS3Mock,
}));

vi.mock('../../../../src/lib/aws/presigned-url.js', () => ({
  generateBundlePresignedUrl: generateBundlePresignedUrlMock,
}));

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn(() => ({})),
}));

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('finalize-callback-runner handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      AMPLIFY_DATA_ENDPOINT: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
      AMPLIFY_DATA_TTL_SECONDS: '300',
      AMPLIFY_DATA_VERIFICATION_TTL_SECONDS: '7200',
    };
    generateBundlePresignedUrlMock.mockResolvedValue({
      success: true,
      url: 'https://example.com/bundle.zip',
      expiresAt: '2026-04-21T00:00:00.000Z',
    });
  });

  it('persists restored publicInputArtifact on successful callback completion', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-123';
    const contractGeneration = resolveCurrentContractGeneration();
    const queuedAt = 1730000000000;
    const s3BundleKey = `sessions/${sessionId}/${executionId}/bundle.zip`;
    const journal = createTestJournal({
      electionId: sessionId,
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
    });
    const publicInputArtifact = createTestPublicInputArtifact({
      source: 'bundle',
      executionId,
      bundleKey: s3BundleKey,
      typedAuthority: {
        electionId: journal.electionId,
        electionConfigHash: journal.electionConfigHash,
        bulletinRoot: journal.bulletinRoot,
        treeSize: journal.treeSize,
        totalExpected: journal.totalExpected,
        votesCount: 1,
        logId: '0x' + '3'.repeat(64),
        timestamp: 123,
        methodVersion: journal.methodVersion,
        recomputedInputCommitment: journal.inputCommitment,
      },
    });

    const currentPayload = serializeStoredFinalizationPayload({
      contractGeneration,
      finalizationResult: null,
      finalizationState: {
        status: 'running',
        executionId,
        queuedAt,
        startedAt: queuedAt + 1000,
      },
      finalizationScenarioContext: null,
    });

    let capturedUpdateInput: Record<string, unknown> | undefined;
    signedAppSyncFetchMock.mockImplementation(async ({ body }: { body: string }) => {
      const request = JSON.parse(body) as {
        query: string;
        variables: Record<string, unknown>;
      };

      if (request.query.includes('getVotingSession')) {
        return jsonResponse({
          data: {
            getVotingSession: {
              id: sessionId,
              contractGeneration,
              finalizationArtifactState: null,
              finalized: false,
              finalizationResultJson: currentPayload,
            },
          },
        });
      }

      if (request.query.includes('updateVotingSession')) {
        capturedUpdateInput = request.variables.input as Record<string, unknown>;
        return jsonResponse({
          data: {
            updateVotingSession: {
              id: sessionId,
              finalizationResultJson: request.variables.input.finalizationResultJson,
              finalized: request.variables.input.finalized,
            },
          },
        });
      }

      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    });

    restoreReceiptFromS3Mock.mockResolvedValue({
      receipt: {
        seal: 'base64-seal',
        journal: { bytes: [1, 2, 3] },
        imageId: journal.imageId,
      },
      receiptRaw: {
        receipt: {
          seal: 'base64-seal',
        },
        imageId: journal.imageId,
      },
      journal,
      publicInputArtifact,
    });

    const { handler } = await import('../handler.js');
    const response = await handler({
      status: 'SUCCEEDED',
      payload: {
        sessionId,
        executionId,
        contractGeneration,
        queuedAt,
      },
      proverResult: {
        StartedAt: queuedAt + 1000,
        ExecutionStoppedAt: queuedAt + 2000,
      },
    });

    expect(response).toEqual({ status: 'ok', sessionId, executionId });
    expect(capturedUpdateInput?.finalized).toBe(true);

    const persisted = parseStoredFinalizationPayload(capturedUpdateInput?.finalizationResultJson);
    expect(persisted?.contractGeneration).toBe(contractGeneration);
    expect(persisted?.finalizationResult?.publicInputArtifact).toEqual(publicInputArtifact);
    expect(persisted?.finalizationResult?.verificationExecutionId).toBe(executionId);
  });

  it('tombstones the finalized artifact when bundle restore lacks authoritative public input', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const executionId = 'exec-missing-public-input';
    const contractGeneration = resolveCurrentContractGeneration();
    const queuedAt = 1730000000000;
    const currentPayload = serializeStoredFinalizationPayload({
      contractGeneration,
      finalizationResult: null,
      finalizationState: {
        status: 'running',
        executionId,
        queuedAt,
        startedAt: queuedAt + 1000,
      },
      finalizationScenarioContext: null,
    });

    const updateInputs: Record<string, unknown>[] = [];
    signedAppSyncFetchMock.mockImplementation(async ({ body }: { body: string }) => {
      const request = JSON.parse(body) as {
        query: string;
        variables: Record<string, unknown>;
      };

      if (request.query.includes('getVotingSession')) {
        return jsonResponse({
          data: {
            getVotingSession: {
              id: sessionId,
              contractGeneration,
              finalizationArtifactState: null,
              finalized: false,
              finalizationResultJson: currentPayload,
            },
          },
        });
      }

      if (request.query.includes('updateVotingSession')) {
        updateInputs.push(request.variables.input as Record<string, unknown>);
        return jsonResponse({
          data: {
            updateVotingSession: {
              id: sessionId,
              finalizationResultJson: request.variables.input.finalizationResultJson,
              finalized: request.variables.input.finalized,
            },
          },
        });
      }

      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    });

    const journal = createTestJournal({
      electionId: sessionId,
      totalExpected: 1,
      validVotes: 1,
      missingIndices: 0,
      invalidIndices: 0,
    });

    restoreReceiptFromS3Mock.mockResolvedValue({
      receipt: {
        seal: 'base64-seal',
        journal: { bytes: [1, 2, 3] },
        imageId: journal.imageId,
      },
      receiptRaw: {
        receipt: {
          seal: 'base64-seal',
        },
        imageId: journal.imageId,
      },
      journal,
      publicInputArtifact: undefined,
    });

    const { handler } = await import('../handler.js');
    const response = await handler({
      status: 'SUCCEEDED',
      payload: {
        sessionId,
        executionId,
        contractGeneration,
        queuedAt,
      },
      proverResult: {
        StartedAt: queuedAt + 1000,
        ExecutionStoppedAt: queuedAt + 2000,
      },
    });

    expect(response).toEqual({ status: 'ok', sessionId, executionId });
    expect(updateInputs).toHaveLength(1);
    expect(updateInputs[0]?.finalizationArtifactState).toBe('corrupt_or_unreadable');
    expect(updateInputs[0]?.finalized).toBeUndefined();
    expect(updateInputs[0]?.finalizationResultJson).toBeUndefined();
  });
});

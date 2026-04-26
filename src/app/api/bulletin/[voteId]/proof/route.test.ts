import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getGlobalStore } from '@/lib/store/storeInstance';
import { createMockVoteStore } from '@/lib/testing/mockVoteStore';
import { readJsonRecord } from '@/lib/testing/response-helpers';
import { getNumberProperty, getRecordProperty, getStringProperty, isRecord } from '@/lib/utils/guards';
import type { SessionData, VoteData } from '@/types/server';
import type { VoteStore } from '@/types/voteStore';
import { SESSION_CAPABILITY_HEADER } from '@/lib/session/capability';
import { createTestSessionCapabilityToken, setTestSessionCapabilitySecret } from '@/lib/testing/sessionCapability';
import { createTestJournal } from '@/lib/testing/test-helpers';
import { createTestPublicInputArtifact } from '@/lib/testing/public-input-artifact';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';
import { resolveCurrentContractGeneration } from '@/lib/contract';

// Mock dependencies
vi.mock('@/lib/store/storeInstance');

describe('GET /api/bulletin/[voteId]/proof', () => {
  let mockStore: VoteStore;
  let getVoteByIdWithProofMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getVoteByIdWithProof']>>>;
  let getSessionMock: ReturnType<typeof vi.fn<NonNullable<VoteStore['getSession']>>>;

  const buildVote = (voteId: string): VoteData => ({
    voteId,
    vote: 'A',
    rand: '0x' + '1'.repeat(64),
    commit: '0x' + '2'.repeat(64),
    path: [],
  });

  const buildSession = (overrides: Partial<SessionData> = {}): SessionData => {
    const { finalizationResult: finalizationResultOverride, ...sessionOverrides } = overrides;
    const now = Date.now();
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
    const baseFinalizationResult = {
      tally: {
        counts: { A: 0, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 0,
        tamperedCount: 0,
      },
      imageId: '0x' + '1'.repeat(64),
      journal,
      publicInputArtifact: createTestPublicInputArtifact({
        executionId: 'exec-bulletin-proof-test',
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
      }),
      electionManifest,
      closeStatement,
      scenarios: ['S3'],
      verificationExecutionId: 'exec-bulletin-proof-test',
      tamperSummary: {
        ignoredVotes: 0,
        recountedVotes: 0,
        userRecountedTo: null,
        affectedBotIds: [1],
      },
    };
    const userVoteId =
      overrides.votes instanceof Map ? (overrides.votes.get(0)?.voteId ?? 'user-vote-id') : 'user-vote-id';
    const votes =
      overrides.votes instanceof Map
        ? overrides.votes
        : new Map([
            [0, buildVote(userVoteId)],
            [1, buildVote('bot-vote-id')],
          ]);
    const session: SessionData = {
      sessionId: 'session-123',
      contractGeneration: resolveCurrentContractGeneration(),
      votes,
      botCount: 1,
      finalized: true,
      createdAt: now,
      lastActivity: now,
      userVoteIndex: 0,
      finalizationResult:
        finalizationResultOverride === undefined
          ? baseFinalizationResult
          : {
              ...baseFinalizationResult,
              ...finalizationResultOverride,
            },
      ...sessionOverrides,
    };

    if (session.finalized && session.finalizationContractGeneration === undefined) {
      session.finalizationContractGeneration = resolveCurrentContractGeneration();
    }

    return session;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setTestSessionCapabilitySecret();

    // Setup mock store
    getVoteByIdWithProofMock = vi.fn<NonNullable<VoteStore['getVoteByIdWithProof']>>();
    getSessionMock = vi.fn<NonNullable<VoteStore['getSession']>>();
    mockStore = createMockVoteStore({
      getVoteByIdWithProof: getVoteByIdWithProofMock,
      getSession: getSessionMock,
    });

    vi.mocked(getGlobalStore).mockReturnValue(mockStore);
  });

  describe('Minimal data retrieval', () => {
    it('should return only necessary proof data (O(log n) size)', async () => {
      // Arrange
      const voteId = '550e8400-e29b-41d4-a716-446655440000';
      const mockProof = {
        leafIndex: 42,
        merklePath: ['0x' + 'a'.repeat(64), '0x' + 'b'.repeat(64), '0x' + 'c'.repeat(64)],
        bulletinRootAtCast: '0x' + 'd'.repeat(64),
        treeSize: 43,
      };

      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote(voteId)]]) }));
      getVoteByIdWithProofMock.mockResolvedValue({
        voteData: buildVote(voteId),
        leafIndex: mockProof.leafIndex,
        merklePath: mockProof.merklePath,
        bulletinRootAtCast: mockProof.bulletinRootAtCast,
        treeSize: mockProof.treeSize,
      });

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      // Act
      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');
      const proof = getRecordProperty(payload, 'proof');

      // Assert
      expect(response.status).toBe(200);
      expect(getStringProperty(payload, 'voteId')).toBe(voteId);
      expect(proof).toBeDefined();
      expect(getNumberProperty(proof, 'leafIndex')).toBe(42);
      const merklePath = isRecord(proof) && Array.isArray(proof.merklePath) ? proof.merklePath : [];
      expect(merklePath).toHaveLength(3); // O(log n) size
      expect(getStringProperty(proof, 'bulletinRootAtCast')).toBeDefined();
      expect(getNumberProperty(proof, 'treeSize')).toBe(43);

      // Should NOT include full vote data
      expect(payload).not.toHaveProperty('commitment');
      expect(payload).not.toHaveProperty('choice');
      expect(payload).not.toHaveProperty('random');
    });

    it('should normalize proof fields to canonical hex', async () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440009';
      const rawMerklePath = ['A', '0xB'];
      const rawRootAtCast = 'ABC';
      const expectedMerklePath = [`0x${'0'.repeat(63)}a`, `0x${'0'.repeat(63)}b`];
      const expectedRootAtCast = `0x${'0'.repeat(61)}abc`;

      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote(voteId)]]) }));
      getVoteByIdWithProofMock.mockResolvedValue({
        voteData: buildVote(voteId),
        leafIndex: 0,
        merklePath: rawMerklePath,
        bulletinRootAtCast: rawRootAtCast,
        treeSize: 1,
      });

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');
      const proof = getRecordProperty(payload, 'proof');
      const merklePath = isRecord(proof) && Array.isArray(proof.merklePath) ? proof.merklePath : [];

      expect(response.status).toBe(200);
      expect(getStringProperty(proof, 'bulletinRootAtCast')).toBe(expectedRootAtCast);
      expect(merklePath).toEqual(expectedMerklePath);
    });

    it('should handle non-existent vote ID', async () => {
      // Arrange
      const voteId = 'non-existent-id';
      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote('other-vote-id')]]) }));

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      // Act
      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      // Assert
      expect(response.status).toBe(404);
      expect(getStringProperty(payload, 'error')).toBe('VOTE_NOT_FOUND');
    });

    it('fails closed when the exact CT proof is unavailable', async () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440126';
      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote(voteId)]]) }));
      getVoteByIdWithProofMock.mockRejectedValue(new Error('CT_PROOF_UNAVAILABLE'));

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toBe('VERIFICATION_FAILED');
    });

    it('fails closed when the session owns the vote but proof reconstruction returns null', async () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440128';
      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote(voteId)]]) }));
      getVoteByIdWithProofMock.mockResolvedValue(null);

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toBe('VERIFICATION_FAILED');
    });

    it('should require session ID', async () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440123';
      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`);

      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toBe('SESSION_ID_REQUIRED');
    });

    it('should require session capability token', async () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440127';
      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
        },
      });

      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      expect(response.status).toBe(401);
      expect(getStringProperty(payload, 'error')).toBe('SESSION_CAPABILITY_REQUIRED');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('should reject non-finalized sessions', async () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440124';
      getSessionMock.mockResolvedValue(
        buildSession({
          finalized: false,
          finalizationContractGeneration: undefined,
          finalizationResult: undefined,
          votes: new Map([[0, buildVote(voteId)]]),
        }),
      );

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      expect(response.status).toBe(404);
      expect(getStringProperty(payload, 'error')).toBe('SESSION_NOT_FOUND');
    });

    it('fails closed when finalized proof state is marked corrupt', async () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440126';
      getSessionMock.mockResolvedValue(
        buildSession({
          finalizationArtifactState: 'corrupt_or_unreadable',
          votes: new Map([[0, buildVote(voteId)]]),
        }),
      );

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      expect(response.status).toBe(500);
      expect(getStringProperty(payload, 'error')).toBe('CORRUPT_OR_UNREADABLE_FINALIZED_STATE');
      expect(getStringProperty(payload, 'artifactState')).toBe('corrupt_or_unreadable');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('should reject voteId not owned by the session or affected bots', async () => {
      const voteId = '550e8400-e29b-41d4-a716-446655440125';
      const session = buildSession({
        votes: new Map([
          [0, buildVote('user-vote-id')],
          [1, buildVote('bot-vote-id')],
        ]),
      });
      getSessionMock.mockResolvedValue(session);

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      expect(response.status).toBe(404);
      expect(getStringProperty(payload, 'error')).toBe('VOTE_NOT_FOUND');
      expect(getVoteByIdWithProofMock).not.toHaveBeenCalled();
    });
  });

  describe('Performance requirements', () => {
    it('should retrieve proof in less than 10ms for small datasets', async () => {
      // Arrange
      const voteId = '550e8400-e29b-41d4-a716-446655440001';
      const mockProof = {
        leafIndex: 10,
        merklePath: ['0x' + 'e'.repeat(64), '0x' + 'f'.repeat(64)],
        bulletinRootAtCast: '0x' + '1'.repeat(64),
        treeSize: 11,
      };

      // Simulate fast retrieval
      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote(voteId)]]) }));
      getVoteByIdWithProofMock.mockImplementation(() =>
        Promise.resolve({
          voteData: buildVote(voteId),
          leafIndex: mockProof.leafIndex,
          merklePath: mockProof.merklePath,
          bulletinRootAtCast: mockProof.bulletinRootAtCast,
          treeSize: mockProof.treeSize,
        }),
      );

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      // Act
      const startTime = performance.now();
      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const endTime = performance.now();
      const duration = endTime - startTime;

      // Assert
      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(10); // Should be < 10ms
    });

    it('should retrieve proof in O(log n) time for large datasets', async () => {
      // Arrange - Simulate 1024 votes (depth 10)
      const voteId = '550e8400-e29b-41d4-a716-446655440002';
      const depth = 10; // log2(1024) = 10
      const mockProof = {
        leafIndex: 512,
        merklePath: Array(depth)
          .fill(0)
          .map((_, i) => '0x' + i.toString(16).padStart(64, '0')),
        bulletinRootAtCast: '0x' + '2'.repeat(64),
        treeSize: 513,
      };

      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote(voteId)]]) }));
      getVoteByIdWithProofMock.mockResolvedValue({
        voteData: buildVote(voteId),
        leafIndex: mockProof.leafIndex,
        merklePath: mockProof.merklePath,
        bulletinRootAtCast: mockProof.bulletinRootAtCast,
        treeSize: mockProof.treeSize,
      });

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      // Act
      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');
      const proof = getRecordProperty(payload, 'proof');
      const merklePath = isRecord(proof) && Array.isArray(proof.merklePath) ? proof.merklePath : [];

      // Assert
      expect(response.status).toBe(200);
      expect(merklePath).toHaveLength(depth); // O(log n) proof size
    });
  });

  describe('Cache headers', () => {
    it('should be private and non-cacheable for session-scoped data', async () => {
      // Arrange
      const voteId = '550e8400-e29b-41d4-a716-446655440003';
      const mockProof = {
        leafIndex: 5,
        merklePath: ['0x' + '3'.repeat(64)],
        bulletinRootAtCast: '0x' + '4'.repeat(64),
        treeSize: 6,
      };

      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote(voteId)]]) }));
      getVoteByIdWithProofMock.mockResolvedValue({
        voteData: buildVote(voteId),
        leafIndex: mockProof.leafIndex,
        merklePath: mockProof.merklePath,
        bulletinRootAtCast: mockProof.bulletinRootAtCast,
        treeSize: mockProof.treeSize,
      });

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      // Act
      const response = await GET(request, { params: Promise.resolve({ voteId }) });

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Vary')).toBe('X-Session-ID, X-Session-Capability');
      expect(response.headers.get('ETag')).toBeNull();
    });

    it('should keep unauthorized responses non-cacheable', async () => {
      // Arrange
      const voteId = '550e8400-e29b-41d4-a716-446655440004';
      getSessionMock.mockResolvedValue(buildSession({ votes: new Map([[0, buildVote('different-vote-id')]]) }));

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${voteId}/proof`, {
        headers: {
          'X-Session-ID': 'session-123',
          [SESSION_CAPABILITY_HEADER]: createTestSessionCapabilityToken('session-123'),
        },
      });

      // Act
      const response = await GET(request, { params: Promise.resolve({ voteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      // Assert
      expect(response.status).toBe(404);
      expect(getStringProperty(payload, 'error')).toBe('VOTE_NOT_FOUND');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });
  });

  describe('Invalid input handling', () => {
    it('should validate vote ID format', async () => {
      // Arrange
      const invalidVoteId = 'invalid-format';

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${invalidVoteId}/proof`);

      // Act
      const response = await GET(request, { params: Promise.resolve({ voteId: invalidVoteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      // Assert
      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toBe('INVALID_VOTE_ID');
    });

    it('should handle malformed vote IDs gracefully', async () => {
      // Arrange
      const malformedVoteId = '../../../etc/passwd';

      const request = new NextRequest(`http://localhost:3000/api/bulletin/${malformedVoteId}/proof`);

      // Act
      const response = await GET(request, { params: Promise.resolve({ voteId: malformedVoteId }) });
      const payload = await readJsonRecord(response, 'bulletin proof response');

      // Assert
      expect(response.status).toBe(400);
      expect(getStringProperty(payload, 'error')).toBe('INVALID_VOTE_ID');
    });
  });
});

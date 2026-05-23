/**
 * Tests for consistency proof verification
 * Following RFC 6962 Certificate Transparency specification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyConsistencyProof, checkCompleteness, validateVotingIntegrity } from '../consistency-verifier';
import type { ConsistencyProofResponse } from '@/lib/types/api/consistency-proof';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import type { VoteReceipt } from '@/types/receipt';
import { RFC6962MerkleTree } from '@/lib/merkle/rfc6962-merkle-tree';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';
import { createTestJournal } from '@/lib/testing/test-helpers';

const verifyConsistencyProofMock = vi
  .spyOn(RFC6962MerkleTree.prototype, 'verifyConsistencyProof')
  .mockReturnValue(true);

const fetchMock = vi.fn();

describe('consistency-verifier', () => {
  type JournalOverrides = Partial<ZkVMJournal> & {
    missingIndices?: number;
    invalidIndices?: number;
    countedIndices?: number;
    excludedCount?: number;
  };

  const createJournal = (overrides: JournalOverrides = {}): ZkVMJournal => ({
    ...(() => {
      const canonicalOverrides: Partial<ZkVMJournal> = { ...overrides };
      delete (canonicalOverrides as Record<string, unknown>).missingIndices;
      delete (canonicalOverrides as Record<string, unknown>).invalidIndices;
      delete (canonicalOverrides as Record<string, unknown>).countedIndices;
      delete (canonicalOverrides as Record<string, unknown>).excludedCount;

      const baseJournal: ZkVMJournal = {
        ...createTestJournal({
          totalExpected: 100,
          validVotes: 100,
          missingSlots: 0,
          invalidPresentedSlots: 0,
          seenIndicesCount: 100,
        }),
        electionId: 'test-election',
        electionConfigHash: '0xhash',
        bulletinRoot: '0xroot',
        treeSize: 100,
        totalExpected: 100,
        sthDigest: '0xsth',
        verifiedTally: [20, 20, 20, 20, 20],
        totalVotes: 100,
        validVotes: 100,
        invalidVotes: 0,
        seenIndicesCount: 100,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        includedBitmapRoot: '0xbitmap',
        excludedSlots: 0,
        inputCommitment: '0xinput',
        methodVersion: CURRENT_METHOD_VERSION,
        ...canonicalOverrides,
      };

      const validVotes =
        typeof overrides.validVotes === 'number'
          ? overrides.validVotes
          : typeof overrides.countedIndices === 'number'
            ? overrides.countedIndices
            : baseJournal.validVotes;
      const invalidVotes =
        typeof overrides.invalidVotes === 'number'
          ? overrides.invalidVotes
          : typeof overrides.invalidIndices === 'number'
            ? overrides.invalidIndices
            : baseJournal.invalidVotes;
      const missingSlots =
        typeof overrides.missingSlots === 'number'
          ? overrides.missingSlots
          : typeof overrides.missingIndices === 'number'
            ? overrides.missingIndices
            : baseJournal.missingSlots;
      const invalidPresentedSlots =
        typeof overrides.invalidPresentedSlots === 'number'
          ? overrides.invalidPresentedSlots
          : typeof overrides.invalidIndices === 'number'
            ? overrides.invalidIndices
            : baseJournal.invalidPresentedSlots;
      const rejectedRecords =
        typeof overrides.rejectedRecords === 'number'
          ? overrides.rejectedRecords
          : typeof overrides.invalidIndices === 'number'
            ? overrides.invalidIndices
            : baseJournal.rejectedRecords;
      const excludedSlots =
        typeof overrides.excludedSlots === 'number'
          ? overrides.excludedSlots
          : typeof overrides.excludedCount === 'number'
            ? overrides.excludedCount
            : missingSlots + invalidPresentedSlots;
      const seenIndicesCount =
        typeof overrides.seenIndicesCount === 'number'
          ? overrides.seenIndicesCount
          : validVotes + invalidPresentedSlots;
      const totalVotes = typeof overrides.totalVotes === 'number' ? overrides.totalVotes : validVotes + rejectedRecords;

      const normalizedJournal: ZkVMJournal = {
        ...baseJournal,
        validVotes,
        invalidVotes,
        missingSlots,
        invalidPresentedSlots,
        rejectedRecords,
        excludedSlots,
        seenIndicesCount,
        totalVotes,
      };

      return normalizedJournal;
    })(),
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
    verifyConsistencyProofMock.mockReset();
    verifyConsistencyProofMock.mockReturnValue(true);
    vi.unstubAllGlobals();
  });

  describe('verifyConsistencyProof', () => {
    const mockSessionId = 'test-session-123';
    const mockOldSize = 10;
    const mockNewSize = 20;

    it('should verify valid consistency proof', async () => {
      // Arrange
      const mockResponse: ConsistencyProofResponse = {
        oldSize: mockOldSize,
        newSize: mockNewSize,
        rootAtOldSize: '0xabc123',
        rootAtNewSize: '0xdef456',
        proofNodes: ['0x111', '0x222', '0x333'],
        timestamp: Date.now(),
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      // Act
      const result = await verifyConsistencyProof(
        mockSessionId,
        mockOldSize,
        mockNewSize,
        mockResponse.rootAtOldSize,
        mockResponse.rootAtNewSize,
      );

      // Assert
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/bulletin/consistency-proof?oldSize=${mockOldSize}&newSize=${mockNewSize}`,
        { headers: { 'X-Session-ID': mockSessionId } },
      );
    });

    it('should detect root mismatch (split-view attack)', async () => {
      // Arrange
      const mockResponse: ConsistencyProofResponse = {
        oldSize: mockOldSize,
        newSize: mockNewSize,
        rootAtOldSize: '0xabc123',
        rootAtNewSize: '0xdef456',
        proofNodes: ['0x111', '0x222'],
        timestamp: Date.now(),
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      // Act - providing different expected roots
      const result = await verifyConsistencyProof(
        mockSessionId,
        mockOldSize,
        mockNewSize,
        '0xwrong123', // Wrong old root
        mockResponse.rootAtNewSize,
      );

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Root mismatch');
      expect(result.details?.type).toBe('split-view-attack');
    });

    it('should handle API errors gracefully', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Act
      const result = await verifyConsistencyProof(mockSessionId, mockOldSize, mockNewSize, '0xabc123', '0xdef456');

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Failed to fetch consistency proof');
    });

    it('forwards session capability headers when provided explicitly', async () => {
      const mockResponse: ConsistencyProofResponse = {
        oldSize: mockOldSize,
        newSize: mockNewSize,
        rootAtOldSize: '0xabc123',
        rootAtNewSize: '0xdef456',
        proofNodes: ['0x111'],
        timestamp: Date.now(),
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await verifyConsistencyProof(
        mockSessionId,
        mockOldSize,
        mockNewSize,
        mockResponse.rootAtOldSize,
        mockResponse.rootAtNewSize,
        {
          headers: {
            'X-Session-ID': mockSessionId,
            'X-Session-Capability': 'capability-token',
          },
        },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        `/api/bulletin/consistency-proof?oldSize=${mockOldSize}&newSize=${mockNewSize}`,
        {
          headers: {
            'X-Session-ID': mockSessionId,
            'X-Session-Capability': 'capability-token',
          },
        },
      );
    });
  });

  describe('checkCompleteness', () => {
    it('should pass when missingSlots is 0', () => {
      // Arrange
      const journal = createJournal();

      // Act
      const result = checkCompleteness(journal);

      // Assert
      expect(result.isComplete).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should fail when missingSlots > 0', () => {
      // Arrange
      const journal = createJournal({
        verifiedTally: [18, 19, 20, 20, 18],
        totalVotes: 95,
        validVotes: 95,
        seenIndicesCount: 95,
        missingSlots: 5,
        excludedSlots: 5,
      });

      // Act
      const result = checkCompleteness(journal);

      // Assert
      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('Conservative exclusion signal detected');
      expect(result.error).toContain('5 unpresented slots');
      expect(result.severity).toBe('critical');
    });

    it('should fail when excludedSlots is not a finite number', () => {
      const journal = createJournal({ excludedSlots: Number.NaN });

      const result = checkCompleteness(journal);

      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('Invalid zkVM journal');
      expect(result.severity).toBe('critical');
    });

    it('should fail when totalExpected is missing', () => {
      const journal = createJournal({ totalExpected: undefined as unknown as number });

      const result = checkCompleteness(journal);

      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('totalExpected');
      expect(result.severity).toBe('critical');
    });

    it('should fail when treeSize is invalid', () => {
      const journal = createJournal({ treeSize: -1 });

      const result = checkCompleteness(journal);

      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('treeSize');
      expect(result.severity).toBe('critical');
    });

    it('should fail closed when totalExpected differs from treeSize', () => {
      // Arrange
      const journal = createJournal({
        treeSize: 90,
        totalExpected: 100,
        verifiedTally: [18, 18, 18, 18, 18],
        totalVotes: 90,
        validVotes: 90,
        seenIndicesCount: 90,
      });

      // Act
      const result = checkCompleteness(journal);

      // Assert
      expect(result.isComplete).toBe(false);
      expect(result.error).toContain('Expected 100 votes but tree only has 90');
      expect(result.severity).toBe('critical');
    });
  });

  describe('validateVotingIntegrity', () => {
    const STH_SOURCES = ['https://auditor1.example/sth', 'https://auditor2.example/sth'];

    beforeEach(() => {
      process.env.NEXT_PUBLIC_STH_SOURCES = STH_SOURCES.join(',');
    });

    afterEach(() => {
      delete process.env.NEXT_PUBLIC_STH_SOURCES;
      delete process.env.NEXT_PUBLIC_STH_MIN_MATCHES;
    });

    const mockReceipt: VoteReceipt = {
      voteId: 'vote-123',
      commitment: '0xcommit123',
      bulletinIndex: 5,
      bulletinRootAtCast: '0xoldroot',
      inputCommitment: '0xinputcommit',
      timestamp: Date.now(),
    };

    const mockJournal = createJournal({ bulletinRoot: '0xnewroot' });

    it('should validate complete voting integrity', async () => {
      // Arrange
      const mockConsistencyProof: ConsistencyProofResponse = {
        oldSize: 10,
        newSize: 100,
        rootAtOldSize: mockReceipt.bulletinRootAtCast,
        rootAtNewSize: mockJournal.bulletinRoot,
        proofNodes: ['0x111', '0x222'],
        timestamp: Date.now(),
      };

      const sthResponse = {
        sthDigest: mockJournal.sthDigest,
        treeSize: mockJournal.treeSize,
        bulletinRoot: mockJournal.bulletinRoot,
        timestamp: Date.now(),
      };

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockConsistencyProof),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        });

      // Act
      const result = await validateVotingIntegrity('session-123', mockReceipt, mockJournal);

      // Assert
      expect(result.isValid).toBe(true);
      expect(result.consistencyProofValid).toBe(true);
      expect(result.completenessValid).toBe(true);
      expect(result.canShowVerified).toBe(true);
      expect(result.sthVerified).toBe(true);
      expect(result.sthConsensus).toBe(true);
    });

    it('should not show verified when consistency proof fails', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      // Act
      const result = await validateVotingIntegrity('session-123', mockReceipt, mockJournal);

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.consistencyProofValid).toBe(false);
      expect(result.canShowVerified).toBe(false);
      expect(result.error).toContain('Consistency proof verification failed');
    });

    it('should not show verified when missingSlots > 0', async () => {
      // Arrange
      const incompleteJournal: ZkVMJournal = {
        ...mockJournal,
        missingSlots: 10,
        excludedSlots: 10,
        seenIndicesCount: 90,
        totalVotes: 90,
      };

      const mockConsistencyProof: ConsistencyProofResponse = {
        oldSize: 10,
        newSize: 100,
        rootAtOldSize: mockReceipt.bulletinRootAtCast,
        rootAtNewSize: incompleteJournal.bulletinRoot,
        proofNodes: ['0x111'],
        timestamp: Date.now(),
      };

      const sthResponse = {
        sthDigest: incompleteJournal.sthDigest,
        treeSize: incompleteJournal.treeSize,
        bulletinRoot: incompleteJournal.bulletinRoot,
        timestamp: Date.now(),
      };

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockConsistencyProof),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        });

      // Act
      const result = await validateVotingIntegrity('session-123', mockReceipt, incompleteJournal);

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.consistencyProofValid).toBe(true);
      expect(result.completenessValid).toBe(false);
      expect(result.canShowVerified).toBe(false);
      expect(result.error).toContain('Conservative exclusion signal detected');
    });

    it('should fail when invalidPresentedSlots > 0 even if missingSlots is 0', async () => {
      const invalidJournal: ZkVMJournal = {
        ...mockJournal,
        invalidPresentedSlots: 4,
        rejectedRecords: 4,
        excludedSlots: 4,
        validVotes: 96,
        totalVotes: 100,
      };

      fetchMock.mockReset();
      const mockConsistencyProof: ConsistencyProofResponse = {
        oldSize: 10,
        newSize: 100,
        rootAtOldSize: mockReceipt.bulletinRootAtCast,
        rootAtNewSize: invalidJournal.bulletinRoot,
        proofNodes: ['0xabc'],
        timestamp: Date.now(),
      };

      const sthResponse = {
        sthDigest: invalidJournal.sthDigest,
        treeSize: invalidJournal.treeSize,
        bulletinRoot: invalidJournal.bulletinRoot,
        timestamp: Date.now(),
      };

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockConsistencyProof),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        });

      const result = await validateVotingIntegrity('session-123', mockReceipt, invalidJournal);

      expect(result.isValid).toBe(false);
      expect(result.canShowVerified).toBe(false);
      expect(result.error).toContain('Conservative exclusion signal detected');
      expect(result.error).toContain('4 presented slots failed counting');
    });

    it('should fail when STH verification lacks consensus', async () => {
      // Reset fetch mock completely
      fetchMock.mockReset();

      const mockConsistencyProof: ConsistencyProofResponse = {
        oldSize: 10,
        newSize: 100,
        rootAtOldSize: mockReceipt.bulletinRootAtCast,
        rootAtNewSize: mockJournal.bulletinRoot,
        proofNodes: ['0x111', '0x222'],
        timestamp: Date.now(),
      };

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockConsistencyProof),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              sthDigest: '0xdeadbeef',
              treeSize: mockJournal.treeSize,
              bulletinRoot: mockJournal.bulletinRoot,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              sthDigest: mockJournal.sthDigest,
              treeSize: mockJournal.treeSize,
              bulletinRoot: mockJournal.bulletinRoot,
            }),
        });

      const result = await validateVotingIntegrity('session-123', mockReceipt, mockJournal);

      expect(result.isValid).toBe(false);
      expect(result.sthVerified).toBe(false);
      expect(result.canShowVerified).toBe(false);
      expect(result.error?.toLowerCase()).toContain('sth');
    });

    it('should allow single STH source when min matches is set to 1', async () => {
      process.env.NEXT_PUBLIC_STH_SOURCES = 'https://auditor1.example/sth';
      process.env.NEXT_PUBLIC_STH_MIN_MATCHES = '1';

      const mockConsistencyProof: ConsistencyProofResponse = {
        oldSize: 10,
        newSize: 100,
        rootAtOldSize: mockReceipt.bulletinRootAtCast,
        rootAtNewSize: mockJournal.bulletinRoot,
        proofNodes: ['0x111', '0x222'],
        timestamp: Date.now(),
      };

      const sthResponse = {
        sthDigest: mockJournal.sthDigest,
        treeSize: mockJournal.treeSize,
        bulletinRoot: mockJournal.bulletinRoot,
        timestamp: Date.now(),
      };

      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockConsistencyProof),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(sthResponse),
        });

      const result = await validateVotingIntegrity('session-123', mockReceipt, mockJournal);

      expect(result.isValid).toBe(true);
      expect(result.sthVerified).toBe(true);
      expect(result.canShowVerified).toBe(true);
    });

    it('should skip STH verification when no sources are configured', async () => {
      delete process.env.NEXT_PUBLIC_STH_SOURCES;
      delete process.env.NEXT_PUBLIC_STH_MIN_MATCHES;

      const mockConsistencyProof: ConsistencyProofResponse = {
        oldSize: 10,
        newSize: 100,
        rootAtOldSize: mockReceipt.bulletinRootAtCast,
        rootAtNewSize: mockJournal.bulletinRoot,
        proofNodes: ['0x111', '0x222'],
        timestamp: Date.now(),
      };

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockConsistencyProof),
      });

      const result = await validateVotingIntegrity('session-123', mockReceipt, mockJournal);

      expect(result.isValid).toBe(true);
      expect(result.canShowVerified).toBe(true);
      expect(result.sthVerified).toBeUndefined();
      expect(result.sthConsensus).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

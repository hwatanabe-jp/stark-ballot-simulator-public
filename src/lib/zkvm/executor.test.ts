import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecOptions } from 'node:child_process';
import { CURRENT_METHOD_VERSION, type ZkVMInput, type VoteWithProof } from './types';
import { BOT_COUNT } from '@/shared/constants';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

// Use vi.hoisted to set up mocks before module loading
const { mockFs, mockExec } = vi.hoisted(() => {
  const mockFs = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{}'),
    unlink: vi.fn().mockResolvedValue(undefined),
  };

  const mockExec = vi.fn((cmd: string, opts?: ExecOptions | ExecCallback, callback?: ExecCallback) => {
    void cmd;
    // Mock exec function for promisify
    if (typeof opts === 'function') {
      opts(null, 'Mock output', '');
      return;
    }
    callback?.(null, 'Mock output', '');
  });

  return { mockFs, mockExec };
});

vi.mock('child_process', () => ({
  default: {
    exec: mockExec,
  },
  exec: mockExec,
}));

vi.mock('fs/promises', () => ({
  default: mockFs,
  ...mockFs,
}));

import { executeZkVM } from './executor';

function createBaseInput(): ZkVMInput {
  return {
    votes: [
      {
        choice: 0,
        commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        index: 0,
        merklePath: [],
      },
    ],
    bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
    treeSize: 1,
    totalExpected: 1,
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: '0x' + '00'.repeat(32),
    logId: '0x' + '00'.repeat(32),
    timestamp: Date.now(),
  };
}

function createValidCurrentHostOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verifiedTally: [1, 0, 0, 0, 0],
    totalVotes: 1,
    validVotes: 1,
    invalidVotes: 0,
    seenIndicesCount: 1,
    missingSlots: 0,
    invalidPresentedSlots: 0,
    rejectedRecords: 0,
    seenBitmapRoot: '0x' + '6'.repeat(64),
    includedBitmapRoot: '0x' + '3'.repeat(64),
    excludedSlots: 0,
    inputCommitment: '0x' + '4'.repeat(64),
    methodVersion: CURRENT_METHOD_VERSION,
    electionId: '550e8400-e29b-41d4-a716-446655440000',
    electionConfigHash: '0x' + '0'.repeat(64),
    bulletinRoot: '0x' + '1'.repeat(64),
    treeSize: 1,
    totalExpected: 1,
    sthDigest: '0x' + '2'.repeat(64),
    imageId: '0x' + 'a'.repeat(64),
    ...overrides,
  };
}

function mockHostArtifacts(output: Record<string, unknown>, receipt: Record<string, unknown> = {}) {
  mockFs.readFile.mockImplementation((filePath: unknown) => {
    const pathValue = String(filePath);
    if (pathValue.endsWith('-output.json')) {
      return Promise.resolve(JSON.stringify(output));
    }
    if (pathValue.endsWith('-receipt.json')) {
      return Promise.resolve(
        JSON.stringify({
          receipt: { journal: { bytes: [1, 2, 3] } },
          image_id: '0x' + 'a'.repeat(64),
          ...receipt,
        }),
      );
    }
    return Promise.resolve('{}');
  });
}

describe('zkVM Executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('executeZkVM', () => {
    it('should execute zkVM and return proof receipt', async () => {
      const imageId = '0x' + 'a'.repeat(64);
      const mockOutput = {
        verifiedTally: [1, BOT_COUNT, 0, 0, 0],
        totalVotes: BOT_COUNT + 1,
        validVotes: BOT_COUNT + 1,
        invalidVotes: 0,
        seenIndicesCount: BOT_COUNT + 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        seenBitmapRoot: '0x' + '6'.repeat(64),
        includedBitmapRoot: '0x' + '3'.repeat(64),
        excludedSlots: 0,
        inputCommitment: '0x' + '4'.repeat(64),
        methodVersion: CURRENT_METHOD_VERSION,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '0'.repeat(64),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: BOT_COUNT + 1,
        totalExpected: BOT_COUNT + 1,
        sthDigest: '0x' + '2'.repeat(64),
        imageId,
      };
      const mockReceipt = {
        receipt: {
          journal: { bytes: [1, 2, 3] },
        },
        image_id: imageId,
      };

      mockFs.readFile.mockImplementation((filePath: unknown) => {
        const pathValue = String(filePath);
        if (pathValue.endsWith('-output.json')) {
          return Promise.resolve(JSON.stringify(mockOutput));
        }
        if (pathValue.endsWith('-receipt.json')) {
          return Promise.resolve(JSON.stringify(mockReceipt));
        }
        return Promise.resolve('{}');
      });
      const votes: VoteWithProof[] = [
        {
          choice: 0, // A
          commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          index: 0,
          merklePath: [],
        },
        ...Array(BOT_COUNT)
          .fill(null)
          .map((_, i) => ({
            choice: 1, // B
            commitment: '0x567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234',
            random: '0xef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd',
            index: i + 1,
            merklePath: [],
          })),
      ];

      const input: ZkVMInput = {
        votes,
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      const result = await executeZkVM(input);

      expect(result).toBeDefined();
      expect(result.verifiedTally).toBeDefined();
      expect(result.verifiedTally).toEqual([1, BOT_COUNT, 0, 0, 0]);
      expect(result.totalVotes).toBe(BOT_COUNT + 1);
      expect(result.imageId).toBe(imageId);
    });

    it('should parse host byte-array fields into canonical strings', async () => {
      const imageId = '0x' + 'b'.repeat(64);
      const electionIdBytes = [
        0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44, 0x00, 0x00,
      ];
      const electionConfigHashBytes = Array.from({ length: 32 }, (_, i) => i);
      const bulletinRootBytes = Array.from({ length: 32 }, (_, i) => 255 - i);
      const sthDigestBytes = Array.from({ length: 32 }, (_, i) => (i * 3) % 256);
      const includedBitmapRootBytes = Array.from({ length: 32 }, (_, i) => (i * 5) % 256);
      const inputCommitmentBytes = Array.from({ length: 32 }, (_, i) => (i * 7) % 256);

      const mockOutput = {
        verifiedTally: [1, 2, 3, 4, 5],
        totalVotes: 15,
        validVotes: 15,
        invalidVotes: 0,
        seenIndicesCount: 15,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        excludedSlots: 0,
        methodVersion: CURRENT_METHOD_VERSION,
        electionId: electionIdBytes,
        electionConfigHash: electionConfigHashBytes,
        bulletinRoot: bulletinRootBytes,
        treeSize: 15,
        totalExpected: 15,
        sthDigest: sthDigestBytes,
        seenBitmapRoot: Array.from({ length: 32 }, (_, i) => (i * 11) % 256),
        includedBitmapRoot: includedBitmapRootBytes,
        inputCommitment: inputCommitmentBytes,
        imageId,
      };

      const mockReceipt = {
        receipt: {
          journal: { bytes: [1, 2, 3] },
        },
        image_id: imageId,
      };

      mockFs.readFile.mockImplementation((filePath: unknown) => {
        const pathValue = String(filePath);
        if (pathValue.endsWith('-output.json')) {
          return Promise.resolve(JSON.stringify(mockOutput));
        }
        if (pathValue.endsWith('-receipt.json')) {
          return Promise.resolve(JSON.stringify(mockReceipt));
        }
        return Promise.resolve('{}');
      });

      const input: ZkVMInput = {
        votes: [
          {
            choice: 0,
            commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            index: 0,
            merklePath: [],
          },
        ],
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: 1,
        totalExpected: 1,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      const result = await executeZkVM(input);

      expect(result.electionId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result.electionConfigHash).toBe('0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      expect(result.bulletinRoot).toBe('0xfffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0');
      expect(result.sthDigest).toBe('0x000306090c0f1215181b1e2124272a2d303336393c3f4245484b4e5154575a5d');
      expect(result.includedBitmapRoot).toBe('0x00050a0f14191e23282d32373c41464b50555a5f64696e73787d82878c91969b');
      expect(result.inputCommitment).toBe('0x00070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9');
      expect(result.imageId).toBe(imageId);
    });

    it('should handle tamper scenarios correctly', async () => {
      const imageId = '0x' + 'c'.repeat(64);
      const mockOutput = {
        verifiedTally: [0, 0, BOT_COUNT + 1, 0, 0],
        totalVotes: BOT_COUNT + 1,
        validVotes: BOT_COUNT + 1,
        invalidVotes: 0,
        seenIndicesCount: BOT_COUNT + 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        seenBitmapRoot: '0x' + '6'.repeat(64),
        includedBitmapRoot: '0x' + '3'.repeat(64),
        excludedSlots: 0,
        inputCommitment: '0x' + '4'.repeat(64),
        methodVersion: CURRENT_METHOD_VERSION,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '0'.repeat(64),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: BOT_COUNT + 1,
        totalExpected: BOT_COUNT + 1,
        sthDigest: '0x' + '2'.repeat(64),
        imageId,
      };
      const mockReceipt = {
        receipt: {
          journal: { bytes: [9, 8, 7] },
        },
        image_id: imageId,
      };

      mockFs.readFile.mockImplementation((filePath: unknown) => {
        const pathValue = String(filePath);
        if (pathValue.endsWith('-output.json')) {
          return Promise.resolve(JSON.stringify(mockOutput));
        }
        if (pathValue.endsWith('-receipt.json')) {
          return Promise.resolve(JSON.stringify(mockReceipt));
        }
        return Promise.resolve('{}');
      });
      const votes: VoteWithProof[] = [
        {
          choice: 2, // C
          commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          index: 0,
          merklePath: [],
        },
        ...Array(BOT_COUNT)
          .fill(null)
          .map((_, i) => ({
            choice: 2, // C
            commitment: '0x567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234',
            random: '0xef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd',
            index: i + 1,
            merklePath: [],
          })),
      ];

      const input: ZkVMInput = {
        votes,
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      const result = await executeZkVM(input);

      expect(result.verifiedTally).toEqual([0, 0, BOT_COUNT + 1, 0, 0]); // All votes for C
    });

    it('should fail closed when host output omits methodVersion', async () => {
      const mockOutput = {
        verifiedTally: [1, 0, 0, 0, 0],
        totalVotes: 1,
        validVotes: 1,
        invalidVotes: 0,
        seenIndicesCount: 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        seenBitmapRoot: '0x' + '6'.repeat(64),
        includedBitmapRoot: '0x' + '3'.repeat(64),
        excludedSlots: 0,
        inputCommitment: '0x' + '4'.repeat(64),
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '0'.repeat(64),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 1,
        totalExpected: 1,
        sthDigest: '0x' + '2'.repeat(64),
        imageId: '0x' + 'a'.repeat(64),
      };

      mockFs.readFile.mockImplementation((filePath: unknown) => {
        const pathValue = String(filePath);
        if (pathValue.endsWith('-output.json')) {
          return Promise.resolve(JSON.stringify(mockOutput));
        }
        if (pathValue.endsWith('-receipt.json')) {
          return Promise.resolve(JSON.stringify({ receipt: { journal: { bytes: [1, 2, 3] } } }));
        }
        return Promise.resolve('{}');
      });

      const input: ZkVMInput = {
        votes: [
          {
            choice: 0,
            commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            index: 0,
            merklePath: [],
          },
        ],
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: 1,
        totalExpected: 1,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      await expect(executeZkVM(input)).rejects.toThrow('Current zkVM host output missing methodVersion');
    });

    it('should fail closed when host output only provides legacy count fields', async () => {
      const mockOutput = {
        verifiedTally: [1, 0, 0, 0, 0],
        totalVotes: 1,
        validVotes: 1,
        invalidVotes: 0,
        seenIndicesCount: 1,
        missingIndices: 0,
        invalidIndices: 0,
        countedIndices: 1,
        seenBitmapRoot: '0x' + '6'.repeat(64),
        includedBitmapRoot: '0x' + '3'.repeat(64),
        excludedCount: 0,
        inputCommitment: '0x' + '4'.repeat(64),
        methodVersion: CURRENT_METHOD_VERSION,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '0'.repeat(64),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 1,
        totalExpected: 1,
        sthDigest: '0x' + '2'.repeat(64),
        imageId: '0x' + 'a'.repeat(64),
      };

      mockFs.readFile.mockImplementation((filePath: unknown) => {
        const pathValue = String(filePath);
        if (pathValue.endsWith('-output.json')) {
          return Promise.resolve(JSON.stringify(mockOutput));
        }
        if (pathValue.endsWith('-receipt.json')) {
          return Promise.resolve(JSON.stringify({ receipt: { journal: { bytes: [1, 2, 3] } } }));
        }
        return Promise.resolve('{}');
      });

      const input: ZkVMInput = {
        votes: [
          {
            choice: 0,
            commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            index: 0,
            merklePath: [],
          },
        ],
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: 1,
        totalExpected: 1,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      await expect(executeZkVM(input)).rejects.toThrow('Current zkVM host output missing missingSlots');
    });

    it('should fail closed when host output only uses legacy snake_case keys', async () => {
      const mockOutput = {
        verified_tally: [1, 0, 0, 0, 0],
        total_votes: 1,
        valid_votes: 1,
        invalid_votes: 0,
        seen_indices_count: 1,
        missing_slots: 0,
        invalid_presented_slots: 0,
        rejected_records: 0,
        seen_bitmap_root: '0x' + '6'.repeat(64),
        included_bitmap_root: '0x' + '3'.repeat(64),
        excluded_slots: 0,
        input_commitment: '0x' + '4'.repeat(64),
        method_version: CURRENT_METHOD_VERSION,
        election_id: '550e8400-e29b-41d4-a716-446655440000',
        election_config_hash: '0x' + '0'.repeat(64),
        bulletin_root: '0x' + '1'.repeat(64),
        tree_size: 1,
        total_expected: 1,
        sth_digest: '0x' + '2'.repeat(64),
        image_id: '0x' + 'a'.repeat(64),
      };

      mockFs.readFile.mockImplementation((filePath: unknown) => {
        const pathValue = String(filePath);
        if (pathValue.endsWith('-output.json')) {
          return Promise.resolve(JSON.stringify(mockOutput));
        }
        if (pathValue.endsWith('-receipt.json')) {
          return Promise.resolve(JSON.stringify({ receipt: { journal: { bytes: [1, 2, 3] } } }));
        }
        return Promise.resolve('{}');
      });

      const input: ZkVMInput = {
        votes: [
          {
            choice: 0,
            commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            index: 0,
            merklePath: [],
          },
        ],
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: 1,
        totalExpected: 1,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      await expect(executeZkVM(input)).rejects.toThrow('Current zkVM host output missing methodVersion');
    });

    it('should fail closed when output omits top-level imageId even if receipt provides image_id', async () => {
      const mockOutput = {
        verifiedTally: [1, 0, 0, 0, 0],
        totalVotes: 1,
        validVotes: 1,
        invalidVotes: 0,
        seenIndicesCount: 1,
        missingSlots: 0,
        invalidPresentedSlots: 0,
        rejectedRecords: 0,
        seenBitmapRoot: '0x' + '6'.repeat(64),
        includedBitmapRoot: '0x' + '3'.repeat(64),
        excludedSlots: 0,
        inputCommitment: '0x' + '4'.repeat(64),
        methodVersion: CURRENT_METHOD_VERSION,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '0'.repeat(64),
        bulletinRoot: '0x' + '1'.repeat(64),
        treeSize: 1,
        totalExpected: 1,
        sthDigest: '0x' + '2'.repeat(64),
      };

      mockFs.readFile.mockImplementation((filePath: unknown) => {
        const pathValue = String(filePath);
        if (pathValue.endsWith('-output.json')) {
          return Promise.resolve(JSON.stringify(mockOutput));
        }
        if (pathValue.endsWith('-receipt.json')) {
          return Promise.resolve(
            JSON.stringify({
              receipt: { journal: { bytes: [1, 2, 3] } },
              image_id: '0x' + 'a'.repeat(64),
            }),
          );
        }
        return Promise.resolve('{}');
      });

      const input: ZkVMInput = {
        votes: [
          {
            choice: 0,
            commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
            random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            index: 0,
            merklePath: [],
          },
        ],
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: 1,
        totalExpected: 1,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      await expect(executeZkVM(input)).rejects.toThrow('Current zkVM host output missing imageId');
    });

    it('should fail closed when host output uses invalid 32-byte hash lengths', async () => {
      mockHostArtifacts(
        createValidCurrentHostOutput({
          bulletinRoot: '0x1234',
        }),
      );

      await expect(executeZkVM(createBaseInput())).rejects.toThrow('Current zkVM host output invalid bulletinRoot');
    });

    it('should fail closed when verifiedTally does not match the current contract length', async () => {
      mockHostArtifacts(
        createValidCurrentHostOutput({
          verifiedTally: [1, 0, 0, 0, 0, 0],
        }),
      );

      await expect(executeZkVM(createBaseInput())).rejects.toThrow('Current zkVM host output invalid verifiedTally');
    });

    it('should fail closed when imageId is not a 32-byte hex string', async () => {
      mockHostArtifacts(
        createValidCurrentHostOutput({
          imageId: '0x1234',
        }),
      );

      await expect(executeZkVM(createBaseInput())).rejects.toThrow('Current zkVM host output invalid imageId');
    });

    it('should surface zkVM execution errors', async () => {
      const execError = new Error('zkVM execution failed');
      mockExec.mockImplementationOnce((cmd: string, opts?: ExecOptions | ExecCallback, callback?: ExecCallback) => {
        void cmd;
        if (typeof opts === 'function') {
          opts(execError, '', '');
          return;
        }
        callback?.(execError, '', '');
      });

      const votes: VoteWithProof[] = [
        {
          choice: 0,
          commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          index: 0,
          merklePath: [],
        },
      ];

      const input: ZkVMInput = {
        votes,
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      await expect(executeZkVM(input)).rejects.toThrow('zkVM execution failed');
    });

    it('should timeout after configured duration', async () => {
      const timeoutError = Object.assign(new Error('Command failed: timeout'), {
        code: 'ETIMEDOUT',
      });
      mockExec.mockImplementationOnce((cmd: string, opts?: ExecOptions | ExecCallback, callback?: ExecCallback) => {
        void cmd;
        if (typeof opts === 'function') {
          opts(timeoutError, '', '');
          return;
        }
        callback?.(timeoutError, '', '');
      });

      const votes: VoteWithProof[] = [
        {
          choice: 0,
          commitment: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          random: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          index: 0,
          merklePath: [],
        },
      ];

      const input: ZkVMInput = {
        votes,
        bulletinRoot: '0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
        treeSize: votes.length,
        totalExpected: votes.length,
        electionId: '550e8400-e29b-41d4-a716-446655440000',
        electionConfigHash: '0x' + '00'.repeat(32),
        logId: '0x' + '00'.repeat(32),
        timestamp: Date.now(),
      };

      await expect(executeZkVM(input)).rejects.toThrow('zkVM execution timeout');
    });
  });
});

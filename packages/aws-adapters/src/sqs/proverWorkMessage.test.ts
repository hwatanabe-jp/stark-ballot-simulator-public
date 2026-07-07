import { describe, it, expect } from 'vitest';
import { PROVER_WORK_MESSAGE_VERSION, parseProverWorkMessage } from '@stark-ballot/aws-adapters/sqs/proverWorkMessage';
import { buildDefaultElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const baseVote = {
  commitment: '0x' + 'a'.repeat(64),
  choice: 1,
  random: '0x' + 'b'.repeat(64),
  index: 0,
  merklePath: Array.from({ length: 6 }, () => '0x' + 'c'.repeat(64)),
};

const baseInput = {
  electionId: '8f9f3ab6-7a4c-4c28-89d9-8f1b94b52f24',
  bulletinRoot: '0x' + 'd'.repeat(64),
  treeSize: 65,
  logId: '0x' + 'e'.repeat(64),
  timestamp: 1730000000000,
  totalExpected: 65,
  electionConfigHash: '0x' + 'f'.repeat(64),
  votes: [baseVote],
};

describe('parseProverWorkMessage', () => {
  it('rejects legacy queued message versions', () => {
    const raw = {
      messageVersion: 'v1.0',
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      zkvmInput: baseInput,
      expectedImageId: '0x' + '1'.repeat(64),
    } as const;

    expect(() => parseProverWorkMessage(raw)).toThrow(/messageVersion/i);
  });

  it('normalizes hex fields and provides defaults', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0X' + 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: {
        ...baseInput,
        votes: [
          {
            ...baseVote,
            commitment: 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
            random: '0X' + '1234'.repeat(16),
            merklePath: ['c'.repeat(64)],
          },
        ],
      },
      scenarios: undefined,
    } as const;

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.expectedImageId).toBe('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    expect((parsed as Record<string, unknown>)['contractGeneration']).toBe('2026-04-zkvm-current-v1');
    expect(parsed.zkvmInput).toBeDefined();
    if (!parsed.zkvmInput) {
      throw new Error('Expected inline zkVM input');
    }
    expect(strictDefined(parsed.zkvmInput.votes[0]).commitment).toBe(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );
    expect(strictDefined(parsed.zkvmInput.votes[0]).random).toBe(
      '0x1234123412341234123412341234123412341234123412341234123412341234',
    );
    expect(strictDefined(parsed.zkvmInput.votes[0]).merklePath).toEqual(['0x' + 'c'.repeat(64)]);
    expect(parsed.scenarios).toEqual([]);
  });

  it('creates a fresh scenarios default for each parse', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      inputS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json',
      outputS3Prefix: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX',
      bundleS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/bundle.zip',
    } as const;

    const first = parseProverWorkMessage(raw);
    const second = parseProverWorkMessage(raw);

    expect(first.scenarios).not.toBe(second.scenarios);

    first.scenarios.push('S1');

    expect(second.scenarios).toEqual([]);
    expect(parseProverWorkMessage(raw).scenarios).toEqual([]);
  });

  it('accepts only current queued messages with the strict schema', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: baseInput,
    } as const;

    const parsed = parseProverWorkMessage(raw);
    expect(parsed).toMatchObject({
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      contractGeneration: '2026-04-zkvm-current-v1',
    });
  });

  it('rejects messages without contractGeneration', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: baseInput,
    } as const;

    expect(() => parseProverWorkMessage(raw)).toThrow(/contractGeneration/i);
  });

  it('accepts target S3 artifact keys without inline private prover input', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      inputS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json',
      outputS3Prefix: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX',
      bundleS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/bundle.zip',
    } as const;

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.inputS3Key).toBe(
      'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json',
    );
    expect(parsed.outputS3Prefix).toBe('sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX');
    expect(parsed.bundleS3Key).toBe(
      'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/bundle.zip',
    );
    expect(parsed.zkvmInput).toBeUndefined();
    expect(parsed.electionConfig).toBeUndefined();
  });

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe executionId segment %s',
    (executionId) => {
      const raw = {
        messageVersion: PROVER_WORK_MESSAGE_VERSION,
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        contractGeneration: '2026-04-zkvm-current-v1',
        executionId,
        queuedAt: 1730000000000,
        expectedImageId: '0x' + '1'.repeat(64),
        inputS3Key: `sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/${executionId}/input.json`,
        outputS3Prefix: `sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/${executionId}`,
        bundleS3Key: `sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/${executionId}/bundle.zip`,
      } as const;

      expect(() => parseProverWorkMessage(raw)).toThrow(/executionId/i);
    },
  );

  it('accepts an authoritative electionConfig payload', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: baseInput,
    } as const;

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.electionConfig).toEqual(buildDefaultElectionConfig());
  });

  it('rejects payloads without an authoritative electionConfig', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      zkvmInput: baseInput,
    } as const;

    expect(() => parseProverWorkMessage(raw)).toThrow(/inline prover input/i);
  });

  it('rejects invalid imageId length', () => {
    const invalid = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x1234',
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: baseInput,
    } as const;

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/expectedImageId/i);
  });

  it('ensures vote indices are non-negative integers', () => {
    const invalid = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: {
        ...baseInput,
        votes: [{ ...baseVote, index: -1 }],
      },
    } as const;

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/index/i);
  });

  it('rejects unsafe integer values before Rust host serialization', () => {
    const invalid = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: {
        ...baseInput,
        timestamp: Number.MAX_SAFE_INTEGER + 1,
      },
    } as const;

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/timestamp must be a JavaScript safe integer/i);
  });

  it('rejects numeric values above Rust wire maxima', () => {
    const invalid = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: {
        ...baseInput,
        treeSize: 0x1_0000_0000,
      },
    } as const;

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/treeSize exceeds Rust wire maximum 4294967295/i);
  });

  it('rejects zero timestamps at the inline zkVM input boundary', () => {
    const invalid = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: {
        ...baseInput,
        timestamp: 0,
      },
    } as const;

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/timestamp must be positive Unix timestamp/i);
  });

  it('rejects choice values outside the Rust u8 wire boundary', () => {
    const invalid = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: {
        ...baseInput,
        votes: [{ ...baseVote, choice: 256 }],
      },
    } as const;

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/votes\[0\]\.choice exceeds Rust wire maximum 255/i);
  });

  it('accepts guest-accounted invalid choices that still fit the Rust wire boundary', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: {
        ...baseInput,
        votes: [{ ...baseVote, choice: 5 }],
      },
    } as const;

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.zkvmInput?.votes[0]?.choice).toBe(5);
  });

  it('accepts empty Merkle paths for one-leaf zkVM inputs', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: {
        ...baseInput,
        treeSize: 1,
        totalExpected: 1,
        votes: [{ ...baseVote, merklePath: [] }],
      },
    } as const;

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.zkvmInput?.votes[0]?.merklePath).toEqual([]);
  });
});

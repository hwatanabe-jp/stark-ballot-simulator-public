import { describe, it, expect } from 'vitest';
import { PROVER_WORK_RECORD_TYPE, parseProverWorkMessage } from '@stark-ballot/aws-adapters/sqs/proverWorkMessage';
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

const scenarioContext = {
  scenarios: [],
  tamperMode: 'none',
  claimedCounts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
  claimedTotalVotes: 1,
  summary: {
    ignoredCount: 0,
    recountedCount: 0,
    userRecountChoice: null,
  },
} as const;

const commonMessage = {
  recordType: PROVER_WORK_RECORD_TYPE,
  sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
  finalizationId: '01HVN5WA1CEH94868G90QGJ7HX',
  queuedAtMs: 1730000000000,
  expectedImageId: '0x' + '1'.repeat(64),
  scenarios: [],
  simulateTampering: false,
  scenarioContext,
} as const;

function inlineMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...commonMessage,
    inputSource: 'inline',
    electionConfig: buildDefaultElectionConfig(),
    zkvmInput: baseInput,
    ...overrides,
  };
}

function s3Message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...commonMessage,
    inputSource: 's3',
    inputS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json',
    outputS3Prefix: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX',
    bundleS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/bundle.zip',
    ...overrides,
  };
}

describe('parseProverWorkMessage', () => {
  it('admits an exact inline input source without a repository generation marker', () => {
    const parsed = parseProverWorkMessage({
      recordType: PROVER_WORK_RECORD_TYPE,
      inputSource: 'inline',
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      finalizationId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAtMs: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: baseInput,
      scenarios: [],
      simulateTampering: false,
      scenarioContext,
    });

    expect(parsed).toMatchObject({
      recordType: PROVER_WORK_RECORD_TYPE,
      inputSource: 'inline',
      scenarios: [],
      simulateTampering: false,
    });
    expect(parsed).not.toHaveProperty('contractGeneration');
  });

  it('rejects the retired repository generation marker', () => {
    expect(() =>
      parseProverWorkMessage({
        recordType: PROVER_WORK_RECORD_TYPE,
        inputSource: 'inline',
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        contractGeneration: 'retired-generation',
        finalizationId: '01HVN5WA1CEH94868G90QGJ7HX',
        queuedAtMs: 1730000000000,
        expectedImageId: '0x' + '1'.repeat(64),
        electionConfig: buildDefaultElectionConfig(),
        zkvmInput: baseInput,
        scenarios: [],
        simulateTampering: false,
        scenarioContext,
      }),
    ).toThrow(/contractGeneration|unsupported field/i);
  });

  it.each(['scenarios', 'simulateTampering', 'scenarioContext'] as const)(
    'requires %s instead of supplying a queue default',
    (field) => {
      const raw: Record<string, unknown> = {
        recordType: PROVER_WORK_RECORD_TYPE,
        inputSource: 'inline',
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        finalizationId: '01HVN5WA1CEH94868G90QGJ7HX',
        queuedAtMs: 1730000000000,
        expectedImageId: '0x' + '1'.repeat(64),
        electionConfig: buildDefaultElectionConfig(),
        zkvmInput: baseInput,
        scenarios: [],
        simulateTampering: false,
        scenarioContext,
      };
      delete raw[field];

      expect(() => parseProverWorkMessage(raw)).toThrow(new RegExp(field, 'i'));
    },
  );

  it('rejects a mixed inline and S3 input payload', () => {
    expect(() =>
      parseProverWorkMessage({
        recordType: PROVER_WORK_RECORD_TYPE,
        inputSource: 'inline',
        sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
        finalizationId: '01HVN5WA1CEH94868G90QGJ7HX',
        queuedAtMs: 1730000000000,
        expectedImageId: '0x' + '1'.repeat(64),
        electionConfig: buildDefaultElectionConfig(),
        zkvmInput: baseInput,
        inputS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json',
        outputS3Prefix: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX',
        bundleS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/bundle.zip',
        scenarios: [],
        simulateTampering: false,
        scenarioContext,
      }),
    ).toThrow(/inline|unsupported field|mixed/i);
  });

  it('rejects legacy legacy queue record types', () => {
    const raw = {
      recordType: 'v1.0',
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      finalizationId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAtMs: 1730000000000,
      zkvmInput: baseInput,
      expectedImageId: '0x' + '1'.repeat(64),
    } as const;

    expect(() => parseProverWorkMessage(raw)).toThrow(/recordType/i);
  });

  it('normalizes hex fields without supplying defaults', () => {
    const parsed = parseProverWorkMessage(
      inlineMessage({
        expectedImageId: '0X' + 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
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
      }),
    );

    expect(parsed.expectedImageId).toBe('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    if (parsed.inputSource !== 'inline') {
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

  it('creates a fresh scenarios array for each parse', () => {
    const raw = s3Message();

    const first = parseProverWorkMessage(raw);
    const second = parseProverWorkMessage(raw);

    expect(first.scenarios).not.toBe(second.scenarios);

    first.scenarios.push('S1');

    expect(second.scenarios).toEqual([]);
    expect(parseProverWorkMessage(raw).scenarios).toEqual([]);
  });

  it('accepts only current queue records with the strict schema', () => {
    const parsed = parseProverWorkMessage(inlineMessage());
    expect(parsed).toMatchObject({
      recordType: PROVER_WORK_RECORD_TYPE,
      inputSource: 'inline',
    });
    expect(parsed).not.toHaveProperty('contractGeneration');
  });

  it('rejects messages without an input source discriminant', () => {
    const raw = inlineMessage();
    delete raw['inputSource'];

    expect(() => parseProverWorkMessage(raw)).toThrow(/inputSource/i);
  });

  it('accepts target S3 artifact keys without inline private prover input', () => {
    const parsed = parseProverWorkMessage(s3Message());

    expect(parsed.inputSource).toBe('s3');
    if (parsed.inputSource !== 's3') {
      throw new Error('Expected S3 prover input');
    }
    expect(parsed.inputS3Key).toBe(
      'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json',
    );
    expect(parsed.outputS3Prefix).toBe('sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX');
    expect(parsed.bundleS3Key).toBe(
      'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/bundle.zip',
    );
    expect(parsed).not.toHaveProperty('zkvmInput');
    expect(parsed).not.toHaveProperty('electionConfig');
  });

  it.each(['bad/segment-123', 'bad.segment-123', 'https://example.invalid/execution'])(
    'rejects unsafe finalizationId segment %s',
    (finalizationId) => {
      const raw = s3Message({
        finalizationId,
        inputS3Key: `sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/${finalizationId}/input.json`,
        outputS3Prefix: `sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/${finalizationId}`,
        bundleS3Key: `sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/${finalizationId}/bundle.zip`,
      });

      expect(() => parseProverWorkMessage(raw)).toThrow(/finalizationId/i);
    },
  );

  it('accepts an authoritative electionConfig payload', () => {
    const parsed = parseProverWorkMessage(inlineMessage());

    if (parsed.inputSource !== 'inline') {
      throw new Error('Expected inline prover input');
    }
    expect(parsed.electionConfig).toEqual(buildDefaultElectionConfig());
  });

  it('rejects payloads without an authoritative electionConfig', () => {
    const raw = inlineMessage();
    delete raw['electionConfig'];

    expect(() => parseProverWorkMessage(raw)).toThrow(/inline prover input/i);
  });

  it('rejects invalid imageId length', () => {
    const invalid = inlineMessage({
      expectedImageId: '0x1234',
    });

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/expectedImageId/i);
  });

  it('ensures vote indices are non-negative integers', () => {
    const invalid = inlineMessage({
      zkvmInput: {
        ...baseInput,
        votes: [{ ...baseVote, index: -1 }],
      },
    });

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/index/i);
  });

  it('rejects unsafe integer values before Rust host serialization', () => {
    const invalid = inlineMessage({
      zkvmInput: {
        ...baseInput,
        timestamp: Number.MAX_SAFE_INTEGER + 1,
      },
    });

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/timestamp must be a JavaScript safe integer/i);
  });

  it('rejects numeric values above Rust wire maxima', () => {
    const invalid = inlineMessage({
      zkvmInput: {
        ...baseInput,
        treeSize: 0x1_0000_0000,
      },
    });

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/treeSize exceeds Rust wire maximum 4294967295/i);
  });

  it('rejects zero timestamps at the inline zkVM input boundary', () => {
    const invalid = inlineMessage({
      zkvmInput: {
        ...baseInput,
        timestamp: 0,
      },
    });

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/timestamp must be positive Unix timestamp/i);
  });

  it('rejects choice values outside the Rust u8 wire boundary', () => {
    const invalid = inlineMessage({
      zkvmInput: {
        ...baseInput,
        votes: [{ ...baseVote, choice: 256 }],
      },
    });

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/votes\[0\]\.choice exceeds Rust wire maximum 255/i);
  });

  it('accepts guest-accounted invalid choices that still fit the Rust wire boundary', () => {
    const raw = inlineMessage({
      zkvmInput: {
        ...baseInput,
        votes: [{ ...baseVote, choice: 5 }],
      },
    });

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.inputSource).toBe('inline');
    if (parsed.inputSource !== 'inline') {
      throw new Error('Expected inline prover input');
    }
    expect(parsed.zkvmInput.votes[0]?.choice).toBe(5);
  });

  it('accepts empty Merkle paths for one-leaf zkVM inputs', () => {
    const raw = inlineMessage({
      zkvmInput: {
        ...baseInput,
        treeSize: 1,
        totalExpected: 1,
        votes: [{ ...baseVote, merklePath: [] }],
      },
    });

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.inputSource).toBe('inline');
    if (parsed.inputSource !== 'inline') {
      throw new Error('Expected inline prover input');
    }
    expect(parsed.zkvmInput.votes[0]?.merklePath).toEqual([]);
  });
});

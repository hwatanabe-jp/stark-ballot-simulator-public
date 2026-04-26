import { describe, it, expect } from 'vitest';
import { PROVER_WORK_MESSAGE_VERSION, parseProverWorkMessage } from '../types';
import { buildDefaultElectionConfig } from '@/lib/zkvm/election-config';

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
      requestMeta: {
        clientIp: '203.0.113.10',
        timestamp: 1730000000000,
        electionId: baseInput.electionId,
        traceId: 'trace-123',
      },
      scenarios: undefined,
    } as const;

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.expectedImageId).toBe('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    expect((parsed as Record<string, unknown>).contractGeneration).toBe('2026-04-zkvm-current-v1');
    expect(parsed.zkvmInput.votes[0].commitment).toBe(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );
    expect(parsed.zkvmInput.votes[0].random).toBe('0x1234123412341234123412341234123412341234123412341234123412341234');
    expect(parsed.zkvmInput.votes[0].merklePath).toEqual(['0x' + 'c'.repeat(64)]);
    expect(parsed.scenarios).toEqual([]);
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
      requestMeta: {
        clientIp: '203.0.113.10',
        timestamp: 1730000000000,
        electionId: baseInput.electionId,
      },
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
      requestMeta: {
        clientIp: '203.0.113.10',
        timestamp: 1730000000000,
        electionId: baseInput.electionId,
      },
    } as const;

    expect(() => parseProverWorkMessage(raw)).toThrow(/contractGeneration/i);
  });

  it('accepts an optional inputS3Key', () => {
    const raw = {
      messageVersion: PROVER_WORK_MESSAGE_VERSION,
      sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
      contractGeneration: '2026-04-zkvm-current-v1',
      executionId: '01HVN5WA1CEH94868G90QGJ7HX',
      queuedAt: 1730000000000,
      expectedImageId: '0x' + '1'.repeat(64),
      electionConfig: buildDefaultElectionConfig(),
      zkvmInput: baseInput,
      inputS3Key: 'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json',
      requestMeta: {
        clientIp: '203.0.113.10',
        timestamp: 1730000000000,
        electionId: baseInput.electionId,
      },
    } as const;

    const parsed = parseProverWorkMessage(raw);

    expect(parsed.inputS3Key).toBe(
      'sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json',
    );
  });

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
      requestMeta: {
        clientIp: '203.0.113.10',
        timestamp: 1730000000000,
        electionId: baseInput.electionId,
      },
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
      requestMeta: {
        clientIp: '203.0.113.10',
        timestamp: 1730000000000,
        electionId: baseInput.electionId,
      },
    } as const;

    expect(() => parseProverWorkMessage(raw)).toThrow(/electionConfig/i);
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
      requestMeta: {
        clientIp: '203.0.113.10',
        timestamp: 1730000000000,
        electionId: baseInput.electionId,
      },
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
      requestMeta: {
        clientIp: '203.0.113.10',
        timestamp: 1730000000000,
        electionId: baseInput.electionId,
      },
    } as const;

    expect(() => parseProverWorkMessage(invalid)).toThrowError(/index/i);
  });
});

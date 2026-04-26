/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { buildInputUploadPayload, normalizeS3Prefix } from '../input-storage';
import type { ProverWorkMessage } from '../../../../src/lib/finalize/types';
import { PROVER_WORK_MESSAGE_VERSION } from '../../../../src/lib/finalize/types';
import { buildDefaultElectionConfig } from '../../../../src/lib/zkvm/election-config';

const baseMessage: ProverWorkMessage = {
  messageVersion: PROVER_WORK_MESSAGE_VERSION,
  sessionId: 'f4a2476f-21f3-4dde-8bc9-47cb0e606f3a',
  contractGeneration: '2026-04-zkvm-current-v1',
  executionId: '01HVN5WA1CEH94868G90QGJ7HX',
  queuedAt: 1730000000000,
  expectedImageId: '0x' + '1'.repeat(64),
  electionConfig: buildDefaultElectionConfig(),
  zkvmInput: {
    electionId: '8f9f3ab6-7a4c-4c28-89d9-8f1b94b52f24',
    bulletinRoot: '0x' + 'd'.repeat(64),
    treeSize: 65,
    logId: '0x' + 'e'.repeat(64),
    timestamp: 1730000000000,
    totalExpected: 65,
    electionConfigHash: '0x' + 'f'.repeat(64),
    votes: [
      {
        commitment: '0x' + 'a'.repeat(64),
        choice: 1,
        random: '0x' + 'b'.repeat(64),
        index: 0,
        merklePath: ['0x' + 'c'.repeat(64)],
      },
    ],
  },
  scenarios: [],
  simulateTampering: false,
  requestMeta: {
    clientIp: '203.0.113.10',
    timestamp: 1730000000000,
    electionId: '8f9f3ab6-7a4c-4c28-89d9-8f1b94b52f24',
  },
};

describe('normalizeS3Prefix', () => {
  it('normalizes leading and trailing slashes', () => {
    expect(normalizeS3Prefix('/sessions')).toBe('sessions/');
    expect(normalizeS3Prefix('sessions')).toBe('sessions/');
    expect(normalizeS3Prefix('sessions/')).toBe('sessions/');
  });

  it('returns empty string for empty prefix', () => {
    expect(normalizeS3Prefix('')).toBe('');
  });
});

describe('buildInputUploadPayload', () => {
  it('builds a deterministic key and JSON payload', () => {
    const payload = buildInputUploadPayload(baseMessage, 'sessions');

    expect(payload.key).toBe('sessions/f4a2476f-21f3-4dde-8bc9-47cb0e606f3a/01HVN5WA1CEH94868G90QGJ7HX/input.json');
    expect(payload.contentType).toBe('application/json');
    expect(payload.metadata.sessionId).toBe(baseMessage.sessionId);
    expect(payload.metadata.executionId).toBe(baseMessage.executionId);

    const parsed = JSON.parse(payload.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty('election_id');
    expect(parsed).toHaveProperty('bulletin_root');
    expect(parsed).toHaveProperty('tree_size');
    expect(parsed).toHaveProperty('total_expected');
    expect(parsed).toHaveProperty('election_config');
    expect(parsed).toHaveProperty('votes');
    expect(parsed.election_config).toEqual({
      totalExpected: 64,
      choices: ['A', 'B', 'C', 'D', 'E'],
      version: 'v1.0',
      botCount: 63,
      merkleTreeDepth: 6,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { parseSessionIdentityRecord, type SessionIdentityRecord } from './sessionRecords';

const identity: SessionIdentityRecord = {
  sessionId: '00000000-0000-4000-8000-000000000010',
  electionId: '00000000-0000-4000-8000-000000000020',
  electionConfigHash: `0x${'cd'.repeat(32)}`,
  electionConfig: {
    totalExpected: 64,
    choices: ['A', 'B', 'C', 'D', 'E'],
    version: 'v1.0',
    botCount: 63,
    merkleTreeDepth: 6,
  },
  logId: `0x${'ab'.repeat(32)}`,
  createdAtMs: 100,
};

describe('session record ownership admission', () => {
  it.each([
    ['votes', new Map()],
    ['bulletin', {}],
    ['finalization', {}],
    ['verificationResult', {}],
    ['verificationObservation', {}],
    ['deliveryMetadata', {}],
  ])('rejects identity records carrying lifecycle-owned field %s', (field, value) => {
    expect(parseSessionIdentityRecord({ ...identity, [field]: value })).toBeUndefined();
  });

  it.each([
    ['unknown key', { ...identity.electionConfig, runtimeProfile: 'local-demo' }],
    ['empty choices', { ...identity.electionConfig, choices: [] }],
    ['zero expected votes', { ...identity.electionConfig, totalExpected: 0 }],
    ['negative bot count', { ...identity.electionConfig, botCount: -1 }],
    ['zero Merkle depth', { ...identity.electionConfig, merkleTreeDepth: 0 }],
  ])('rejects an election configuration with %s', (_caseName, electionConfig) => {
    expect(parseSessionIdentityRecord({ ...identity, electionConfig })).toBeUndefined();
  });
});

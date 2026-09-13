import { describe, expect, it } from 'vitest';
import { parseSessionIdentityRecord, type SessionIdentityRecord } from './sessionRecords';
import { asSessionId } from './identifiers';

const identity: SessionIdentityRecord = {
  sessionId: asSessionId('00000000-0000-4000-8000-000000000010'),
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

describe('session identity value admission', () => {
  it('returns an independently owned exact identity record', () => {
    const parsed = parseSessionIdentityRecord(identity);

    expect(parsed).toEqual(identity);
    expect(parsed?.electionConfig.choices).not.toBe(identity.electionConfig.choices);
  });

  it('rejects an unsafe session identifier', () => {
    expect(parseSessionIdentityRecord({ ...identity, sessionId: '../another-session' })).toBeUndefined();
  });

  it('rejects malformed election and log identifiers', () => {
    expect(parseSessionIdentityRecord({ ...identity, electionId: 'not-an-election-id' })).toBeUndefined();
    expect(parseSessionIdentityRecord({ ...identity, logId: '0x1234' })).toBeUndefined();
  });

  it('rejects invalid creation and election configuration values', () => {
    expect(parseSessionIdentityRecord({ ...identity, createdAtMs: -1 })).toBeUndefined();
    expect(
      parseSessionIdentityRecord({
        ...identity,
        electionConfig: { ...identity.electionConfig, totalExpected: 0 },
      }),
    ).toBeUndefined();
  });
});

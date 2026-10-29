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

describe('session identity record admission', () => {
  it.each(['sessionId', 'electionId', 'electionConfigHash', 'electionConfig', 'logId', 'createdAtMs'] as const)(
    'rejects an identity record missing required field %s',
    (field) => {
      const incomplete = { ...identity };
      Reflect.deleteProperty(incomplete, field);

      expect(parseSessionIdentityRecord(incomplete)).toBeUndefined();
    },
  );

  it('rejects unknown keys instead of interpreting another record shape', () => {
    expect(parseSessionIdentityRecord({ ...identity, contractGeneration: 'retired-shape' })).toBeUndefined();
  });
});

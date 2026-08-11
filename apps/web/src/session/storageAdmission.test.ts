import { describe, expect, it } from 'vitest';
import { createTestJournal } from '@stark-ballot/test-support/testing/test-helpers';
import { resolveCanonicalFinalizationPayload } from '@stark-ballot/web/finalize/client-finalization-result';
import { admitStoredSessionData } from './storageAdmission';

const NOW = Date.parse('2026-07-31T00:00:00.000Z');
const SESSION_ID = '4cf60e4f-3d69-4a12-8973-8c913762cbcb';
const ELECTION_ID = 'eb678391-8ff8-48c8-8802-49b839128214';
const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;

function votingSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    capabilityToken: 'capability-token',
    electionId: ELECTION_ID,
    electionConfigHash: HEX_A,
    logId: HEX_B,
    phase: 'voting',
    lastActivity: NOW,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function finalizationSnapshot(): NonNullable<ReturnType<typeof resolveCanonicalFinalizationPayload>> {
  const snapshot = resolveCanonicalFinalizationPayload({
    finalizationId: 'finalization-1',
    tally: {
      counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
      totalVotes: 1,
      tamperedCount: 0,
    },
    imageId: `0x${'e'.repeat(64)}`,
    journal: createTestJournal({
      totalExpected: 1,
      validVotes: 1,
      missingSlots: 0,
      invalidPresentedSlots: 0,
      seenIndicesCount: 1,
    }),
  });
  if (!snapshot) {
    throw new Error('Failed to build canonical finalization snapshot');
  }
  return snapshot;
}

describe('admitStoredSessionData', () => {
  it('admits the exact current voting record', () => {
    const record = votingSession();

    expect(admitStoredSessionData(record)).toEqual(record);
  });

  it('rejects an unknown top-level key', () => {
    expect(admitStoredSessionData(votingSession({ retiredGeneration: 'old-shape' }))).toBeNull();
  });

  it.each(['sessionId', 'capabilityToken', 'electionId', 'electionConfigHash', 'logId'])(
    'rejects a record missing required identity field %s',
    (field) => {
      const record = votingSession();
      delete record[field];

      expect(admitStoredSessionData(record)).toBeNull();
    },
  );

  it.each([
    ['myVote', 'Z'],
    ['myCommit', 'not-hex'],
    ['myRand', 42],
    ['voteId', 'not-a-vote-id'],
    ['bulletinIndex', -1],
    ['bulletinRootAtCast', 'not-hex'],
  ])('rejects invalid optional field %s', (field, value) => {
    expect(admitStoredSessionData(votingSession({ [field]: value }))).toBeNull();
  });

  it('rejects partial private opening evidence', () => {
    expect(
      admitStoredSessionData(
        votingSession({
          myVote: 'A',
          myCommit: HEX_A,
        }),
      ),
    ).toBeNull();
  });

  it('rejects partial cast receipt evidence', () => {
    expect(
      admitStoredSessionData(
        votingSession({
          voteId: '6321f4a2-39b7-44fb-9b25-73118ed10ffc',
          bulletinIndex: 0,
        }),
      ),
    ).toBeNull();
  });

  it('admits complete private opening and cast receipt evidence', () => {
    const record = votingSession({
      myVote: 'A',
      myCommit: HEX_A,
      myRand: HEX_B,
      voteId: '6321f4a2-39b7-44fb-9b25-73118ed10ffc',
      bulletinIndex: 0,
      bulletinRootAtCast: HEX_A,
    });

    expect(admitStoredSessionData(record)).toEqual(record);
  });

  it.each(['voting', 'finalizing'])('rejects a finalization snapshot while phase is %s', (phase) => {
    expect(
      admitStoredSessionData(
        votingSession({
          phase,
          finalizeResult: finalizationSnapshot(),
        }),
      ),
    ).toBeNull();
  });

  it('rejects verifying phase without a finalization snapshot', () => {
    expect(admitStoredSessionData(votingSession({ phase: 'verifying' }))).toBeNull();
  });

  it('rejects a verification marker before verifying phase', () => {
    expect(admitStoredSessionData(votingSession({ verificationRequestedAt: NOW }))).toBeNull();
  });

  it('admits verifying phase with one exact finalization snapshot', () => {
    const record = votingSession({
      phase: 'verifying',
      finalizeResult: finalizationSnapshot(),
      verificationRequestedAt: NOW,
    });

    expect(admitStoredSessionData(record)).toEqual(record);
  });

  it('rejects unknown nested finalization fields instead of sanitizing them', () => {
    const snapshot = {
      ...finalizationSnapshot(),
      retiredDeliveryUrl: 'https://example.invalid/bundle.zip',
    };

    expect(
      admitStoredSessionData(
        votingSession({
          phase: 'verifying',
          finalizeResult: snapshot,
        }),
      ),
    ).toBeNull();
  });
});

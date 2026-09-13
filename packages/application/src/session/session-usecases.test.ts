import { describe, expect, it, vi } from 'vitest';
import { ApplicationErrorCode } from '@stark-ballot/application';
import { asSessionId } from '@stark-ballot/domain/types/identifiers';
import type { SessionIdentityRecord } from '@stark-ballot/domain/types/sessionRecords';
import {
  buildDefaultElectionConfig,
  getDefaultElectionConfigHash,
} from '@stark-ballot/zkvm-contract/zkvm/election-config';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { buildSessionRecords } from './session-mutation-policy';
import { createSessionWithinCapacity } from './create-session';
import { prepareUserVoteSubmission } from './submit-vote';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';

const SESSION_ID = asSessionId('00000000-0000-4000-8000-000000000010');
const ELECTION_ID = '00000000-0000-4000-8000-000000000020';
const LOG_ID = `0x${'ab'.repeat(32)}`;

function identity(): SessionIdentityRecord {
  return {
    sessionId: SESSION_ID,
    electionId: ELECTION_ID,
    electionConfigHash: getDefaultElectionConfigHash(),
    electionConfig: buildDefaultElectionConfig(),
    logId: LOG_ID,
    createdAtMs: 100,
  };
}

describe('session application use cases', () => {
  it('returns a capacity outcome without attempting session creation', async () => {
    const createSession = vi.fn(() => Promise.resolve(identity()));

    const result = await createSessionWithinCapacity(
      { getActiveSessionCount: () => Promise.resolve(2), createSession },
      2,
    );

    expect(result).toEqual({ ok: false, error: { code: ApplicationErrorCode.SESSION_LIMIT_EXCEEDED } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('admits the complete identity returned by the session store', async () => {
    const expected = identity();

    const result = await createSessionWithinCapacity(
      { getActiveSessionCount: () => Promise.resolve(0), createSession: () => Promise.resolve(expected) },
      2,
    );

    expect(result).toEqual({ ok: true, value: expected });
  });

  it('keeps storage and infrastructure failures exceptional', async () => {
    const failure = new Error('session count unavailable');

    await expect(
      createSessionWithinCapacity(
        {
          getActiveSessionCount: () => Promise.reject(failure),
          createSession: () => Promise.resolve(identity()),
        },
        2,
      ),
    ).rejects.toBe(failure);
  });

  it('returns a bounded internal outcome when an adapter violates its identity contract', async () => {
    const result = await createSessionWithinCapacity(
      {
        getActiveSessionCount: () => Promise.resolve(0),
        createSession: () => Promise.resolve({ sessionId: SESSION_ID } as SessionIdentityRecord),
      },
      2,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: { details: 'Session store returned incomplete identity authority' },
      },
    });
  });

  it('turns vote prechecks into code-specific outcomes and prepares the canonical command', () => {
    const records = buildSessionRecords({
      ...identity(),
      lastActivityMs: 101,
    });
    const rand = `0x${'11'.repeat(32)}`;
    const commitment = computeCommitment(ELECTION_ID, 0, rand);

    expect(
      prepareUserVoteSubmission(
        { ...records, finalization: null },
        {
          voteId: '00000000-0000-4000-8000-000000000030',
          timestamp: 200,
          vote: 'A',
          rand,
          commitment,
        },
      ),
    ).toEqual({
      ok: true,
      value: {
        commitment,
        command: {
          voteId: '00000000-0000-4000-8000-000000000030',
          timestamp: 200,
          vote: 'A',
          rand,
        },
      },
    });
  });

  it('rejects an invalid commitment before persistence', () => {
    const records = buildSessionRecords({ ...identity(), lastActivityMs: 101 });

    const run = () =>
      prepareUserVoteSubmission(
        { ...records, finalization: null },
        {
          voteId: '00000000-0000-4000-8000-000000000030',
          timestamp: 200,
          vote: 'A',
          rand: `0x${'11'.repeat(32)}`,
          commitment: `0x${'22'.repeat(32)}`,
        },
      );

    expect(run()).toEqual({ ok: false, error: { code: ApplicationErrorCode.INVALID_COMMITMENT } });
  });

  it('rejects a cast marker without its saved vote authority', () => {
    const records = buildSessionRecords({ ...identity(), lastActivityMs: 101 });
    const run = () =>
      prepareUserVoteSubmission(
        {
          ...records,
          voting: { ...records.voting, userParticipation: { status: 'cast', voteIndex: 0 } },
          finalization: {} as FinalizationRecord,
        },
        {
          voteId: '00000000-0000-4000-8000-000000000030',
          timestamp: 200,
          vote: 'A',
          rand: `0x${'11'.repeat(32)}`,
          commitment: computeCommitment(ELECTION_ID, 0, `0x${'11'.repeat(32)}`),
        },
      );

    expect(run).toThrow('Invalid stored user vote authority');
  });
});

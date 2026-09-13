import { describe, expect, it } from 'vitest';
import { SimpleBulletinBoard } from './simple-bulletin-board';
import type { PreparedVote, RootSnapshot, StoredVoteRecord } from '../../types/sessionRecords';
import { stageCtVoteWrites, type CtVoteWriteAuthority } from './stagedCtVoteWrite';
import { asSessionId } from '../../types/identifiers';

const LOG_ID = `0x${'ab'.repeat(32)}`;
const EXISTING_VOTE_ID = '00000000-0000-4000-8000-000000000001';
const FIRST_NEW_VOTE_ID = '00000000-0000-4000-8000-000000000002';
const SECOND_NEW_VOTE_ID = '00000000-0000-4000-8000-000000000003';

function buildVote(voteId: string, commitmentNibble: string): PreparedVote {
  return {
    voteId,
    vote: 'A',
    rand: `0x${'11'.repeat(32)}`,
    commit: `0x${commitmentNibble.repeat(64)}`,
    timestamp: 50,
  };
}

function buildAuthority() {
  const bulletin = new SimpleBulletinBoard(LOG_ID);
  const existingVote = buildVote(EXISTING_VOTE_ID, '1');
  const appended = bulletin.appendVote(EXISTING_VOTE_ID, existingVote.commit.slice(2));
  const rootHistory: RootSnapshot[] = [
    {
      timestamp: 123,
      root: `0x${appended.rootAtAppend}`,
      treeSize: 1,
      signature: 'preserved-signature',
    },
  ];
  const storedVote: StoredVoteRecord = {
    voteId: EXISTING_VOTE_ID,
    vote: existingVote.vote,
    rand: existingVote.rand,
    commit: existingVote.commit,
    timestamp: 123,
    rootAtCast: `0x${appended.rootAtAppend}`,
  };

  return {
    sessionId: asSessionId('session-stage'),
    votes: new Map([[0, storedVote]]),
    bulletin,
    bulletinRootHistory: rootHistory,
  };
}

describe('staged CT vote writes', () => {
  it('stages index-ordered appends without mutating the source authority', () => {
    const authority = buildAuthority();

    const staged = stageCtVoteWrites(authority, [
      { index: 2, vote: buildVote(SECOND_NEW_VOTE_ID, '3') },
      { index: 1, vote: buildVote(FIRST_NEW_VOTE_ID, '2') },
    ]);

    expect(staged.votes.map(({ index, voteId }) => ({ index, voteId }))).toEqual([
      { index: 1, voteId: FIRST_NEW_VOTE_ID },
      { index: 2, voteId: SECOND_NEW_VOTE_ID },
    ]);
    expect(staged.bulletin.getSize()).toBe(3);
    expect(staged.bulletinRootHistory).toHaveLength(3);
    expect(staged.bulletinRootHistory[0]).toEqual(authority.bulletinRootHistory[0]);
    expect(staged.votes[0]?.storedVote.rootAtCast).toBe(`0x${staged.bulletinRootHistory[1]?.root}`);
    expect(staged.votes[1]?.storedVote.rootAtCast).toBe(`0x${staged.bulletinRootHistory[2]?.root}`);

    expect(authority.votes.size).toBe(1);
    expect(authority.bulletin.getSize()).toBe(1);
    expect(authority.bulletinRootHistory).toHaveLength(1);
  });

  it('fails a malformed batch without mutating the source authority', () => {
    const authority = buildAuthority();
    const sourceRoot = authority.bulletin.getCurrentRoot();

    expect(() =>
      stageCtVoteWrites(authority, [
        { index: 1, vote: buildVote(FIRST_NEW_VOTE_ID, '2') },
        { index: 2, vote: buildVote('not-a-uuid', '3') },
      ]),
    ).toThrow('Invalid vote ID format');

    expect(authority.votes.size).toBe(1);
    expect(authority.bulletin.getSize()).toBe(1);
    expect(authority.bulletin.getCurrentRoot()).toBe(sourceRoot);
    expect(authority.bulletinRootHistory).toHaveLength(1);
  });

  it('preserves the established fail-closed errors', () => {
    const authority = buildAuthority();
    const authorityWithoutBulletin = {
      sessionId: authority.sessionId,
      votes: authority.votes,
      bulletinRootHistory: authority.bulletinRootHistory,
    } as unknown as CtVoteWriteAuthority;

    expect(() => stageCtVoteWrites(authorityWithoutBulletin, [])).toThrow('CT_PROOF_UNAVAILABLE');
    expect(() =>
      stageCtVoteWrites(authority, [
        { index: 1, vote: buildVote(FIRST_NEW_VOTE_ID, '2') },
        { index: 1, vote: buildVote(SECOND_NEW_VOTE_ID, '3') },
      ]),
    ).toThrow('Duplicate staged vote index: 1');
    expect(() => stageCtVoteWrites(authority, [{ index: 1, vote: buildVote(EXISTING_VOTE_ID, '2') }])).toThrow(
      'Vote ID already exists',
    );
  });

  it('rejects non-canonical existing and staged vote indices', () => {
    const sparseAuthority = buildAuthority();
    const existingVote = sparseAuthority.votes.get(0);
    if (!existingVote) {
      throw new Error('Expected existing vote');
    }
    sparseAuthority.votes = new Map([[2, existingVote]]);

    expect(() => stageCtVoteWrites(sparseAuthority, [{ index: 3, vote: buildVote(FIRST_NEW_VOTE_ID, '2') }])).toThrow(
      'NON_CANONICAL_CT_VOTE_INDICES',
    );

    const authority = buildAuthority();
    expect(() => stageCtVoteWrites(authority, [{ index: 0, vote: buildVote(FIRST_NEW_VOTE_ID, '2') }])).toThrow(
      'NON_CANONICAL_CT_VOTE_INDICES',
    );
    expect(() => stageCtVoteWrites(authority, [{ index: 2, vote: buildVote(FIRST_NEW_VOTE_ID, '2') }])).toThrow(
      'NON_CANONICAL_CT_VOTE_INDICES',
    );

    expect(authority.votes.size).toBe(1);
    expect(authority.bulletin.getSize()).toBe(1);
  });
});

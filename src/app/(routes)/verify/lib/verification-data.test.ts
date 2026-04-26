import { describe, expect, it } from 'vitest';
import type { SessionData } from '@/lib/session/types';
import { VERIFICATION_CHECK_DEFINITIONS } from '@/lib/verification/verification-checks';
import { computeCommitment } from '@/lib/zkvm/types';
import { createTestJournal } from '@/lib/testing/test-helpers';
import {
  applyLocalCastAsIntended,
  buildAuthenticatedBundleDownloadUrl,
  buildBundleCandidates,
  buildDetectionReceipt,
  parseVerificationPayload,
} from './verification-data';

describe('parseVerificationPayload', () => {
  it('should parse canonical bulletinRoot fields', () => {
    const payload = {
      bulletinRoot: '0xcanonical-root',
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0xcommit',
        bulletinIndex: 7,
        bulletinRootAtCast: '0xroot-at-cast',
        timestamp: 1730000000000,
      },
      inputCommitment: '0xinput-commit',
    };

    const parsed = parseVerificationPayload(payload);

    expect(parsed.bulletinRoot).toBe('0xcanonical-root');
    expect(parsed.inputCommitment).toBe('0xinput-commit');
    expect(parsed.voteReceipt?.bulletinRootAtCast).toBe('0xroot-at-cast');
  });

  it('should drop userVote and voteReceipt missing required canonical fields', () => {
    const payload = {
      userVote: {
        vote: 'A',
        voteId: 'vote-1',
      },
      voteReceipt: {
        voteId: 'vote-1',
        commitment: '0xcommit',
        bulletinRootAtCast: '0xroot-at-cast',
        timestamp: 1730000000000,
      },
    };

    const parsed = parseVerificationPayload(payload);

    expect(parsed.userVote).toBeUndefined();
    expect(parsed.voteReceipt).toBeUndefined();
  });

  it('drops inclusion proofs that still carry proofMode', () => {
    const parsed = parseVerificationPayload({
      userVote: {
        vote: 'A',
        commitment: '0xcommit',
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: [],
          bulletinRootAtCast: '0xroot-at-cast',
          proofMode: 'rfc6962',
        },
      },
    });

    expect(parsed.userVote?.proof).toBeUndefined();
  });

  it('prefers canonical journal-derived proof fields over stale top-level copies', () => {
    const journal = createTestJournal({
      totalExpected: 64,
      validVotes: 61,
      missingIndices: 1,
      invalidIndices: 2,
    });

    const parsed = parseVerificationPayload({
      bulletinRoot: '0x' + '1'.repeat(64),
      treeSize: 999,
      totalExpected: 999,
      missingIndices: 99,
      invalidIndices: 98,
      countedIndices: 0,
      rejectedRecords: 77,
      sthDigest: '0x' + '2'.repeat(64),
      seenBitmapRoot: '0x' + '3'.repeat(64),
      includedBitmapRoot: '0x' + '4'.repeat(64),
      inputCommitment: '0x' + '5'.repeat(64),
      journal,
    });

    expect(parsed.bulletinRoot).toBe(journal.bulletinRoot);
    expect(parsed.treeSize).toBe(journal.treeSize);
    expect(parsed.totalExpected).toBe(journal.totalExpected);
    expect(parsed.missingSlots).toBe(journal.missingSlots);
    expect(parsed.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(parsed.missingSlots).toBe(journal.missingSlots);
    expect(parsed.invalidPresentedSlots).toBe(journal.invalidPresentedSlots);
    expect(parsed.validVotes).toBe(journal.validVotes);
    expect(parsed.rejectedRecords).toBe(journal.rejectedRecords);
    expect(parsed.seenIndicesCount).toBe(journal.seenIndicesCount);
    expect(parsed.excludedSlots).toBe(journal.excludedSlots);
    expect(parsed.excludedSlots).toBe(journal.excludedSlots);
    expect(parsed.sthDigest).toBe(journal.sthDigest);
    expect(parsed.seenBitmapRoot).toBe(journal.seenBitmapRoot);
    expect(parsed.includedBitmapRoot).toBe(journal.includedBitmapRoot);
    expect(parsed.inputCommitment).toBe(journal.inputCommitment);
  });

  it('drops an unsafe verificationExecutionId instead of keeping it as download authority', () => {
    const parsed = parseVerificationPayload({
      verificationExecutionId: '../../progress',
    });

    expect(parsed.verificationExecutionId).toBeUndefined();
  });
});

describe('buildDetectionReceipt', () => {
  it('uses canonical count fields without reintroducing legacy aliases', () => {
    const receipt = buildDetectionReceipt({
      tally: {
        counts: { A: 61, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 61,
        tamperedCount: 3,
      },
      bulletinRoot: '0x' + '1'.repeat(64),
      missingSlots: 1,
      invalidPresentedSlots: 2,
      rejectedRecords: 2,
      excludedSlots: 3,
      validVotes: 61,
      verifiedTally: [61, 0, 0, 0, 0],
    });

    expect(receipt).toMatchObject({
      missingSlots: 1,
      invalidPresentedSlots: 2,
      rejectedRecords: 2,
      excludedSlots: 3,
      validVotes: 61,
    });
    expect(receipt).not.toHaveProperty('missingIndices');
    expect(receipt).not.toHaveProperty('invalidIndices');
    expect(receipt).not.toHaveProperty('countedIndices');
  });
});

describe('buildBundleCandidates', () => {
  it('derives only the authenticated bundle endpoint from sessionId and verificationExecutionId', () => {
    const candidates = buildBundleCandidates(
      {
        verificationExecutionId: 'exec-1',
      },
      'session-1',
    );

    expect(candidates).toEqual([
      {
        url: buildAuthenticatedBundleDownloadUrl('session-1', 'exec-1'),
        source: 'authenticated-endpoint',
        sessionId: 'session-1',
        executionId: 'exec-1',
      },
    ]);
  });

  it('returns no download candidates when executionId authority is unavailable', () => {
    const candidates = buildBundleCandidates({});

    expect(candidates).toEqual([]);
  });

  it('returns no download candidates when either selector segment is unsafe', () => {
    expect(
      buildBundleCandidates(
        {
          verificationExecutionId: '../exec-1',
        },
        'session-1',
      ),
    ).toEqual([]);

    expect(
      buildBundleCandidates(
        {
          verificationExecutionId: 'exec-1',
        },
        '../session-1',
      ),
    ).toEqual([]);
  });
});

describe('applyLocalCastAsIntended', () => {
  const electionId = '550e8400-e29b-41d4-a716-446655440000';
  const random = '0x' + 'a'.repeat(64);
  const commitment = computeCommitment(electionId, 0, random);

  const serverChecks = VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    status: 'success' as const,
    evidence: definition.evidence,
    inputs: definition.inputs,
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));

  it('overrides server cast success with local cast failure', () => {
    const payload = {
      electionId,
      verificationChecks: serverChecks,
      verificationSteps: [
        { id: 'cast_as_intended' as const, status: 'success' as const, inputs: [] },
        { id: 'recorded_as_cast' as const, status: 'success' as const, inputs: [] },
      ],
      voteReceipt: {
        voteId: 'vote-1',
        commitment,
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '1'.repeat(64),
        timestamp: 1730000000000,
      },
    };
    const session: SessionData = {
      sessionId: 'session-1',
      capabilityToken: 'capability',
      lastActivity: Date.now(),
      electionId,
      myVote: 'B',
      myRand: random,
    };

    const parsed = applyLocalCastAsIntended(payload, session);
    const castCommitment = parsed.verificationChecks?.find((check) => check.id === 'cast_commitment_match');

    expect(castCommitment?.status).toBe('failed');
    expect(parsed.verificationSteps?.find((step) => step.id === 'cast_as_intended')?.status).toBe('failed');
    expect(parsed.verificationChecks?.find((check) => check.id === 'recorded_inclusion_proof')?.status).toBe('success');
  });

  it('marks cast step as not_run when local intent is missing', () => {
    const payload = {
      electionId,
      verificationChecks: serverChecks,
      verificationSteps: [{ id: 'cast_as_intended' as const, status: 'success' as const, inputs: [] }],
      voteReceipt: {
        voteId: 'vote-1',
        commitment,
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '1'.repeat(64),
        timestamp: 1730000000000,
      },
    };
    const session: SessionData = {
      sessionId: 'session-1',
      capabilityToken: 'capability',
      lastActivity: Date.now(),
      electionId,
    };

    const parsed = applyLocalCastAsIntended(payload, session);

    expect(parsed.verificationChecks?.find((check) => check.id === 'cast_choice_range')?.status).toBe('not_run');
    expect(parsed.verificationChecks?.find((check) => check.id === 'cast_random_format')?.status).toBe('not_run');
    expect(parsed.verificationChecks?.find((check) => check.id === 'cast_commitment_match')?.status).toBe('not_run');
    expect(parsed.verificationSteps?.find((step) => step.id === 'cast_as_intended')?.status).toBe('not_run');
  });

  it('creates cast checks when verificationChecks are missing', () => {
    const payload = {
      electionId,
      verificationSteps: [{ id: 'recorded_as_cast' as const, status: 'success' as const, inputs: [] }],
      voteReceipt: {
        voteId: 'vote-1',
        commitment,
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '1'.repeat(64),
        timestamp: 1730000000000,
      },
    };
    const session: SessionData = {
      sessionId: 'session-1',
      capabilityToken: 'capability',
      lastActivity: Date.now(),
      electionId,
      myVote: 'A',
      myRand: random,
    };

    const parsed = applyLocalCastAsIntended(payload, session);

    const castChecks = parsed.verificationChecks?.filter((check) => check.id.startsWith('cast_')) ?? [];
    expect(castChecks).toHaveLength(4);
    expect(parsed.verificationChecks?.find((check) => check.id === 'cast_commitment_match')?.status).toBe('success');
  });

  it('creates cast step when verificationSteps are missing', () => {
    const payload = {
      electionId,
      verificationChecks: serverChecks,
      voteReceipt: {
        voteId: 'vote-1',
        commitment,
        bulletinIndex: 0,
        bulletinRootAtCast: '0x' + '1'.repeat(64),
        timestamp: 1730000000000,
      },
    };
    const session: SessionData = {
      sessionId: 'session-1',
      capabilityToken: 'capability',
      lastActivity: Date.now(),
      electionId,
      myVote: 'A',
      myRand: random,
    };

    const parsed = applyLocalCastAsIntended(payload, session);

    expect(parsed.verificationSteps?.find((step) => step.id === 'cast_as_intended')?.status).toBe('success');
  });
});

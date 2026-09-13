import { describe, expect, it } from 'vitest';
import {
  LOCAL_CAST_CHECK_IDS,
  evaluateLocalCastChecks,
  overlayLocalCastChecks,
  projectLocalCastStatuses,
} from '@stark-ballot/verification/local-cast-checks';
import { evaluateChecks } from '@stark-ballot/verification/check-evaluator';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import type { VoteChoice } from '@stark-ballot/verification/shared/constants';
import type { VoteReceipt } from '@stark-ballot/verification/shared/types';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';

const ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const RANDOM = `0x${'a'.repeat(64)}`;
const COMMITMENT = computeCommitment(ELECTION_ID, 0, RANDOM);

function buildReceipt(overrides: Partial<VoteReceipt> = {}): VoteReceipt {
  return {
    voteId: 'vote-1',
    commitment: COMMITMENT,
    bulletinIndex: 0,
    bulletinRootAtCast: `0x${'1'.repeat(64)}`,
    timestamp: 1_730_000_000_000,
    ...overrides,
  };
}

function buildCanonicalServerChecks(): VerificationCheck[] {
  return VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    status: 'success',
    evidence: definition.evidence,
    inputs: [...definition.inputs],
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));
}

describe('evaluateLocalCastChecks', () => {
  it('evaluates the exact four browser-local checks without returning private inputs', () => {
    const results = evaluateLocalCastChecks({
      electionId: ELECTION_ID,
      voteReceipt: buildReceipt(),
      choice: 'A',
      random: RANDOM,
    });

    expect(projectLocalCastStatuses(results)).toEqual({
      cast_receipt_present: 'success',
      cast_choice_range: 'success',
      cast_random_format: 'success',
      cast_commitment_match: 'success',
    });
    expect(JSON.stringify(results)).not.toContain(ELECTION_ID);
    expect(JSON.stringify(results)).not.toContain(RANDOM);
  });

  it('preserves not-run semantics when the locally held opening is absent', () => {
    const results = evaluateLocalCastChecks({
      voteReceipt: buildReceipt(),
    });

    expect(projectLocalCastStatuses(results)).toEqual({
      cast_receipt_present: 'success',
      cast_choice_range: 'not_run',
      cast_random_format: 'not_run',
      cast_commitment_match: 'not_run',
    });
  });

  it('preserves malformed receipt, choice, random, and commitment failure semantics', () => {
    const missingVoteId = evaluateLocalCastChecks({
      electionId: ELECTION_ID,
      voteReceipt: { ...buildReceipt(), voteId: '' },
      choice: 'A',
      random: RANDOM,
    });
    expect(missingVoteId.cast_receipt_present).toEqual({
      status: 'failed',
      error: 'Invalid receipt: missing commitment or voteId',
    });

    const invalidChoice = evaluateLocalCastChecks({
      electionId: ELECTION_ID,
      voteReceipt: buildReceipt(),
      choice: 'Z' as VoteChoice,
      random: RANDOM,
    });
    expect(invalidChoice.cast_choice_range).toEqual({
      status: 'failed',
      error: 'Unknown vote choice "Z".',
    });
    expect(invalidChoice.cast_commitment_match).toEqual({
      status: 'failed',
      error: 'Unknown vote choice "Z".',
    });

    const invalidRandom = evaluateLocalCastChecks({
      electionId: ELECTION_ID,
      voteReceipt: buildReceipt(),
      choice: 'A',
      random: 'not-random',
    });
    expect(invalidRandom.cast_random_format).toEqual({
      status: 'failed',
      error: 'Random value must be a 32-byte hex string.',
    });
    expect(invalidRandom.cast_commitment_match.status).toBe('failed');

    const mismatch = evaluateLocalCastChecks({
      electionId: ELECTION_ID,
      voteReceipt: buildReceipt({ commitment: `0x${'f'.repeat(64)}` }),
      choice: 'A',
      random: RANDOM,
    });
    expect(mismatch.cast_commitment_match).toEqual({
      status: 'failed',
      error: 'Commitment mismatch between receipt and recomputed value.',
    });
  });

  it('matches the check evaluator for the same local evidence', async () => {
    const input = {
      electionId: ELECTION_ID,
      voteReceipt: buildReceipt(),
      choice: 'A' as const,
      random: RANDOM,
    };
    const direct = evaluateLocalCastChecks(input);
    const evaluator = await evaluateChecks(
      {
        electionId: input.electionId,
        voteReceipt: input.voteReceipt,
        userVote: {
          vote: input.choice,
          random: input.random,
        },
      },
      LOCAL_CAST_CHECK_IDS,
      { applyZkGate: false },
    );

    for (const id of LOCAL_CAST_CHECK_IDS) {
      expect(evaluator.get(id)).toEqual(direct[id]);
    }
  });
});

describe('overlayLocalCastChecks', () => {
  it('replaces only the canonical local checks and preserves server ordering', () => {
    const serverChecks = buildCanonicalServerChecks();
    const localResults = evaluateLocalCastChecks({
      electionId: ELECTION_ID,
      voteReceipt: buildReceipt({ commitment: `0x${'f'.repeat(64)}` }),
      choice: 'A',
      random: RANDOM,
    });

    const overlaid = overlayLocalCastChecks(serverChecks, localResults);

    expect(overlaid).not.toBeNull();
    expect(overlaid?.map((check) => check.id)).toEqual(serverChecks.map((check) => check.id));
    expect(overlaid?.find((check) => check.id === 'cast_commitment_match')?.status).toBe('failed');
    expect(overlaid?.find((check) => check.id === 'recorded_inclusion_proof')).toEqual(
      serverChecks.find((check) => check.id === 'recorded_inclusion_proof'),
    );
  });

  it('fails closed for missing, duplicate, or unknown server check identities', () => {
    const serverChecks = buildCanonicalServerChecks();
    const localResults = evaluateLocalCastChecks({});
    const first = serverChecks[0];
    if (!first) {
      throw new Error('Expected a canonical verification check');
    }

    expect(overlayLocalCastChecks(serverChecks.slice(1), localResults)).toBeNull();
    expect(overlayLocalCastChecks([...serverChecks, first], localResults)).toBeNull();
    expect(
      overlayLocalCastChecks(
        [
          ...serverChecks.slice(0, -1),
          {
            ...first,
            id: 'future_check' as VerificationCheckId,
          },
        ],
        localResults,
      ),
    ).toBeNull();
  });
});

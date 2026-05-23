import { describe, it, expect } from 'vitest';
import type { VerificationStepStatus } from '@/lib/knowledge';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@/lib/verification/verification-checks';
import { deriveVerificationSummary } from '@/lib/verification/verification-summary';

const buildChecks = (
  overrides: Partial<Record<VerificationCheckId, VerificationStepStatus>> = {},
): VerificationCheck[] =>
  VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    status: overrides[definition.id] ?? 'success',
    evidence: definition.evidence,
    inputs: definition.inputs,
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));

describe('deriveVerificationSummary', () => {
  it('returns null when no checks are provided', () => {
    expect(deriveVerificationSummary()).toBeNull();
    expect(deriveVerificationSummary([])).toBeNull();
  });

  it('returns null when only unknown checks are provided', () => {
    const checks: VerificationCheck[] = [
      {
        id: 'future_check' as VerificationCheckId,
        status: 'success',
        evidence: 'demo',
        inputs: [],
      },
    ];

    expect(deriveVerificationSummary(checks)).toBeNull();
  });

  it('returns non-null warning when optional known and unknown checks are mixed', () => {
    const definition = VERIFICATION_CHECK_DEFINITIONS.find((candidate) => candidate.id === 'recorded_sth_third_party');
    expect(definition).toBeDefined();

    const checks: VerificationCheck[] = [
      {
        id: 'recorded_sth_third_party',
        status: 'success',
        evidence: definition?.evidence ?? 'public',
        inputs: definition?.inputs ?? [],
      },
      {
        id: 'future_check' as VerificationCheckId,
        status: 'success',
        evidence: 'demo',
        inputs: [],
      },
    ];

    expect(deriveVerificationSummary(checks)).toEqual({ status: 'missing_evidence', tone: 'warning' });
  });

  it('returns non-null warning when known checks include no required known checks', () => {
    const definition = VERIFICATION_CHECK_DEFINITIONS.find((candidate) => candidate.id === 'recorded_sth_third_party');
    expect(definition).toBeDefined();

    const checks: VerificationCheck[] = [
      {
        id: 'recorded_sth_third_party',
        status: 'success',
        evidence: definition?.evidence ?? 'public',
        inputs: definition?.inputs ?? [],
      },
    ];

    expect(deriveVerificationSummary(checks)).toEqual({ status: 'missing_evidence', tone: 'warning' });
  });

  it('returns in_progress when a required check is pending', () => {
    const checks = buildChecks({ cast_receipt_present: 'pending' });
    expect(deriveVerificationSummary(checks)?.status).toBe('in_progress');
  });

  it('returns proof_verification_failed when a proof check fails', () => {
    const checks = buildChecks({ stark_receipt_verify: 'failed' });
    expect(deriveVerificationSummary(checks)?.status).toBe('proof_verification_failed');
  });

  it('returns user_vote_excluded when completeness fails and user inclusion fails', () => {
    const checks = buildChecks({
      counted_missing_indices_zero: 'failed',
      counted_my_vote_included: 'failed',
    });
    expect(deriveVerificationSummary(checks)?.status).toBe('user_vote_excluded');
  });

  it('returns votes_excluded when completeness fails and user inclusion succeeds', () => {
    const checks = buildChecks({
      counted_missing_indices_zero: 'failed',
      counted_my_vote_included: 'success',
    });
    expect(deriveVerificationSummary(checks)?.status).toBe('votes_excluded');
  });

  it('returns votes_excluded_unknown when completeness fails and user inclusion is unknown', () => {
    const checks = buildChecks({
      counted_missing_indices_zero: 'failed',
      counted_my_vote_included: 'not_run',
    });
    expect(deriveVerificationSummary(checks)?.status).toBe('votes_excluded_unknown');
  });

  it('returns recorded_integrity_failed when recorded checks fail', () => {
    const checks = buildChecks({ recorded_consistency_proof: 'failed' });
    expect(deriveVerificationSummary(checks)?.status).toBe('recorded_integrity_failed');
  });

  it('prioritizes recorded_integrity_failed over published tally mismatch', () => {
    const checks = buildChecks({
      recorded_consistency_proof: 'failed',
      counted_tally_consistent: 'failed',
    });
    expect(deriveVerificationSummary(checks)?.status).toBe('recorded_integrity_failed');
  });

  it('returns published_tally_mismatch when tally consistency fails but integrity roles succeed', () => {
    const checks = buildChecks({ counted_tally_consistent: 'failed' });
    expect(deriveVerificationSummary(checks)?.status).toBe('published_tally_mismatch');
  });

  it('falls back to counted_integrity_failed when tally input integrity is not successful', () => {
    const checks = buildChecks({
      counted_tally_consistent: 'failed',
      counted_input_sanity: 'failed',
    });
    expect(deriveVerificationSummary(checks)?.status).toBe('counted_integrity_failed');
  });

  it('returns counted_integrity_failed when counted integrity checks fail', () => {
    const checks = buildChecks({ counted_input_sanity: 'failed' });
    expect(deriveVerificationSummary(checks)?.status).toBe('counted_integrity_failed');
  });

  it('returns cast_integrity_failed when cast checks fail', () => {
    const checks = buildChecks({ cast_commitment_match: 'failed' });
    expect(deriveVerificationSummary(checks)?.status).toBe('cast_integrity_failed');
  });

  it('returns missing_evidence when a required check is not run', () => {
    const checks = buildChecks({ cast_random_format: 'not_run' });
    expect(deriveVerificationSummary(checks)?.status).toBe('missing_evidence');
  });

  it('returns missing_evidence when completeness is not run', () => {
    const checks = buildChecks({ counted_missing_indices_zero: 'not_run' });
    expect(deriveVerificationSummary(checks)?.status).toBe('missing_evidence');
  });

  it('returns missing_evidence when user inclusion is not run', () => {
    const checks = buildChecks({ counted_my_vote_included: 'not_run' });
    expect(deriveVerificationSummary(checks)?.status).toBe('missing_evidence');
  });

  it('returns verified_with_limitations when optional checks are unavailable', () => {
    const checks = buildChecks({ recorded_sth_third_party: 'not_run' });
    expect(deriveVerificationSummary(checks)?.status).toBe('verified_with_limitations');
  });

  it('returns fully_verified when all required checks succeed', () => {
    const checks = buildChecks();
    expect(deriveVerificationSummary(checks)?.status).toBe('fully_verified');
  });

  it('prioritizes proof failures over completeness failures', () => {
    const checks = buildChecks({
      stark_receipt_verify: 'failed',
      counted_missing_indices_zero: 'failed',
    });
    expect(deriveVerificationSummary(checks)?.status).toBe('proof_verification_failed');
  });

  it('prioritizes proof failures over published tally mismatch', () => {
    const checks = buildChecks({
      stark_receipt_verify: 'failed',
      counted_tally_consistent: 'failed',
    });
    expect(deriveVerificationSummary(checks)?.status).toBe('proof_verification_failed');
  });

  it('returns missing_evidence when a required check is missing', () => {
    const checks = buildChecks().filter((check) => check.id !== 'cast_receipt_present');
    expect(deriveVerificationSummary(checks)?.status).toBe('missing_evidence');
  });

  it('treats STH checks as required when sources are configured', () => {
    const checks = buildChecks({ recorded_sth_third_party: 'failed' });
    const summary = deriveVerificationSummary(checks, { sthSourcesConfigured: true });
    expect(summary?.status).toBe('recorded_integrity_failed');
  });

  it('returns missing-specific message key when votes are missing', () => {
    const checks = buildChecks({
      counted_missing_indices_zero: 'failed',
      counted_my_vote_included: 'success',
    });
    const summary = deriveVerificationSummary(checks, { missingSlots: 1, invalidPresentedSlots: 0 });
    expect(summary?.status).toBe('votes_excluded');
    expect(summary?.messageKey).toBe('pages.verify.resultSummary.votesMissingSub');
  });

  it('returns invalid-specific message key when votes are invalidated', () => {
    const checks = buildChecks({
      counted_missing_indices_zero: 'failed',
      counted_my_vote_included: 'failed',
    });
    const summary = deriveVerificationSummary(checks, { missingSlots: 0, invalidPresentedSlots: 1 });
    expect(summary?.status).toBe('user_vote_excluded');
    expect(summary?.messageKey).toBe('pages.verify.resultSummary.userVoteInvalidSub');
  });
});

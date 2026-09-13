import { describe, expect, it } from 'vitest';
import type { AvailableVerificationResource } from '@stark-ballot/api-contract/schemas/verification';
import type { SessionData } from '@stark-ballot/web/session/types';
import { VERIFICATION_CHECK_DEFINITIONS } from '@stark-ballot/verification/checks';
import { computeCommitment } from '@stark-ballot/zkvm-contract/zkvm/types';
import { deriveVerificationPresentationPolicy } from '@stark-ballot/verification/presentation-policy';
import {
  buildAuthenticatedBundleDownloadUrl,
  buildAuthenticatedReportDownloadUrl,
} from '@stark-ballot/web/api/artifacts';
import { projectVerificationResource, resolveBundleCandidate, resolveReportCandidate } from './verification-data';
import { admitVerificationResourceSnapshot } from './verification-response-admission';
import { resolveEligibleRenderedVerificationStatus } from './verification-presentation';
import { buildVerificationObservationSubmission } from './verification-observation';

const HEX_A = `0x${'a'.repeat(64)}`;
const HEX_B = `0x${'b'.repeat(64)}`;
const HEX_C = `0x${'c'.repeat(64)}`;
const HEX_D = `0x${'d'.repeat(64)}`;
const HEX_E = `0x${'e'.repeat(64)}`;
const HEX_F = `0x${'f'.repeat(64)}`;
const ELECTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const RANDOM = `0x${'1'.repeat(64)}`;

function availableResource(): AvailableVerificationResource {
  const commitment = computeCommitment(ELECTION_ID, 0, RANDOM);
  return {
    availability: 'available',
    finalizationId: 'finalization-1',
    proofAuthority: {
      electionId: ELECTION_ID,
      electionConfigHash: HEX_A,
      logId: 'log-1',
      bulletinRoot: HEX_B,
      imageId: HEX_C,
      verifiedTally: [1, 0, 0, 0, 0],
      missingSlots: 0,
      invalidPresentedSlots: 0,
      rejectedRecords: 0,
      totalExpected: 1,
      treeSize: 1,
      excludedSlots: 0,
      sthDigest: HEX_D,
      seenBitmapRoot: HEX_E,
      includedBitmapRoot: HEX_E,
      inputCommitment: HEX_F,
      seenIndicesCount: 1,
    },
    presentation: {
      tally: {
        counts: { A: 1, B: 0, C: 0, D: 0, E: 0 },
        totalVotes: 1,
        tamperedCount: 0,
      },
      scenarioId: 'S0',
      tamperDetected: false,
      policy: {
        summary: { status: 'fully_verified', tone: 'verified' },
        stageStatuses: {
          cast_as_intended: 'success',
          recorded_as_cast: 'success',
          counted_as_recorded: 'success',
          stark_verification: 'success',
        },
        evidenceFullyVerified: true,
        fullyVerifiedLabelEligible: true,
        display: {
          readiness: 'ready',
          source: 'summary',
          status: 'verified',
          renderedStatus: 'verified',
        },
        publishedTallyMismatch: false,
        devModeEvidence: false,
        missingEvidence: false,
      },
    },
    verifierResult: {
      status: 'success',
      report: {
        status: 'success',
        verifier_version: 'test-verifier',
        verified_at: '2026-08-12T00:00:00.000Z',
        duration_ms: 1,
        expected_image_id: HEX_C,
        receipt_image_id: HEX_C,
        dev_mode_receipt: false,
      },
    },
    verification: {
      checks: VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
        id: definition.id,
        status: 'success',
        evidence: definition.evidence,
        inputs: [...definition.inputs],
        ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
      })),
      steps: [],
    },
    voterEvidence: {
      availability: 'available',
      voteReceipt: {
        voteId: 'vote-1',
        commitment,
        bulletinIndex: 0,
        bulletinRootAtCast: HEX_B,
        castAtMs: 1730000000000,
        inputCommitment: HEX_F,
      },
      userVote: {
        commitment,
        voteId: 'vote-1',
        proof: {
          leafIndex: 0,
          treeSize: 1,
          merklePath: [],
          bulletinRootAtCast: HEX_B,
        },
      },
    },
    journal: { representation: 'omitted' },
  };
}

function session(overrides: { myVote?: SessionData['myVote'] } = {}): SessionData {
  const myVote = overrides.myVote ?? 'A';
  return {
    sessionId: 'session-1',
    capabilityToken: 'capability',
    lastActivity: 1,
    expiresAt: 60_001,
    phase: 'voting',
    electionId: ELECTION_ID,
    electionConfigHash: HEX_A,
    logId: HEX_B,
    myVote,
    myCommit: computeCommitment(ELECTION_ID, 0, RANDOM),
    myRand: RANDOM,
  };
}

describe('verification resource projection', () => {
  it('projects the grouped resource and replaces server cast results with browser-local evidence', () => {
    const resource = availableResource();
    const projected = projectVerificationResource(resource, session({ myVote: 'B' }));

    expect(projected.availability).toBe('available');
    if (projected.availability !== 'available') {
      throw new Error('Expected available projection');
    }
    expect(projected.data.verificationChecks?.find((check) => check.id === 'cast_commitment_match')?.status).toBe(
      'failed',
    );
    expect(projected.data.verificationSteps?.find((step) => step.id === 'cast_as_intended')?.status).toBe('failed');
    expect(projected.data.presentationPolicy?.fullyVerifiedLabelEligible).toBe(false);
    expect(projected.data.voteReceipt?.timestamp).toBe(1730000000000);
  });

  it('fails closed when the server check inventory is incomplete', () => {
    const resource = availableResource();
    resource.verification.checks = resource.verification.checks.slice(1);

    expect(projectVerificationResource(resource, session())).toEqual({
      availability: 'corrupt',
      data: null,
      message: 'Verification checks are incomplete or duplicated',
    });
  });

  it('does not project unavailable resources into UI data', () => {
    expect(
      projectVerificationResource(
        {
          availability: 'unavailable',
          finalizationId: 'finalization-1',
          reason: 'finalization_not_current',
          message: 'Unsupported artifact',
        },
        session(),
      ),
    ).toEqual({
      availability: 'unavailable',
      data: null,
      message: 'Unsupported artifact',
    });
  });
});

describe('fail-closed web admission and presentation', () => {
  it('cannot render Verified for an unknown response discriminator', () => {
    const admitted = admitVerificationResourceSnapshot(
      {
        availability: 'future-success',
        finalizationId: 'finalization-1',
        fullyVerifiedLabelEligible: true,
      },
      'finalization-1',
    );
    expect(admitted.availability).toBe('corrupt');

    const policy = deriveVerificationPresentationPolicy({
      availability: admitted.availability,
      verificationStarted: true,
      sequenceComplete: true,
    });
    expect(policy.fullyVerifiedLabelEligible).toBe(false);
    expect(resolveEligibleRenderedVerificationStatus(policy)).not.toBe('verified');
  });

  it('fails closed on a snapshot from another finalization', () => {
    const admitted = admitVerificationResourceSnapshot(availableResource(), 'finalization-2');

    expect(admitted).toMatchObject({
      availability: 'corrupt',
      finalizationId: 'finalization-2',
      reason: 'invalid_artifact',
    });
  });
});

describe('verification observation construction', () => {
  it('keeps finalization path authority separate from the exact four-key body', () => {
    const projected = projectVerificationResource(availableResource(), session());
    if (projected.availability !== 'available') {
      throw new Error('Expected available projection');
    }

    const submission = buildVerificationObservationSubmission(projected.data);

    expect(submission).toEqual({
      finalizationId: 'finalization-1',
      request: {
        castChecks: {
          cast_receipt_present: 'success',
          cast_choice_range: 'success',
          cast_random_format: 'success',
          cast_commitment_match: 'success',
        },
      },
    });
    expect(JSON.stringify(submission?.request)).not.toContain('finalization-1');
    expect(JSON.stringify(submission)).not.toContain(RANDOM);
  });
});

describe('artifact selectors', () => {
  it('returns one canonical authenticated candidate per artifact', () => {
    const data = { finalizationId: 'finalization-1' };

    expect(resolveBundleCandidate(data, 'session-1')).toEqual({
      kind: 'bundle',
      url: buildAuthenticatedBundleDownloadUrl('session-1', 'finalization-1'),
      source: 'authenticated-endpoint',
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
    });
    expect(resolveReportCandidate(data, 'session-1')).toEqual({
      kind: 'report',
      url: buildAuthenticatedReportDownloadUrl('session-1', 'finalization-1'),
      source: 'authenticated-endpoint',
      sessionId: 'session-1',
      finalizationId: 'finalization-1',
    });
  });

  it('rejects missing or unsafe selector authority', () => {
    expect(resolveBundleCandidate({}, 'session-1')).toBeNull();
    expect(resolveReportCandidate({ finalizationId: '../finalization-1' }, 'session-1')).toBeNull();
  });
});

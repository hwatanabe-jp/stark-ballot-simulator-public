import { normalizeHexString } from '@stark-ballot/zkvm-contract/zkvm/hex';
import { hasCoherentPublicTamperScenarioProjection } from '@stark-ballot/verification/scenario-projection';
import {
  VERIFICATION_CHECK_IDS,
  VERIFICATION_CHECK_NOTE_KEY_VALUES,
  VERIFICATION_EVIDENCE_VALUES,
} from '@stark-ballot/verification/checks';
import {
  publicVerificationErrorSchema,
  publicVerificationReportSchema,
  publicVerificationResultSchema,
} from '@stark-ballot/verification/public-result';
import {
  closeStatementArtifactSchema,
  electionManifestArtifactSchema,
} from '@stark-ballot/verification/public-audit-artifacts';
import {
  VERIFICATION_DISPLAY_READINESS_VALUES,
  VERIFICATION_DISPLAY_SOURCE_VALUES,
  VERIFICATION_DISPLAY_STATUS_VALUES,
  VERIFICATION_SUMMARY_STATUS_VALUES,
  VERIFICATION_SUMMARY_TONE_VALUES,
  hasCanonicalVerificationCheckEvidence,
  hasCoherentAvailableVoterEvidence,
  hasCoherentFullyVerifiedPresentationEvidence,
  hasCoherentPublicFactDerivedCheckStatuses,
  hasCoherentPublicPresentationPolicy,
  hasCoherentPublicVerifierChecks,
  hasCoherentVerificationReportExpectedImageId,
} from '@stark-ballot/verification/presentation-policy';
import { hasCanonicalVerificationSteps } from '@stark-ballot/verification/steps';
import { VERIFICATION_STATUS_VALUES } from '@stark-ballot/verification/shared/types';
import {
  hasCoherentCurrentZkVMJournalSemantics,
  hasCoherentZkVMVoteSlotPartition,
} from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import {
  CURRENT_METHOD_VERSION,
  type CurrentZkVMJournal as CanonicalCurrentZkVMJournal,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import { s, type Infer, type AnySchema } from '@stark-ballot/validation/schema';
import { documentOpenApiRefinement } from '@stark-ballot/validation/schema-openapi';
import {
  apiResponseSchema,
  durationMsSchema,
  finalizationIdSchema,
  hex32Schema,
  journalTallySchema,
  positiveUint32Schema,
  publicObject,
  scenarioIdSchema,
  sessionIdSchema,
  tallySchema,
  tallyWithRequiredTamperedCountSchema,
  uint32Schema,
  voteChoiceSchema,
} from './primitives';
import { inclusionProofSchema, voteReceiptSchema } from './votes';

type FieldComparison = (journalValue: unknown, publicValue: unknown) => boolean;

const sameValue: FieldComparison = (journalValue, publicValue) => journalValue === publicValue;
const sameHex: FieldComparison = (journalValue, publicValue) =>
  typeof journalValue === 'string' &&
  typeof publicValue === 'string' &&
  normalizeHexString(journalValue) === normalizeHexString(publicValue);
const sameTallyEntries: FieldComparison = (journalValue, publicValue) =>
  Array.isArray(journalValue) &&
  Array.isArray(publicValue) &&
  journalValue.every((value, index) => value === publicValue[index]);
const optionalImageIdMatches: FieldComparison = (journalValue, publicValue) =>
  journalValue === undefined || sameHex(journalValue, publicValue);

const JOURNAL_FIELD_COMPARISONS = {
  electionId: sameValue,
  electionConfigHash: sameHex,
  bulletinRoot: sameHex,
  verifiedTally: sameTallyEntries,
  missingSlots: sameValue,
  invalidPresentedSlots: sameValue,
  rejectedRecords: sameValue,
  totalExpected: sameValue,
  treeSize: sameValue,
  sthDigest: sameHex,
  seenBitmapRoot: sameHex,
  includedBitmapRoot: sameHex,
  excludedSlots: sameValue,
  inputCommitment: sameHex,
  seenIndicesCount: sameValue,
  imageId: optionalImageIdMatches,
};

/** Callers own exhaustive field inventories; comparisons retain each field's wire semantics. */
export function journalFieldMatches(
  field: keyof typeof JOURNAL_FIELD_COMPARISONS,
  journalValue: unknown,
  publicValue: unknown,
): boolean {
  return JOURNAL_FIELD_COMPARISONS[field](journalValue, publicValue);
}

export const PUBLIC_VERIFICATION_EVIDENCE_VALUES = VERIFICATION_EVIDENCE_VALUES;
export const PUBLIC_VERIFICATION_CHECK_IDS = VERIFICATION_CHECK_IDS;
export const PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES = VERIFICATION_CHECK_NOTE_KEY_VALUES;

export const VERIFICATION_OBSERVATION_CAST_CHECK_IDS = [
  'cast_receipt_present',
  'cast_choice_range',
  'cast_random_format',
  'cast_commitment_match',
] as const satisfies readonly (typeof VERIFICATION_CHECK_IDS)[number][];

export const VERIFICATION_OBSERVATION_CAST_STATUS_VALUES = ['success', 'failed', 'not_run'] as const;

const VERIFICATION_STEP_IDS = [
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
] as const;
const VERIFICATION_STEP_STATUS_VALUES = ['success', 'failed', 'running', 'not_run', 'pending'] as const;

export const verificationStatusSchema = s.enum(VERIFICATION_STATUS_VALUES);
export const verificationEvidenceSchema = s.enum(VERIFICATION_EVIDENCE_VALUES);
export const verificationCheckIdSchema = s.enum(VERIFICATION_CHECK_IDS);
export const verificationCheckNoteKeySchema = s.enum(VERIFICATION_CHECK_NOTE_KEY_VALUES);

export { publicVerificationErrorSchema, publicVerificationReportSchema, publicVerificationResultSchema };

const currentElectionIdSchema = s.string().uuid();

const currentZkvmJournalShape = {
  electionId: currentElectionIdSchema,
  electionConfigHash: hex32Schema,
  bulletinRoot: hex32Schema,
  treeSize: positiveUint32Schema,
  totalExpected: uint32Schema,
  sthDigest: hex32Schema,
  verifiedTally: journalTallySchema,
  totalVotes: uint32Schema,
  validVotes: uint32Schema,
  invalidVotes: uint32Schema,
  seenIndicesCount: uint32Schema,
  missingSlots: uint32Schema,
  invalidPresentedSlots: uint32Schema,
  rejectedRecords: uint32Schema,
  seenBitmapRoot: hex32Schema,
  includedBitmapRoot: hex32Schema,
  excludedSlots: uint32Schema,
  inputCommitment: hex32Schema,
  methodVersion: s.literal(CURRENT_METHOD_VERSION),
  imageId: hex32Schema.optional(),
} satisfies { [TKey in keyof CanonicalCurrentZkVMJournal]: AnySchema };

export const currentZkvmJournalSchema = publicObject(currentZkvmJournalShape).superRefine((journal, context) => {
  if (!hasCoherentCurrentZkVMJournalSemantics(journal)) {
    context.addIssue({ message: 'Current journal count fields are incoherent' });
  }
});
documentOpenApiRefinement(
  currentZkvmJournalSchema,
  'Journal count, slot-partition, bitmap, and tree-size fields satisfy the current zkVM journal invariants.',
);

export const electionManifestSchema = electionManifestArtifactSchema;

export const closeStatementSchema = closeStatementArtifactSchema;

const receiptMetadataSchema = publicObject({
  isFake: s.boolean().optional(),
});

export const receiptSchema = publicObject({
  imageId: hex32Schema,
  seal: s.string(),
  journal: s.string().optional(),
  metadata: receiptMetadataSchema.optional(),
});

export const verificationStepSchema = publicObject({
  id: s.enum(VERIFICATION_STEP_IDS),
  status: s.enum(VERIFICATION_STEP_STATUS_VALUES),
  inputs: s.array(s.string()),
  error: s.string().min(1).optional(),
});

const verificationCheckBaseShape = {
  id: verificationCheckIdSchema,
  evidence: verificationEvidenceSchema,
  inputs: s.array(s.string()),
  derivedFrom: verificationCheckIdSchema.optional(),
} as const;

export const verificationCheckSchema = s.union([
  publicObject({
    ...verificationCheckBaseShape,
    status: s.enum(VERIFICATION_STEP_STATUS_VALUES),
  }),
  publicObject({
    ...verificationCheckBaseShape,
    status: s.enum(['failed', 'not_run'] as const),
    noteKey: verificationCheckNoteKeySchema,
  }),
]);

export const botVotesSummarySchema = publicObject({
  total: s.number().int().nonnegative().optional(),
  affectedBotIds: s.array(s.number().int().nonnegative()).optional(),
  source: s.string().min(1),
});

export const tamperSummarySchema = publicObject({
  ignoredVotes: s.number().int().nonnegative(),
  recountedVotes: s.number().int().nonnegative(),
  userRecountedTo: voteChoiceSchema.nullable(),
  affectedBotIds: s.array(s.number().int().nonnegative()).optional(),
});

export const publicProofSummaryBaseShape = {
  tally: tallySchema,
  imageId: hex32Schema,
  bulletinRoot: hex32Schema,
  verifiedTally: journalTallySchema,
  missingSlots: uint32Schema,
  invalidPresentedSlots: uint32Schema,
  rejectedRecords: uint32Schema,
  totalExpected: uint32Schema,
  treeSize: positiveUint32Schema,
  excludedSlots: uint32Schema,
  sthDigest: hex32Schema,
  seenBitmapRoot: hex32Schema.optional(),
  includedBitmapRoot: hex32Schema,
  inputCommitment: hex32Schema,
  seenIndicesCount: uint32Schema,
  tamperSummary: tamperSummarySchema.optional(),
};

export const publicProofSummarySchema = publicObject({
  ...publicProofSummaryBaseShape,
  tamperDetected: s.boolean().optional(),
});

export const VerificationResourceParamsSchema = publicObject({
  sessionId: sessionIdSchema,
  finalizationId: finalizationIdSchema,
});

export const VerificationResourceQuerySchema = publicObject({
  include: s.literal('journal').optional(),
});

export const VerificationRunRequestSchema = publicObject({});

const verificationObservationCastStatusSchema = s.enum(VERIFICATION_OBSERVATION_CAST_STATUS_VALUES);

export const VerificationObservationRequestSchema = publicObject({
  castChecks: publicObject({
    cast_receipt_present: verificationObservationCastStatusSchema,
    cast_choice_range: verificationObservationCastStatusSchema,
    cast_random_format: verificationObservationCastStatusSchema,
    cast_commitment_match: verificationObservationCastStatusSchema,
  }),
});

export const verificationProofAuthoritySchema = publicObject({
  electionId: currentElectionIdSchema,
  electionConfigHash: hex32Schema,
  logId: hex32Schema,
  bulletinRoot: publicProofSummaryBaseShape.bulletinRoot,
  imageId: publicProofSummaryBaseShape.imageId,
  verifiedTally: publicProofSummaryBaseShape.verifiedTally,
  missingSlots: publicProofSummaryBaseShape.missingSlots,
  invalidPresentedSlots: publicProofSummaryBaseShape.invalidPresentedSlots,
  rejectedRecords: publicProofSummaryBaseShape.rejectedRecords,
  totalExpected: publicProofSummaryBaseShape.totalExpected,
  treeSize: publicProofSummaryBaseShape.treeSize,
  excludedSlots: publicProofSummaryBaseShape.excludedSlots,
  sthDigest: publicProofSummaryBaseShape.sthDigest,
  seenBitmapRoot: hex32Schema,
  includedBitmapRoot: publicProofSummaryBaseShape.includedBitmapRoot,
  inputCommitment: publicProofSummaryBaseShape.inputCommitment,
  seenIndicesCount: publicProofSummaryBaseShape.seenIndicesCount,
}).superRefine((proof, context) => {
  if (!hasCoherentZkVMVoteSlotPartition(proof)) {
    context.addIssue({ message: 'Verification proof authority partition is incoherent' });
  }
});
documentOpenApiRefinement(
  verificationProofAuthoritySchema,
  'Proof-authority counts form a coherent zkVM vote-slot partition.',
);

type CurrentJournalProofAuthoritySharedField = keyof Infer<typeof currentZkvmJournalSchema> &
  keyof Infer<typeof verificationProofAuthoritySchema>;

export const VERIFICATION_JOURNAL_PROOF_AUTHORITY_SHARED_FIELDS = [
  'electionId',
  'electionConfigHash',
  'bulletinRoot',
  'verifiedTally',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'totalExpected',
  'treeSize',
  'sthDigest',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'excludedSlots',
  'inputCommitment',
  'seenIndicesCount',
  'imageId',
] as const satisfies readonly CurrentJournalProofAuthoritySharedField[];

type AssertNever<TValue extends never> = TValue;
type VerificationJournalProofAuthoritySharedFieldCoverage = AssertNever<
  Exclude<CurrentJournalProofAuthoritySharedField, (typeof VERIFICATION_JOURNAL_PROOF_AUTHORITY_SHARED_FIELDS)[number]>
>;

function hasCoherentIncludedJournalProofAuthority(
  journal: Infer<typeof currentZkvmJournalSchema>,
  proofAuthority: Infer<typeof verificationProofAuthoritySchema>,
  ..._coverage: [VerificationJournalProofAuthoritySharedFieldCoverage] extends [never] ? [] : [never]
): boolean {
  void _coverage;
  return VERIFICATION_JOURNAL_PROOF_AUTHORITY_SHARED_FIELDS.every((field) =>
    journalFieldMatches(field, journal[field], proofAuthority[field]),
  );
}

const verificationSummarySchema = publicObject({
  status: s.enum(VERIFICATION_SUMMARY_STATUS_VALUES),
  tone: s.enum(VERIFICATION_SUMMARY_TONE_VALUES),
  messageKey: s.string().min(1).optional(),
}).nullable();

const verificationStageStatusesSchema = publicObject({
  cast_as_intended: s.enum(VERIFICATION_STEP_STATUS_VALUES),
  recorded_as_cast: s.enum(VERIFICATION_STEP_STATUS_VALUES),
  counted_as_recorded: s.enum(VERIFICATION_STEP_STATUS_VALUES),
  stark_verification: s.enum(VERIFICATION_STEP_STATUS_VALUES),
});

const EXPECTED_DISPLAY_STATUS_BY_SOURCE = new Map<string | null, string>([
  ['hard_failure', 'failed'],
  ['pending', 'warning'],
  ['unavailable', 'warning'],
  ['corrupt', 'failed'],
]);

const verificationDisplaySchema = publicObject({
  readiness: s.enum(VERIFICATION_DISPLAY_READINESS_VALUES),
  source: s.enum(VERIFICATION_DISPLAY_SOURCE_VALUES).nullable(),
  status: s.enum(VERIFICATION_DISPLAY_STATUS_VALUES).nullable(),
  renderedStatus: s.enum(VERIFICATION_DISPLAY_STATUS_VALUES).nullable(),
}).superRefine((display, context) => {
  if (display.readiness === 'ready') {
    if (display.renderedStatus !== display.status) {
      context.addIssue({ message: 'Ready verification display must render its resolved status' });
    }
  } else if (display.renderedStatus !== null) {
    context.addIssue({ message: 'Non-ready verification display cannot render a terminal status' });
  }

  if ((display.source === null) !== (display.status === null)) {
    context.addIssue({ message: 'Verification display source and status must be present together' });
  }
  if (display.source === 'explicit_server_failure' && display.status === 'verified') {
    context.addIssue({ message: 'Explicit server failure cannot resolve to verified' });
  }
  const expectedStatus = EXPECTED_DISPLAY_STATUS_BY_SOURCE.get(display.source);
  if (expectedStatus !== undefined && display.status !== expectedStatus) {
    context.addIssue({ message: 'Verification display status contradicts its source' });
  }
});
documentOpenApiRefinement(
  verificationDisplaySchema,
  'Readiness, source, status, and renderedStatus are mutually coherent; non-ready displays are never terminal.',
);

const ineligibleVerificationPresentationPolicySchema = publicObject({
  summary: verificationSummarySchema,
  stageStatuses: verificationStageStatusesSchema,
  evidenceFullyVerified: s.boolean(),
  fullyVerifiedLabelEligible: s.literal(false),
  display: verificationDisplaySchema,
  publishedTallyMismatch: s.boolean(),
  devModeEvidence: s.boolean(),
  missingEvidence: s.boolean(),
  explanationKey: s.string().min(1).optional(),
}).superRefine((policy, context) => {
  if (
    policy.display.readiness === 'ready' &&
    policy.display.source === 'summary' &&
    policy.display.status === 'verified' &&
    policy.display.renderedStatus === 'verified'
  ) {
    context.addIssue({ message: 'Ineligible verification policy must contain a negative eligibility fact' });
  }
});
documentOpenApiRefinement(
  ineligibleVerificationPresentationPolicySchema,
  'An ineligible policy cannot resolve to the fully verified display state.',
);

const fullyVerifiedPresentationPolicySchema = publicObject({
  summary: publicObject({
    status: s.literal('fully_verified'),
    tone: s.literal('verified'),
  }),
  stageStatuses: publicObject({
    cast_as_intended: s.literal('success'),
    recorded_as_cast: s.literal('success'),
    counted_as_recorded: s.literal('success'),
    stark_verification: s.literal('success'),
  }),
  evidenceFullyVerified: s.literal(true),
  fullyVerifiedLabelEligible: s.literal(true),
  display: publicObject({
    readiness: s.literal('ready'),
    source: s.literal('summary'),
    status: s.literal('verified'),
    renderedStatus: s.literal('verified'),
  }),
  publishedTallyMismatch: s.literal(false),
  devModeEvidence: s.literal(false),
  missingEvidence: s.literal(false),
});

const verificationPresentationPolicySchema = s.union([
  fullyVerifiedPresentationPolicySchema,
  ineligibleVerificationPresentationPolicySchema,
]);

export const verificationPresentationSchema = publicObject({
  tally: tallyWithRequiredTamperedCountSchema,
  scenarioId: scenarioIdSchema,
  tamperDetected: s.boolean(),
  botVotesSummary: botVotesSummarySchema.optional(),
  tamperSummary: publicProofSummaryBaseShape.tamperSummary,
  policy: verificationPresentationPolicySchema,
});

const verificationAvailableVoterEvidenceSchema = publicObject({
  availability: s.literal('available'),
  voteReceipt: voteReceiptSchema.extend({
    voteId: s.string().min(1),
    inputCommitment: hex32Schema,
  }),
  userVote: publicObject({
    commitment: hex32Schema,
    voteId: s.string().min(1),
    proof: inclusionProofSchema,
  }),
});

const verificationUnavailableVoterEvidenceBaseShape = {
  availability: s.literal('unavailable'),
  userVote: publicObject({
    commitment: hex32Schema,
  }),
} as const;

const verificationVoteIdUnavailableVoterEvidenceSchema = publicObject({
  ...verificationUnavailableVoterEvidenceBaseShape,
  reason: s.literal('vote_id_unavailable'),
});

const verificationExactProofUnavailableVoterEvidenceSchema = publicObject({
  ...verificationUnavailableVoterEvidenceBaseShape,
  reason: s.literal('exact_proof_unavailable'),
  userVote: publicObject({
    commitment: hex32Schema,
    voteId: s.string().min(1),
  }),
});

const verificationUnavailableVoterEvidenceSchema = s.union([
  verificationVoteIdUnavailableVoterEvidenceSchema,
  verificationExactProofUnavailableVoterEvidenceSchema,
]);

export const verificationVoterEvidenceSchema = s.union([
  verificationAvailableVoterEvidenceSchema,
  verificationUnavailableVoterEvidenceSchema,
]);

export const verificationChecksAndStepsSchema = publicObject({
  checks: s.array(verificationCheckSchema),
  steps: s.array(verificationStepSchema),
});

export const verificationJournalRepresentationSchema = s.union([
  publicObject({
    representation: s.literal('included'),
    value: currentZkvmJournalSchema,
  }),
  publicObject({
    representation: s.literal('omitted'),
  }),
]);

const availableVerificationResourceObject = publicObject({
  availability: s.literal('available'),
  finalizationId: finalizationIdSchema,
  proofAuthority: verificationProofAuthoritySchema,
  presentation: verificationPresentationSchema,
  verifierResult: publicVerificationResultSchema,
  verification: verificationChecksAndStepsSchema,
  voterEvidence: verificationVoterEvidenceSchema,
  journal: verificationJournalRepresentationSchema,
});

type AvailableResource = Infer<typeof availableVerificationResourceObject>;
type ResourceReport = AvailableResource['verifierResult']['report'];
type VerificationIssueCollector = { addIssue(issue: { message: string }): void };

function checkResourceVerificationEvidence(
  resource: AvailableResource,
  verificationReport: ResourceReport,
  context: VerificationIssueCollector,
): void {
  const devModeEvidence =
    resource.verifierResult.status === 'dev_mode' || verificationReport?.dev_mode_receipt === true;
  if (!hasCanonicalVerificationCheckEvidence(resource.verification.checks, devModeEvidence)) {
    context.addIssue({ message: 'Verification check inventory contradicts the canonical registry' });
  }
  if (
    !hasCoherentPublicFactDerivedCheckStatuses({
      checks: resource.verification.checks,
      verificationStatus: resource.verifierResult.status,
      voterEvidence: resource.voterEvidence,
      proof: resource.proofAuthority,
      presentation: {
        counts: resource.presentation.tally.counts,
        totalVotes: resource.presentation.tally.totalVotes,
      },
    })
  ) {
    context.addIssue({ message: 'Verification checks contradict their complete public evidence' });
  }
  if (
    !hasCoherentPublicVerifierChecks({
      checks: resource.verification.checks,
      verifierResult: resource.verifierResult,
    })
  ) {
    context.addIssue({ message: 'Verifier status contradicts its public STARK checks' });
  }
  if (
    !hasCoherentPublicPresentationPolicy({
      checks: resource.verification.checks,
      policy: resource.presentation.policy,
      proof: resource.proofAuthority,
      verificationStatus: resource.verifierResult.status,
      verificationReportStatus: verificationReport?.status,
      devModeEvidence,
    })
  ) {
    context.addIssue({ message: 'Presentation policy contradicts its admitted verification evidence' });
  }
}

function checkFullyVerifiedResource(
  resource: AvailableResource,
  verificationReport: ResourceReport,
  context: VerificationIssueCollector,
): void {
  if (resource.presentation.policy.fullyVerifiedLabelEligible === true) {
    if (
      !hasCoherentFullyVerifiedPresentationEvidence({
        checks: resource.verification.checks,
        stageStatuses: resource.presentation.policy.stageStatuses,
        scenarioId: resource.presentation.scenarioId,
        verificationStatus: resource.verifierResult.status,
        verificationReport,
        proof: {
          imageId: resource.proofAuthority.imageId,
          bulletinRoot: resource.proofAuthority.bulletinRoot,
          inputCommitment: resource.proofAuthority.inputCommitment,
          seenBitmapRoot: resource.proofAuthority.seenBitmapRoot,
          includedBitmapRoot: resource.proofAuthority.includedBitmapRoot,
          verifiedTally: resource.proofAuthority.verifiedTally,
          missingSlots: resource.proofAuthority.missingSlots,
          invalidPresentedSlots: resource.proofAuthority.invalidPresentedSlots,
          rejectedRecords: resource.proofAuthority.rejectedRecords,
          excludedSlots: resource.proofAuthority.excludedSlots,
          totalExpected: resource.proofAuthority.totalExpected,
          treeSize: resource.proofAuthority.treeSize,
          seenIndicesCount: resource.proofAuthority.seenIndicesCount,
        },
        presentation: {
          counts: resource.presentation.tally.counts,
          totalVotes: resource.presentation.tally.totalVotes,
          tamperedCount: resource.presentation.tally.tamperedCount,
          tamperDetected: resource.presentation.tamperDetected,
          tamperSummary: resource.presentation.tamperSummary,
        },
        voterEvidence: resource.voterEvidence,
      })
    ) {
      context.addIssue({ message: 'Fully verified presentation contradicts admitted verification evidence' });
    }
  }
}

function checkResourceRepresentation(resource: AvailableResource, context: VerificationIssueCollector): void {
  for (const step of resource.verification.steps) {
    if (resource.presentation.policy.stageStatuses[step.id] !== step.status) {
      context.addIssue({ message: 'Verification step status contradicts presentation stage status' });
    }
  }
  if (
    resource.journal.representation === 'included' &&
    !hasCoherentIncludedJournalProofAuthority(resource.journal.value, resource.proofAuthority)
  ) {
    context.addIssue({ message: 'Included journal contradicts proof authority' });
  }
}

export const availableVerificationResourceSchema = availableVerificationResourceObject.superRefine(
  (resource, context) => {
    const verificationReport = resource.verifierResult.report;
    checkResourceVerificationEvidence(resource, verificationReport, context);
    if (!hasCanonicalVerificationSteps(resource.verification.steps)) {
      context.addIssue({ message: 'Verification step inventory contradicts the canonical projection' });
    }
    if (!hasCoherentVerificationReportExpectedImageId(verificationReport, resource.proofAuthority.imageId)) {
      context.addIssue({ message: 'Verifier report expected ImageID contradicts proof authority' });
    }
    if (
      resource.voterEvidence.availability === 'available' &&
      !hasCoherentAvailableVoterEvidence({
        voterEvidence: resource.voterEvidence,
        proofAuthority: resource.proofAuthority,
      })
    ) {
      context.addIssue({ message: 'Available voter evidence contains contradictory identity or range facts' });
    }
    if (
      !hasCoherentPublicTamperScenarioProjection({
        scenarioId: resource.presentation.scenarioId,
        tamperDetected: resource.presentation.tamperDetected,
        tamperedCount: resource.presentation.tally.tamperedCount,
        proof: resource.proofAuthority,
        counts: resource.presentation.tally.counts,
        tamperSummary: resource.presentation.tamperSummary,
        botVotesSummary: resource.presentation.botVotesSummary,
      })
    ) {
      context.addIssue({ message: 'Presentation tamper facts contradict its scenario or detection result' });
    }
    checkFullyVerifiedResource(resource, verificationReport, context);
    checkResourceRepresentation(resource, context);
  },
);
documentOpenApiRefinement(
  availableVerificationResourceSchema,
  'The complete public resource has coherent canonical checks, proof authority, voter evidence, journal, tamper facts, verifier result, and fail-closed presentation policy.',
);

const unavailableVerificationResourceSchema = publicObject({
  availability: s.literal('unavailable'),
  finalizationId: finalizationIdSchema,
  reason: s.enum(['finalization_not_current', 'user_vote_unavailable']),
  message: s.string().min(1),
});

const corruptVerificationResourceSchema = publicObject({
  availability: s.literal('corrupt'),
  finalizationId: finalizationIdSchema,
  reason: s.enum([
    'invalid_artifact',
    'incomplete_session_authority',
    'session_identity_mismatch',
    'voter_evidence_mismatch',
  ]),
  message: s.string().min(1),
});

export const verificationResourceSchema = s.union([
  availableVerificationResourceSchema,
  unavailableVerificationResourceSchema,
  corruptVerificationResourceSchema,
]);

export const VerificationResourceResponseSchema = apiResponseSchema(verificationResourceSchema);

export const VerificationRunResponseSchema = apiResponseSchema(
  publicObject({
    verificationStatus: verificationStatusSchema,
    finalizationId: finalizationIdSchema,
    estimatedDurationMs: durationMsSchema,
    idempotent: s.boolean(),
  }),
);

export const VerificationObservationResponseSchema = apiResponseSchema(
  publicObject({
    status: s.enum(['recorded', 'idempotent']),
  }),
);

export type PublicVerificationEvidence = Infer<typeof verificationEvidenceSchema>;
export type PublicVerificationCheckId = Infer<typeof verificationCheckIdSchema>;
export type PublicVerificationCheckNoteKey = Infer<typeof verificationCheckNoteKeySchema>;
export type VerificationObservationCastCheckId = (typeof VERIFICATION_OBSERVATION_CAST_CHECK_IDS)[number];
export type VerificationObservationCastStatus = Infer<typeof verificationObservationCastStatusSchema>;
export type VerificationStatus = Infer<typeof verificationStatusSchema>;
export type CurrentZkVMJournal = Infer<typeof currentZkvmJournalSchema>;
export type Receipt = Infer<typeof receiptSchema>;
export type VerificationStep = Infer<typeof verificationStepSchema>;
export type VerificationCheck = Infer<typeof verificationCheckSchema>;
export type BotVotesSummary = Infer<typeof botVotesSummarySchema>;
export type TamperSummary = Infer<typeof tamperSummarySchema>;
export type PublicProofSummary = Infer<typeof publicProofSummarySchema>;
export type VerificationResourceParams = Infer<typeof VerificationResourceParamsSchema>;
export type VerificationResourceQuery = Infer<typeof VerificationResourceQuerySchema>;
export type VerificationRunRequest = Infer<typeof VerificationRunRequestSchema>;
export type VerificationObservationRequest = Infer<typeof VerificationObservationRequestSchema>;
export type VerificationProofAuthority = Infer<typeof verificationProofAuthoritySchema>;
export type VerificationPresentation = Infer<typeof verificationPresentationSchema>;
export type VerificationVoterEvidence = Infer<typeof verificationVoterEvidenceSchema>;
export type VerificationChecksAndSteps = Infer<typeof verificationChecksAndStepsSchema>;
export type VerificationJournalRepresentation = Infer<typeof verificationJournalRepresentationSchema>;
export type AvailableVerificationResource = Infer<typeof availableVerificationResourceSchema>;
export type VerificationResource = Infer<typeof verificationResourceSchema>;
export type VerificationResourceResponse = Infer<typeof VerificationResourceResponseSchema>;
export type VerificationRunResponse = Infer<typeof VerificationRunResponseSchema>;
export type VerificationObservationResponse = Infer<typeof VerificationObservationResponseSchema>;

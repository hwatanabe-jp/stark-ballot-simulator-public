import {
  VERIFICATION_CHECK_IDS,
  VERIFICATION_CHECK_NOTE_KEY_VALUES,
  VERIFICATION_EVIDENCE_VALUES,
} from '@stark-ballot/verification/checks';
import { PUBLIC_VERIFICATION_ERROR_MESSAGES } from '@stark-ballot/verification/public-result';
import {
  VERIFICATION_DISPLAY_READINESS_VALUES,
  VERIFICATION_DISPLAY_SOURCE_VALUES,
  VERIFICATION_DISPLAY_STATUS_VALUES,
  VERIFICATION_SUMMARY_STATUS_VALUES,
  VERIFICATION_SUMMARY_TONE_VALUES,
} from '@stark-ballot/verification/presentation-policy';
import {
  CURRENT_METHOD_VERSION,
  type CurrentZkVMJournal as CanonicalCurrentZkVMJournal,
} from '@stark-ballot/zkvm-contract/zkvm/types';
import { s, type Infer, type SchemaTypeAny } from '@stark-ballot/validation/schema';
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
  timestampMsSchema,
  uint32Schema,
  voteChoiceSchema,
} from './primitives';
import { inclusionProofSchema, voteReceiptSchema } from './votes';

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

const VERIFICATION_STATUS_VALUES = ['success', 'failed', 'dev_mode', 'not_run', 'running'] as const;
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

const publicVerificationErrorSchema = s.enum(PUBLIC_VERIFICATION_ERROR_MESSAGES);

// These snake_case fields are the governed verifier-service report protocol.
// `receipt_image_id` is omitted when the report has no observation, null when
// the verifier explicitly reports no embedded ImageID, and a string when one
// was observed.
export const publicVerificationReportSchema = publicObject({
  status: verificationStatusSchema,
  verifier_version: s.string().optional(),
  verified_at: s.string().optional(),
  duration_ms: durationMsSchema.optional(),
  expected_image_id: s.string().optional(),
  receipt_image_id: s.string().nullable().optional(),
  dev_mode_receipt: s.boolean().optional(),
  errors: s.array(publicVerificationErrorSchema).optional(),
});

export const publicVerificationResultSchema = publicObject({
  status: verificationStatusSchema,
  report: publicVerificationReportSchema.optional(),
});

const currentZkvmJournalShape = {
  electionId: s.string().min(1),
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
} satisfies { [TKey in keyof CanonicalCurrentZkVMJournal]: SchemaTypeAny };

export const currentZkvmJournalSchema = publicObject(currentZkvmJournalShape);

export const electionManifestSchema = publicObject({
  electionId: s.string().min(1),
  totalExpected: s.number().int().nonnegative(),
  choices: s.array(s.string()),
  version: s.string().min(1),
  botCount: s.number().int().nonnegative(),
  merkleTreeDepth: s.number().int().nonnegative(),
  electionConfigHash: hex32Schema,
});

export const closeStatementSchema = publicObject({
  logId: hex32Schema,
  treeSize: s.number().int().nonnegative(),
  timestamp: timestampMsSchema,
  bulletinRoot: hex32Schema,
  sthDigest: hex32Schema,
});

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
  inputs: s.array(s.string()).optional(),
  error: s.string().optional(),
});

export const verificationCheckSchema = publicObject({
  id: verificationCheckIdSchema,
  status: s.enum(VERIFICATION_STEP_STATUS_VALUES),
  evidence: verificationEvidenceSchema,
  inputs: s.array(s.string()),
  noteKey: verificationCheckNoteKeySchema.optional(),
  derivedFrom: verificationCheckIdSchema.optional(),
});

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
  electionId: s.string().min(1),
  electionConfigHash: hex32Schema,
  logId: s.string().min(1),
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
  seenBitmapRoot: publicProofSummaryBaseShape.seenBitmapRoot,
  includedBitmapRoot: publicProofSummaryBaseShape.includedBitmapRoot,
  inputCommitment: publicProofSummaryBaseShape.inputCommitment,
  seenIndicesCount: publicProofSummaryBaseShape.seenIndicesCount,
});

export const verificationPresentationSchema = publicObject({
  tally: publicProofSummaryBaseShape.tally,
  scenarioId: scenarioIdSchema,
  tamperDetected: publicProofSummarySchema.shape.tamperDetected,
  botVotesSummary: botVotesSummarySchema.optional(),
  tamperSummary: publicProofSummaryBaseShape.tamperSummary,
  policy: publicObject({
    summary: publicObject({
      status: s.enum(VERIFICATION_SUMMARY_STATUS_VALUES),
      tone: s.enum(VERIFICATION_SUMMARY_TONE_VALUES),
      messageKey: s.string().min(1).optional(),
    }).nullable(),
    stageStatuses: publicObject({
      cast_as_intended: s.enum(VERIFICATION_STEP_STATUS_VALUES),
      recorded_as_cast: s.enum(VERIFICATION_STEP_STATUS_VALUES),
      counted_as_recorded: s.enum(VERIFICATION_STEP_STATUS_VALUES),
      stark_verification: s.enum(VERIFICATION_STEP_STATUS_VALUES),
    }),
    evidenceFullyVerified: s.boolean(),
    fullyVerifiedLabelEligible: s.boolean(),
    display: publicObject({
      readiness: s.enum(VERIFICATION_DISPLAY_READINESS_VALUES),
      source: s.enum(VERIFICATION_DISPLAY_SOURCE_VALUES).nullable(),
      status: s.enum(VERIFICATION_DISPLAY_STATUS_VALUES).nullable(),
      renderedStatus: s.enum(VERIFICATION_DISPLAY_STATUS_VALUES).nullable(),
    }),
    publishedTallyMismatch: s.boolean(),
    devModeEvidence: s.boolean(),
    missingEvidence: s.boolean(),
    explanationKey: s.string().min(1).optional(),
  }),
});

const verificationAvailableVoterEvidenceSchema = publicObject({
  availability: s.literal('available'),
  voteReceipt: voteReceiptSchema.extend({
    voteId: s.string().min(1),
  }),
  userVote: publicObject({
    commitment: hex32Schema,
    voteId: s.string().min(1),
    proof: inclusionProofSchema,
  }),
});

const verificationUnavailableVoterEvidenceSchema = publicObject({
  availability: s.literal('unavailable'),
  reason: s.enum(['vote_id_unavailable', 'exact_proof_unavailable']),
  userVote: publicObject({
    commitment: hex32Schema,
    voteId: s.string().min(1).optional(),
  }),
});

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

export const availableVerificationResourceSchema = publicObject({
  availability: s.literal('available'),
  finalizationId: finalizationIdSchema,
  proofAuthority: verificationProofAuthoritySchema,
  presentation: verificationPresentationSchema,
  verifierResult: publicVerificationResultSchema,
  verification: verificationChecksAndStepsSchema,
  voterEvidence: verificationVoterEvidenceSchema,
  journal: verificationJournalRepresentationSchema,
});

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
export type PublicVerificationErrorMessage = Infer<typeof publicVerificationErrorSchema>;
export type PublicVerificationReport = Infer<typeof publicVerificationReportSchema>;
export type PublicVerificationResult = Infer<typeof publicVerificationResultSchema>;
export type CurrentZkVMJournal = Infer<typeof currentZkvmJournalSchema>;
export type ElectionManifest = Infer<typeof electionManifestSchema>;
export type CloseStatement = Infer<typeof closeStatementSchema>;
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

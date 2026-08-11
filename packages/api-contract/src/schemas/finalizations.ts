import { s, type Infer } from '@stark-ballot/validation/schema';
import {
  apiResponseSchema,
  durationMsSchema,
  finalizationIdSchema,
  hex32Schema,
  publicObject,
  scenarioIdSchema,
  sessionIdSchema,
  timestampMsSchema,
  turnstileTokenFields,
} from './primitives';
import {
  closeStatementSchema,
  currentZkvmJournalSchema,
  electionManifestSchema,
  publicProofSummaryBaseShape,
  publicProofSummarySchema,
  publicVerificationReportSchema,
  receiptSchema,
  verificationStatusSchema,
} from './verification';
import { inclusionProofSchema, publicReceiptPublicationSchema, voteReceiptSchema } from './votes';

export const finalizationQueueSchema = publicObject({
  concurrencyLimit: s.number().int().nonnegative(),
  estimatedDurationMs: durationMsSchema,
});

export const finalizationProgressSchema = publicObject({
  phase: s.literal('running'),
  source: s.literal('derived'),
  percent: s.number().int().nonnegative().max(99),
  updatedAtMs: timestampMsSchema,
});

export const finalizationOrchestratorSchema = publicObject({
  status: s.string().nullable(),
  startTimeMs: timestampMsSchema.nullable(),
  stopTimeMs: timestampMsSchema.nullable(),
});

export const finalizationRuntimeDiagnosticsSchema = publicObject({
  asyncMode: s.enum(['enabled', 'disabled']),
  queue: finalizationQueueSchema.optional().nullable(),
  progress: finalizationProgressSchema.optional(),
  orchestrator: finalizationOrchestratorSchema.optional().nullable(),
});

export const finalizationAuthoritySchema = publicObject({
  imageId: publicProofSummaryBaseShape.imageId,
  journal: currentZkvmJournalSchema,
  receipt: receiptSchema.optional(),
  electionManifest: electionManifestSchema.optional(),
  closeStatement: closeStatementSchema.optional(),
});

export const finalizationPresentationSchema = publicObject({
  tally: publicProofSummaryBaseShape.tally,
  verifiedTally: publicProofSummaryBaseShape.verifiedTally,
  tamperDetected: publicProofSummarySchema.shape.tamperDetected,
  scenarios: s.array(s.string()).optional(),
  tamperSummary: publicProofSummaryBaseShape.tamperSummary,
  bulletinRoot: publicProofSummaryBaseShape.bulletinRoot,
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
  bitmapProofSource: s.enum(['mock', 'real']).optional(),
  verificationStatus: verificationStatusSchema,
  verificationReport: publicVerificationReportSchema.optional(),
});

const finalizationUserVoteSchema = publicObject({
  commitment: hex32Schema,
  voteId: s.string().min(1),
  proof: inclusionProofSchema,
});

export const finalizationVoterEvidenceSchema = s.union([
  publicObject({
    state: s.literal('available'),
    voteReceipt: voteReceiptSchema,
    userVote: finalizationUserVoteSchema,
    receiptPublication: publicReceiptPublicationSchema.optional(),
  }),
  publicObject({
    state: s.literal('verification-gated'),
    receiptPublication: publicReceiptPublicationSchema.optional(),
  }),
]);

const artifactAvailabilityValueSchema = s.enum(['available', 'unavailable']);

export const finalizationArtifactAvailabilitySchema = publicObject({
  bundle: artifactAvailabilityValueSchema,
  report: artifactAvailabilityValueSchema,
  includedBitmap: artifactAvailabilityValueSchema,
  seenBitmap: artifactAvailabilityValueSchema,
});

export const finalizationResultSchema = publicObject({
  authority: finalizationAuthoritySchema,
  presentation: finalizationPresentationSchema,
  voterEvidence: finalizationVoterEvidenceSchema,
  artifactAvailability: finalizationArtifactAvailabilitySchema,
});

const finalizationResourceBaseFields = {
  finalizationId: finalizationIdSchema,
  queuedAtMs: timestampMsSchema,
  runtimeDiagnostics: finalizationRuntimeDiagnosticsSchema,
};

const pendingFinalizationResourceSchema = publicObject({
  ...finalizationResourceBaseFields,
  status: s.literal('pending'),
});

const runningFinalizationResourceSchema = publicObject({
  ...finalizationResourceBaseFields,
  status: s.literal('running'),
  startedAtMs: timestampMsSchema,
});

const succeededFinalizationResourceSchema = publicObject({
  ...finalizationResourceBaseFields,
  status: s.literal('succeeded'),
  startedAtMs: timestampMsSchema,
  completedAtMs: timestampMsSchema,
  result: finalizationResultSchema,
});

const failedFinalizationResourceSchema = publicObject({
  ...finalizationResourceBaseFields,
  status: s.literal('failed'),
  startedAtMs: timestampMsSchema.optional(),
  failedAtMs: timestampMsSchema,
  error: publicObject({
    code: s.string().min(1),
    message: s.string().min(1),
  }),
});

const timeoutFinalizationResourceSchema = publicObject({
  ...finalizationResourceBaseFields,
  status: s.literal('timeout'),
  startedAtMs: timestampMsSchema.optional(),
  timeoutAtMs: timestampMsSchema,
});

export const FinalizationResourceSchema = s.union([
  pendingFinalizationResourceSchema,
  runningFinalizationResourceSchema,
  succeededFinalizationResourceSchema,
  failedFinalizationResourceSchema,
  timeoutFinalizationResourceSchema,
]);

export const FinalizationCreateParamsSchema = publicObject({
  sessionId: sessionIdSchema,
});

export const CurrentFinalizationParamsSchema = publicObject({
  sessionId: sessionIdSchema,
});

export const FinalizationCancelParamsSchema = publicObject({
  sessionId: sessionIdSchema,
  finalizationId: finalizationIdSchema,
});

export const FinalizationCreateRequestSchema = publicObject({
  scenarioId: scenarioIdSchema,
  ...turnstileTokenFields,
});

export const FinalizationCancelRequestSchema = publicObject({
  reason: s.string().max(256).optional(),
});

export const FinalizationResponseSchema = apiResponseSchema(FinalizationResourceSchema);
export const CurrentFinalizationResponseSchema = apiResponseSchema(FinalizationResourceSchema.nullable());

export type FinalizationQueue = Infer<typeof finalizationQueueSchema>;
export type FinalizationProgress = Infer<typeof finalizationProgressSchema>;
export type FinalizationOrchestrator = Infer<typeof finalizationOrchestratorSchema>;
export type FinalizationRuntimeDiagnostics = Infer<typeof finalizationRuntimeDiagnosticsSchema>;
export type FinalizationResult = Infer<typeof finalizationResultSchema>;
export type FinalizationResource = Infer<typeof FinalizationResourceSchema>;
export type FinalizationCreateParams = Infer<typeof FinalizationCreateParamsSchema>;
export type CurrentFinalizationParams = Infer<typeof CurrentFinalizationParamsSchema>;
export type FinalizationCancelParams = Infer<typeof FinalizationCancelParamsSchema>;
export type FinalizationCreateRequest = Infer<typeof FinalizationCreateRequestSchema>;
export type FinalizationCancelRequest = Infer<typeof FinalizationCancelRequestSchema>;
export type FinalizationResponse = Infer<typeof FinalizationResponseSchema>;
export type CurrentFinalizationResponse = Infer<typeof CurrentFinalizationResponseSchema>;

import { z } from 'zod';
import { VOTE_CHOICES } from '@/shared/constants';
import { isValidHexString } from '@/lib/utils/hex';
import { VERIFICATION_CHECK_IDS, VERIFICATION_EVIDENCE_VALUES } from '@/lib/verification/verification-checks';
import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@/lib/finalize/finalize-urls';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';

const hex32Schema = z
  .string()
  .refine((value) => isValidHexString(value, 32), {
    message: 'Expected 32-byte hex string',
  })
  .describe('hex32');
const timestampMsSchema = z.number().int().nonnegative();
const voteChoiceSchema = z.enum(VOTE_CHOICES);
const scenarioIdSchema = z.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
const verificationStatusSchema = z.enum(['success', 'failed', 'dev_mode', 'not_run', 'running']);
const currentArtifactStateSchema = z.enum(['supported', 'unsupported_current_artifact', 'corrupt_or_unreadable']);
const verificationExecutionIdSchema = z.string().regex(SAFE_VERIFIER_SEGMENT_PATTERN);
const verificationStepIdSchema = z.enum([
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
]);
const verificationStepStatusSchema = z.enum(['success', 'failed', 'running', 'not_run', 'pending']);
const verificationEvidenceSchema = z.enum(VERIFICATION_EVIDENCE_VALUES as unknown as [string, ...string[]]);
const verificationCheckIdSchema = z.enum(VERIFICATION_CHECK_IDS as unknown as [string, ...string[]]);

const tallyCountsSchema = z.object({
  A: z.number().int().nonnegative(),
  B: z.number().int().nonnegative(),
  C: z.number().int().nonnegative(),
  D: z.number().int().nonnegative(),
  E: z.number().int().nonnegative(),
});

const tallySchema = z.object({
  counts: tallyCountsSchema,
  totalVotes: z.number().int().nonnegative(),
  tamperedCount: z.number().int().nonnegative().optional(),
});

const inclusionProofSchema = z
  .object({
    leafIndex: z.number().int().nonnegative(),
    treeSize: z.number().int().nonnegative(),
    merklePath: z.array(hex32Schema),
    bulletinRootAtCast: hex32Schema,
  })
  .strict();

const voteReceiptBaseSchema = z.object({
  voteId: z.string().min(1),
  commitment: hex32Schema,
  bulletinIndex: z.number().int().nonnegative(),
  bulletinRootAtCast: hex32Schema,
  timestamp: timestampMsSchema,
});
const voteReceiptSchema = voteReceiptBaseSchema.extend({
  inputCommitment: hex32Schema.optional(),
});

const receiptPublicationSchema = z.object({
  receiptHash: hex32Schema,
  boardIndex: z.number().int().nonnegative(),
});

const receiptSchema = z
  .object({
    imageId: hex32Schema,
    seal: z.string(),
    journal: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

const publicVerificationReportSchema = z
  .object({
    status: verificationStatusSchema,
    verifier_version: z.string().optional(),
    verified_at: z.string().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    expected_image_id: z.string().optional(),
    receipt_image_id: z.string().nullable().optional(),
    dev_mode_receipt: z.boolean().optional(),
    errors: z.array(z.string()).optional(),
  })
  .strict();

const publicVerificationResultSchema = z
  .object({
    status: verificationStatusSchema,
    report: publicVerificationReportSchema.optional(),
    executionId: z.string().optional(),
  })
  .strict();

const currentZkvmJournalSchema = z
  .object({
    electionId: z.string().min(1),
    electionConfigHash: hex32Schema,
    bulletinRoot: hex32Schema,
    treeSize: z.number().int().nonnegative(),
    totalExpected: z.number().int().nonnegative(),
    sthDigest: hex32Schema,
    verifiedTally: z.array(z.number().int().nonnegative()).length(5),
    totalVotes: z.number().int().nonnegative(),
    validVotes: z.number().int().nonnegative(),
    invalidVotes: z.number().int().nonnegative(),
    seenIndicesCount: z.number().int().nonnegative(),
    missingSlots: z.number().int().nonnegative(),
    invalidPresentedSlots: z.number().int().nonnegative(),
    rejectedRecords: z.number().int().nonnegative(),
    seenBitmapRoot: hex32Schema,
    includedBitmapRoot: hex32Schema,
    excludedSlots: z.number().int().nonnegative(),
    inputCommitment: hex32Schema,
    methodVersion: z.literal(CURRENT_METHOD_VERSION),
    imageId: hex32Schema.optional(),
  })
  .strict();

const electionManifestSchema = z
  .object({
    electionId: z.string().min(1),
    totalExpected: z.number().int().nonnegative(),
    choices: z.array(z.string()),
    version: z.string().min(1),
    botCount: z.number().int().nonnegative(),
    merkleTreeDepth: z.number().int().nonnegative(),
    electionConfigHash: hex32Schema,
  })
  .strict();

const closeStatementSchema = z
  .object({
    logId: hex32Schema,
    treeSize: z.number().int().nonnegative(),
    timestamp: timestampMsSchema,
    bulletinRoot: hex32Schema,
    sthDigest: hex32Schema,
  })
  .strict();

const verificationStepSchema = z.object({
  id: verificationStepIdSchema,
  status: verificationStepStatusSchema,
  inputs: z.array(z.string()).optional(),
  error: z.string().optional(),
});
const verificationCheckSchema = z.object({
  id: verificationCheckIdSchema,
  status: verificationStepStatusSchema,
  evidence: verificationEvidenceSchema,
  inputs: z.array(z.string()),
  derivedFrom: verificationCheckIdSchema.optional(),
});

const botVotesSummarySchema = z.object({
  total: z.number().int().nonnegative().optional(),
  affectedBotIds: z.array(z.number().int().nonnegative()).optional(),
  source: z.string().min(1),
});

const tamperSummarySchema = z.object({
  ignoredVotes: z.number().int().nonnegative(),
  recountedVotes: z.number().int().nonnegative(),
  userRecountedTo: voteChoiceSchema.nullable(),
  affectedBotIds: z.array(z.number().int().nonnegative()).optional(),
});

const apiResponseSchema = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({
    data: schema,
  });

export const VoteRequestSchema = z.object({
  commitment: hex32Schema,
  vote: voteChoiceSchema,
  rand: hex32Schema,
  turnstileToken: z.string().min(1).optional(),
});

export const SessionCreateRequestSchema = z.object({
  turnstileToken: z.string().min(1).optional(),
});

export const FinalizeRequestSchema = z.object({
  scenarioId: scenarioIdSchema,
  turnstileToken: z.string().min(1).optional(),
});

export const VerificationRunRequestSchema = z.object({});

export const SessionResponseSchema = apiResponseSchema(
  z.object({
    sessionId: z.string().min(1),
    electionId: z.string().min(1),
    electionConfigHash: hex32Schema,
    logId: z.string().min(1),
    contractGeneration: z.string().min(1),
    capabilityToken: z.string().min(1),
  }),
);

export const VoteResponseSchema = apiResponseSchema(voteReceiptBaseSchema);

export const ProgressResponseSchema = apiResponseSchema(
  z.object({
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    completed: z.boolean(),
    userVoted: z.boolean(),
    finalized: z.boolean(),
    distribution: tallyCountsSchema.optional(),
    distributionKind: z.string().optional(),
    updatedAt: timestampMsSchema.optional(),
    animationSeed: z.string().optional(),
  }),
);

const finalizeQueueSchema = z.object({
  position: z.number().int().nonnegative(),
  depth: z.number().int().nonnegative(),
  concurrencyLimit: z.number().int().nonnegative(),
  estimatedStartAt: timestampMsSchema.optional(),
  estimatedDurationMs: z.number().int().nonnegative(),
  estimatedCompletionAt: timestampMsSchema.optional(),
});

const finalizeStateBaseSchema = z.object({
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'timeout']),
  executionId: z.string().min(1),
  queuedAt: timestampMsSchema,
  stepFunctionsArn: z.string().optional(),
});

const finalizePendingStateSchema = finalizeStateBaseSchema.extend({
  status: z.literal('pending'),
});

const finalizeRunningStateSchema = finalizeStateBaseSchema.extend({
  status: z.literal('running'),
  startedAt: timestampMsSchema,
});

const finalizeSucceededStateSchema = finalizeStateBaseSchema.extend({
  status: z.literal('succeeded'),
  startedAt: timestampMsSchema,
  completedAt: timestampMsSchema,
});

const finalizeFailedStateSchema = finalizeStateBaseSchema.extend({
  status: z.literal('failed'),
  startedAt: timestampMsSchema.optional(),
  failedAt: timestampMsSchema,
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

const finalizeTimeoutStateSchema = finalizeStateBaseSchema.extend({
  status: z.literal('timeout'),
  startedAt: timestampMsSchema.optional(),
  timeoutAt: timestampMsSchema,
});

const finalizeStateSchema = z.union([
  finalizePendingStateSchema,
  finalizeRunningStateSchema,
  finalizeSucceededStateSchema,
  finalizeFailedStateSchema,
  finalizeTimeoutStateSchema,
]);

const stepFunctionsDetailsSchema = z
  .object({
    executionArn: z.string().min(1),
    status: z.string().nullable(),
    startTime: timestampMsSchema.nullable(),
    stopTime: timestampMsSchema.nullable(),
    error: z.string().nullable(),
    cause: z.string().nullable(),
  })
  .nullable();

const sessionStatusFinalizationResultSchema = z
  .object({
    tally: tallySchema,
    bulletinRoot: hex32Schema,
    receiptPublication: receiptPublicationSchema.extend({ timestamp: timestampMsSchema.optional() }).optional(),
    imageId: hex32Schema,
    verifiedTally: z.array(z.number().int().nonnegative()).length(5),
    tamperDetected: z.boolean().optional(),
    scenarios: z.array(z.string()).optional(),
    journal: currentZkvmJournalSchema,
    electionManifest: electionManifestSchema.optional(),
    closeStatement: closeStatementSchema.optional(),
    bitmapProofSource: z.enum(['mock', 'real']).optional(),
    missingSlots: z.number().int().nonnegative(),
    invalidPresentedSlots: z.number().int().nonnegative(),
    rejectedRecords: z.number().int().nonnegative(),
    totalExpected: z.number().int().nonnegative(),
    treeSize: z.number().int().nonnegative(),
    excludedSlots: z.number().int().nonnegative(),
    sthDigest: hex32Schema,
    seenBitmapRoot: hex32Schema.optional(),
    includedBitmapRoot: hex32Schema,
    inputCommitment: hex32Schema,
    seenIndicesCount: z.number().int().nonnegative(),
    verificationResult: publicVerificationResultSchema.optional(),
    verificationExecutionId: verificationExecutionIdSchema.optional(),
    tamperSummary: tamperSummarySchema.optional(),
  })
  .strict();

const finalizeCancelResponseSchema = z.object({
  state: finalizeStateSchema,
});

export const FinalizeAcceptedResponseSchema = z.object({
  executionId: z.string().min(1),
  statusUrl: z.string().min(1),
  state: finalizeStateSchema,
  queue: finalizeQueueSchema.optional().nullable(),
});

const bulletinRootHistorySchema = z.object({
  timestamp: timestampMsSchema,
  treeSize: z.number().int().nonnegative(),
  bulletinRoot: hex32Schema,
  signature: z.string().optional(),
});

const bulletinResponseSchema = z.object({
  commitments: z.array(hex32Schema),
  bulletinRoot: hex32Schema,
  treeSize: z.number().int().nonnegative(),
  timestamp: timestampMsSchema,
  rootHistory: z.array(bulletinRootHistorySchema).optional(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
  hasMore: z.boolean().optional(),
});

const bulletinProofResponseSchema = z.object({
  voteId: z.string().min(1),
  proof: inclusionProofSchema,
});

const consistencyProofResponseSchema = z.object({
  oldSize: z.number().int().nonnegative(),
  newSize: z.number().int().nonnegative(),
  rootAtOldSize: hex32Schema,
  rootAtNewSize: hex32Schema,
  proofNodes: z.array(hex32Schema),
  oldSubtreeHashes: z.array(z.string()).optional(),
  appendSubtreeHashes: z.array(z.string()).optional(),
  timestamp: timestampMsSchema,
});

export const FinalizeSyncResponseSchema = apiResponseSchema(
  z.object({
    sessionId: z.string().min(1),
    tally: tallySchema,
    bulletinRoot: hex32Schema,
    verifiedTally: z.array(z.number().int().nonnegative()).length(5),
    voteReceipt: voteReceiptSchema,
    receipt: receiptSchema.optional(),
    receiptPublication: receiptPublicationSchema.optional(),
    imageId: hex32Schema,
    userVote: z.object({
      commitment: hex32Schema,
      voteId: z.string().min(1),
      proof: inclusionProofSchema,
    }),
    missingSlots: z.number().int().nonnegative(),
    invalidPresentedSlots: z.number().int().nonnegative(),
    rejectedRecords: z.number().int().nonnegative(),
    totalExpected: z.number().int().nonnegative(),
    treeSize: z.number().int().nonnegative(),
    excludedSlots: z.number().int().nonnegative(),
    sthDigest: hex32Schema,
    seenBitmapRoot: hex32Schema.optional(),
    includedBitmapRoot: hex32Schema,
    inputCommitment: hex32Schema,
    seenIndicesCount: z.number().int().nonnegative(),
    journal: currentZkvmJournalSchema,
    verificationStatus: verificationStatusSchema,
    verificationReport: publicVerificationReportSchema.optional(),
    verificationExecutionId: verificationExecutionIdSchema.optional(),
    tamperSummary: tamperSummarySchema.optional(),
  }),
);

export const SessionStatusResponseSchema = z.object({
  sessionId: z.string().min(1),
  finalizationState: finalizeStateSchema.nullable(),
  artifactState: currentArtifactStateSchema.optional(),
  queue: finalizeQueueSchema.optional().nullable(),
  progress: z
    .object({
      phase: z.string().min(1),
      source: z.string().min(1),
      percent: z.number().int().nonnegative(),
      updatedAt: timestampMsSchema,
    })
    .optional(),
  finalizationResult: sessionStatusFinalizationResultSchema.nullable(),
  stepFunctions: stepFunctionsDetailsSchema,
  asyncFinalizationMode: z.enum(['enabled', 'disabled']),
});

export const VerifyResponseSchema = apiResponseSchema(
  z
    .object({
      electionId: z.string().min(1),
      electionConfigHash: hex32Schema,
      logId: z.string().min(1),
      tally: tallySchema,
      bulletinRoot: hex32Schema,
      scenarioId: scenarioIdSchema,
      verificationStatus: verificationStatusSchema,
      verificationReport: publicVerificationReportSchema.optional(),
      verificationSteps: z.array(verificationStepSchema).optional(),
      verificationChecks: z.array(verificationCheckSchema).optional(),
      imageId: hex32Schema,
      tamperDetected: z.boolean().optional(),
      verifiedTally: z.array(z.number().int().nonnegative()).length(5),
      missingSlots: z.number().int().nonnegative(),
      invalidPresentedSlots: z.number().int().nonnegative(),
      rejectedRecords: z.number().int().nonnegative(),
      totalExpected: z.number().int().nonnegative(),
      treeSize: z.number().int().nonnegative(),
      excludedSlots: z.number().int().nonnegative(),
      sthDigest: hex32Schema,
      seenBitmapRoot: hex32Schema.optional(),
      includedBitmapRoot: hex32Schema,
      inputCommitment: hex32Schema,
      seenIndicesCount: z.number().int().nonnegative().optional(),
      voteReceipt: voteReceiptSchema.optional(),
      userVote: z
        .object({
          commitment: hex32Schema,
          vote: voteChoiceSchema.optional(),
          random: hex32Schema.optional(),
          voteId: z.string().min(1).optional(),
          proof: inclusionProofSchema.optional(),
        })
        .optional(),
      botVotesSummary: botVotesSummarySchema.optional(),
      verificationExecutionId: verificationExecutionIdSchema.optional(),
      tamperSummary: tamperSummarySchema.optional(),
    })
    .and(
      z.union([
        z.object({
          journalStatus: z.literal('available'),
          journal: currentZkvmJournalSchema,
        }),
        z.object({
          journalStatus: z.enum(['omitted', 'unavailable']),
          journal: z.undefined().optional(),
        }),
      ]),
    ),
);

export const VerificationRunResponseSchema = apiResponseSchema(
  z.object({
    verificationStatus: verificationStatusSchema,
    verificationExecutionId: verificationExecutionIdSchema,
    estimatedDurationMs: z.number().int().nonnegative(),
    idempotent: z.boolean(),
  }),
);

export const BotDataResponseSchema = apiResponseSchema(
  z.object({
    id: z.number().int().nonnegative(),
    vote: voteChoiceSchema,
    random: hex32Schema,
    commitment: hex32Schema,
    voteId: z.string().min(1),
    timestamp: timestampMsSchema,
    proof: inclusionProofSchema,
  }),
);

export const FinalizeCancelResponseSchema = finalizeCancelResponseSchema;
export const BulletinResponseSchema = bulletinResponseSchema;
export const BulletinProofResponseSchema = bulletinProofResponseSchema;
export const ConsistencyProofResponseSchema = consistencyProofResponseSchema;

export type VoteRequest = z.infer<typeof VoteRequestSchema>;
export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;
export type FinalizeRequest = z.infer<typeof FinalizeRequestSchema>;
export type VerificationRunRequest = z.infer<typeof VerificationRunRequestSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type VoteResponse = z.infer<typeof VoteResponseSchema>;
export type ProgressResponse = z.infer<typeof ProgressResponseSchema>;
export type FinalizeAcceptedResponse = z.infer<typeof FinalizeAcceptedResponseSchema>;
export type FinalizeCancelResponse = z.infer<typeof FinalizeCancelResponseSchema>;
export type FinalizeSyncResponse = z.infer<typeof FinalizeSyncResponseSchema>;
export type SessionStatusResponse = z.infer<typeof SessionStatusResponseSchema>;
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export type VerificationRunResponse = z.infer<typeof VerificationRunResponseSchema>;
export type BotDataResponse = z.infer<typeof BotDataResponseSchema>;
export type BulletinResponse = z.infer<typeof BulletinResponseSchema>;
export type BulletinProofResponse = z.infer<typeof BulletinProofResponseSchema>;
export type ConsistencyProofResponse = z.infer<typeof ConsistencyProofResponseSchema>;

import { SAFE_VERIFIER_SEGMENT_PATTERN } from '@stark-ballot/validation/safe-verifier-segment';
import { s, type Infer, type Schema, type SchemaTypeAny } from '@stark-ballot/validation/schema';
import { VOTE_CHOICES, type VoteChoice } from '@stark-ballot/api-contract/validation/constants';

const PUBLIC_VERIFICATION_ERROR_MESSAGES = [
  'ImageID mismatch',
  'Receipt does not contain ImageID',
  'Invalid proof',
  'Failed to download bundle',
  'Verification failed',
] as const;
const SESSION_CAPABILITY_HEADER = 'X-Session-Capability';
const SESSION_ID_HEADER = 'X-Session-ID';
const CURRENT_METHOD_VERSION = 14;
export const PUBLIC_VERIFICATION_EVIDENCE_VALUES = ['local', 'public', 'zk', 'demo'] as const;
export type PublicVerificationEvidence = (typeof PUBLIC_VERIFICATION_EVIDENCE_VALUES)[number];
export const PUBLIC_VERIFICATION_CHECK_IDS = [
  'cast_receipt_present',
  'cast_choice_range',
  'cast_random_format',
  'cast_commitment_match',
  'recorded_commitment_in_bulletin',
  'recorded_index_in_range',
  'recorded_root_at_cast_consistent',
  'recorded_inclusion_proof',
  'recorded_consistency_proof',
  'recorded_sth_third_party',
  'counted_input_sanity',
  'counted_unique_indices',
  'counted_unique_commitments',
  'counted_tally_consistent',
  'counted_missing_indices_zero',
  'counted_expected_vs_tree_size',
  'counted_election_manifest_consistent',
  'counted_close_statement_consistent',
  'counted_my_vote_included',
  'counted_input_commitment_match',
  'stark_image_id_match',
  'stark_receipt_verify',
] as const;
export type PublicVerificationCheckId = (typeof PUBLIC_VERIFICATION_CHECK_IDS)[number];
export const PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES = [
  'pages.verify.stepsCard.notes.myVoteIncluded.notPresented',
  'pages.verify.stepsCard.notes.myVoteIncluded.presentedButInvalid',
  'pages.verify.stepsCard.notes.myVoteIncluded.excluded',
  'pages.verify.stepsCard.notes.myVoteIncluded.missingReceipt',
  'pages.verify.stepsCard.notes.myVoteIncluded.proofUnavailable',
] as const;
export type PublicVerificationCheckNoteKey = (typeof PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES)[number];

function isValidHexString(value: string, byteLength?: number): boolean {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;
  return /^[0-9a-fA-F]+$/.test(normalized) && (byteLength === undefined || normalized.length === byteLength * 2);
}

type TallyCounts = Record<VoteChoice, number>;
type VerificationStatus = 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running';
type PublicVerificationErrorMessage = (typeof PUBLIC_VERIFICATION_ERROR_MESSAGES)[number];
type PublicVerificationReport = {
  status: VerificationStatus;
  verifier_version?: string;
  verified_at?: string;
  duration_ms?: number;
  expected_image_id?: string;
  receipt_image_id?: string | null;
  dev_mode_receipt?: boolean;
  errors?: PublicVerificationErrorMessage[];
};
type PublicVerificationResult = {
  status: VerificationStatus;
  report?: PublicVerificationReport;
  executionId?: string;
};
type BitmapProofSource = 'mock' | 'real';
type ElectionManifest = {
  electionId: string;
  totalExpected: number;
  choices: readonly string[];
  version: string;
  botCount: number;
  merkleTreeDepth: number;
  electionConfigHash: string;
};
type CloseStatement = {
  logId: string;
  treeSize: number;
  timestamp: number;
  bulletinRoot: string;
  sthDigest: string;
};
type CurrentZkVMJournal = {
  electionId: string;
  electionConfigHash: string;
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;
  sthDigest: string;
  verifiedTally: number[];
  totalVotes: number;
  validVotes: number;
  invalidVotes: number;
  seenIndicesCount: number;
  missingSlots: number;
  invalidPresentedSlots: number;
  rejectedRecords: number;
  seenBitmapRoot: string;
  includedBitmapRoot: string;
  excludedSlots: number;
  inputCommitment: string;
  methodVersion: typeof CURRENT_METHOD_VERSION;
  imageId?: string;
};
type TallyPayload = {
  counts: TallyCounts;
  totalVotes: number;
  tamperedCount?: number;
};
type InclusionProofPayload = {
  leafIndex: number;
  treeSize: number;
  merklePath: string[];
  bulletinRootAtCast: string;
};
type VoteReceiptPayload = {
  voteId: string;
  commitment: string;
  bulletinIndex: number;
  bulletinRootAtCast: string;
  timestamp: number;
  inputCommitment?: string;
};
type CurrentJournalPayload = CurrentZkVMJournal;
type ReceiptPublicationPayload = {
  receiptHash: string;
  boardIndex: number;
};
type PublicReceiptPublicationPayload = ReceiptPublicationPayload & {
  timestamp?: number;
};
type ReceiptPayload = {
  imageId: string;
  seal: string;
  journal?: string;
  metadata?: {
    isFake?: boolean;
  };
};
type VerificationStepPayload = {
  id: 'cast_as_intended' | 'recorded_as_cast' | 'counted_as_recorded' | 'stark_verification';
  status: 'success' | 'failed' | 'running' | 'not_run' | 'pending';
  inputs?: string[];
  error?: string;
};
type VerificationCheckPayload = {
  id: PublicVerificationCheckId;
  status: 'success' | 'failed' | 'running' | 'not_run' | 'pending';
  evidence: PublicVerificationEvidence;
  inputs: string[];
  noteKey?: PublicVerificationCheckNoteKey;
  derivedFrom?: PublicVerificationCheckId;
};
type BotVotesSummaryPayload = {
  total?: number;
  affectedBotIds?: number[];
  source: string;
};
type TamperSummaryPayload = {
  ignoredVotes: number;
  recountedVotes: number;
  userRecountedTo: VoteChoice | null;
  affectedBotIds?: number[];
};
type PublicProofSummaryPayload = {
  tally: TallyPayload;
  imageId: string;
  tamperDetected?: boolean;
  bulletinRoot: string;
  verifiedTally: number[];
  missingSlots: number;
  invalidPresentedSlots: number;
  rejectedRecords: number;
  totalExpected: number;
  treeSize: number;
  excludedSlots: number;
  sthDigest: string;
  seenBitmapRoot?: string;
  includedBitmapRoot: string;
  inputCommitment: string;
  seenIndicesCount: number;
  verificationExecutionId?: string;
  tamperSummary?: TamperSummaryPayload;
};
type PublicFinalizationResultPayload = PublicProofSummaryPayload & {
  receiptPublication?: PublicReceiptPublicationPayload;
  scenarios?: string[];
  journal: CurrentJournalPayload;
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  bitmapProofSource?: BitmapProofSource;
  verificationResult?: PublicVerificationResult;
};
type UserVotePayload = {
  commitment: string;
  voteId: string;
  proof: InclusionProofPayload;
};
type PublicFinalizeState =
  | { status: 'pending'; executionId: string; queuedAt: number }
  | { status: 'running'; executionId: string; queuedAt: number; startedAt: number }
  | { status: 'succeeded'; executionId: string; queuedAt: number; startedAt: number; completedAt: number }
  | {
      status: 'failed';
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      failedAt: number;
      error: { code: string; message: string };
    }
  | { status: 'timeout'; executionId: string; queuedAt: number; startedAt?: number; timeoutAt: number };
type FinalizationState =
  | (PublicFinalizeState & { stepFunctionsArn?: string })
  | {
      status: 'succeeded';
      executionId: string;
      queuedAt: number;
      startedAt: number;
      completedAt: number;
      stepFunctionsArn?: string;
      bundleMetadata?: { s3BundleKey?: string; s3UploadedAt?: string };
    }
  | {
      status: 'failed';
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      failedAt: number;
      stepFunctionsArn?: string;
      error: { code: string; message: string; details?: unknown };
    };
type FinalizeQueuePayload = {
  concurrencyLimit: number;
  estimatedDurationMs: number;
};

export type VoteRequest = {
  commitment: string;
  vote: VoteChoice;
  rand: string;
  turnstileToken?: string;
  'cf-turnstile-response'?: string;
  cfTurnstileResponse?: string;
};
export type SessionCreateRequest = {
  turnstileToken?: string;
  'cf-turnstile-response'?: string;
  cfTurnstileResponse?: string;
};
export type FinalizeRequest = {
  scenarioId: 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
  turnstileToken?: string;
  'cf-turnstile-response'?: string;
  cfTurnstileResponse?: string;
};
export type FinalizeCancelRequest = {
  executionId: string;
  reason?: string;
};
export type VerificationRunRequest = Record<string, never>;
export type FinalizeAcceptedResponse = {
  executionId: string;
  statusUrl: string;
  state: PublicFinalizeState;
  queue?: FinalizeQueuePayload | null;
};
export type FinalizeCancelResponse = {
  state: PublicFinalizeState;
};
type FinalizeSyncResponsePayload = {
  data: PublicProofSummaryPayload & {
    sessionId: string;
    journal: CurrentJournalPayload;
    voteReceipt: VoteReceiptPayload;
    receipt?: ReceiptPayload;
    receiptPublication?: PublicReceiptPublicationPayload;
    userVote: UserVotePayload;
    verificationStatus: 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running';
    verificationReport?: PublicVerificationReport;
  };
};
type SessionStatusResponsePayload = {
  sessionId: string;
  finalizationState: PublicFinalizeState | null;
  artifactState?: 'supported' | 'unsupported_current_artifact' | 'corrupt_or_unreadable';
  queue?: FinalizeQueuePayload | null;
  finalizationResult: PublicFinalizationResultPayload | null;
  stepFunctions: {
    status: string | null;
    startTime: number | null;
    stopTime: number | null;
  } | null;
  asyncFinalizationMode: 'enabled' | 'disabled';
  progress?: {
    phase: string;
    source: string;
    percent: number;
    updatedAt: number;
  };
};
type VerifyResponseDataBase = PublicProofSummaryPayload & {
  electionId: string;
  electionConfigHash: string;
  logId: string;
  scenarioId: 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
  verificationStatus: 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running';
  verificationReport?: PublicVerificationReport;
  verificationSteps?: VerificationStepPayload[];
  verificationChecks?: VerificationCheckPayload[];
  voteReceipt?: VoteReceiptPayload;
  userVote?: {
    commitment: string;
    voteId?: string;
    proof?: InclusionProofPayload;
  };
  botVotesSummary?: BotVotesSummaryPayload;
};
type VerifyResponsePayload = {
  data: VerifyResponseDataBase &
    (
      | {
          journalStatus: 'available';
          journal: CurrentJournalPayload;
        }
      | {
          journalStatus: 'omitted' | 'unavailable';
          journal?: undefined;
        }
    );
};
export type VerifyFailClosedResponse = {
  error: 'UNSUPPORTED_CURRENT_ARTIFACT' | 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE';
  message: string;
  artifactState: 'unsupported_current_artifact' | 'corrupt_or_unreadable';
};
type SessionResponsePayload = {
  data: {
    sessionId: string;
    electionId: string;
    electionConfigHash: string;
    logId: string;
    contractGeneration: string;
    capabilityToken: string;
  };
};
type VoteResponsePayload = {
  data: VoteReceiptPayload;
};
type ProgressResponsePayload = {
  data: {
    count: number;
    total: number;
    completed: boolean;
    userVoted: boolean;
    finalized: boolean;
    distribution?: TallyCounts;
    distributionKind?: string;
    updatedAt?: number;
    animationSeed?: string;
  };
};
type BulletinRootHistoryPayload = {
  timestamp: number;
  treeSize: number;
  bulletinRoot: string;
  signature?: string;
};
type BulletinResponsePayload = {
  commitments: string[];
  bulletinRoot: string;
  treeSize: number;
  timestamp: number;
  rootHistory?: BulletinRootHistoryPayload[];
  nextOffset?: number | null;
  hasMore?: boolean;
};
type BulletinProofResponsePayload = {
  voteId: string;
  proof: InclusionProofPayload;
};
type ConsistencyProofResponsePayload = {
  oldSize: number;
  newSize: number;
  rootAtOldSize: string;
  rootAtNewSize: string;
  proofNodes: string[];
  oldSubtreeHashes?: string[];
  appendSubtreeHashes?: string[];
  timestamp: number;
};
type BitmapProofResponsePayload = {
  leafChunk: string;
  auditPath: Array<{
    hash: string;
    position: 'left' | 'right';
  }>;
};
type SthResponsePayload = {
  sth: {
    sthDigest: string;
    bulletinRoot: string;
    treeSize: number;
    timestamp: number;
    logId: string;
  };
};
type ZkVMInputHashResponsePayload = {
  inputCommitment: string;
};
type VerificationRunResponsePayload = {
  data: {
    verificationStatus: 'success' | 'failed' | 'dev_mode' | 'not_run' | 'running';
    verificationExecutionId: string;
    estimatedDurationMs: number;
    idempotent: boolean;
  };
};
type FinalizeCallbackResponsePayload = {
  sessionId: string;
  state: FinalizationState;
};

const hex32Schema = s
  .string()
  .refine((value) => isValidHexString(value, 32), {
    message: 'Expected 32-byte hex string',
  })
  .describe('hex32');
const timestampMsSchema = s.number().int().nonnegative();
const voteChoiceSchema = s.enum(VOTE_CHOICES);
const scenarioIdSchema = s.enum(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
const verificationStatusSchema = s.enum(['success', 'failed', 'dev_mode', 'not_run', 'running']);
const publicVerificationErrorSchema = s.enum(PUBLIC_VERIFICATION_ERROR_MESSAGES);
const failClosedArtifactStateSchema = s.enum(['unsupported_current_artifact', 'corrupt_or_unreadable']);
const currentArtifactStateSchema = s.enum(['supported', 'unsupported_current_artifact', 'corrupt_or_unreadable']);
const safeVerifierSegmentSchema = s
  .string()
  .regex(SAFE_VERIFIER_SEGMENT_PATTERN, 'Expected a safe single path segment');
const verificationExecutionIdSchema = safeVerifierSegmentSchema;
const verificationStepIdSchema = s.enum([
  'cast_as_intended',
  'recorded_as_cast',
  'counted_as_recorded',
  'stark_verification',
]);
const verificationStepStatusSchema = s.enum(['success', 'failed', 'running', 'not_run', 'pending']);
const verificationEvidenceSchema = s.enum(PUBLIC_VERIFICATION_EVIDENCE_VALUES);
const verificationCheckIdSchema = s.enum(PUBLIC_VERIFICATION_CHECK_IDS);

const publicObject = (shape: Record<string, SchemaTypeAny>) => s.object(shape).strict();

const CURRENT_JOURNAL_UINT32_MAX = 0xffffffff;

const currentJournalUint32Schema = () => s.number().int().nonnegative().max(CURRENT_JOURNAL_UINT32_MAX);
const currentJournalPositiveUint32Schema = () => currentJournalUint32Schema().min(1);
const currentJournalTallySchema = () => s.array(currentJournalUint32Schema()).length(5);

const turnstileTokenFields = {
  turnstileToken: s.string().min(1).optional(),
  'cf-turnstile-response': s.string().min(1).optional(),
  cfTurnstileResponse: s.string().min(1).optional(),
};

const tallyCountsSchema = publicObject({
  A: s.number().int().nonnegative(),
  B: s.number().int().nonnegative(),
  C: s.number().int().nonnegative(),
  D: s.number().int().nonnegative(),
  E: s.number().int().nonnegative(),
});

const tallySchema = publicObject({
  counts: tallyCountsSchema,
  totalVotes: s.number().int().nonnegative(),
  tamperedCount: s.number().int().nonnegative().optional(),
});

const inclusionProofSchema = s
  .object({
    leafIndex: s.number().int().nonnegative(),
    treeSize: s.number().int().nonnegative(),
    merklePath: s.array(hex32Schema),
    bulletinRootAtCast: hex32Schema,
  })
  .strict();

const voteReceiptBaseSchema = publicObject({
  voteId: s.string().min(1),
  commitment: hex32Schema,
  bulletinIndex: s.number().int().nonnegative(),
  bulletinRootAtCast: hex32Schema,
  timestamp: timestampMsSchema,
});
const voteReceiptSchema = voteReceiptBaseSchema.extend({
  inputCommitment: hex32Schema.optional(),
});

const receiptPublicationSchema = publicObject({
  receiptHash: hex32Schema,
  boardIndex: s.number().int().nonnegative(),
});

const receiptMetadataSchema = s
  .object({
    isFake: s.boolean().optional(),
  })
  .strict();

const receiptSchema = s
  .object({
    imageId: hex32Schema,
    seal: s.string(),
    journal: s.string().optional(),
    metadata: receiptMetadataSchema.optional(),
  })
  .strict();

const publicVerificationReportSchema = s
  .object({
    status: verificationStatusSchema,
    verifier_version: s.string().optional(),
    verified_at: s.string().optional(),
    duration_ms: s.number().int().nonnegative().optional(),
    expected_image_id: s.string().optional(),
    receipt_image_id: s.string().nullable().optional(),
    dev_mode_receipt: s.boolean().optional(),
    errors: s.array(publicVerificationErrorSchema).optional(),
  })
  .strict();

const publicVerificationResultSchema = s
  .object({
    status: verificationStatusSchema,
    report: publicVerificationReportSchema.optional(),
    executionId: s.string().optional(),
  })
  .strict();

const currentZkvmJournalSchema = s
  .object({
    electionId: s.string().min(1),
    electionConfigHash: hex32Schema,
    bulletinRoot: hex32Schema,
    treeSize: currentJournalPositiveUint32Schema(),
    totalExpected: currentJournalUint32Schema(),
    sthDigest: hex32Schema,
    verifiedTally: currentJournalTallySchema(),
    totalVotes: currentJournalUint32Schema(),
    validVotes: currentJournalUint32Schema(),
    invalidVotes: currentJournalUint32Schema(),
    seenIndicesCount: currentJournalUint32Schema(),
    missingSlots: currentJournalUint32Schema(),
    invalidPresentedSlots: currentJournalUint32Schema(),
    rejectedRecords: currentJournalUint32Schema(),
    seenBitmapRoot: hex32Schema,
    includedBitmapRoot: hex32Schema,
    excludedSlots: currentJournalUint32Schema(),
    inputCommitment: hex32Schema,
    methodVersion: s.literal(CURRENT_METHOD_VERSION),
    imageId: hex32Schema.optional(),
  })
  .strict();

const electionManifestSchema = s
  .object({
    electionId: s.string().min(1),
    totalExpected: s.number().int().nonnegative(),
    choices: s.array(s.string()),
    version: s.string().min(1),
    botCount: s.number().int().nonnegative(),
    merkleTreeDepth: s.number().int().nonnegative(),
    electionConfigHash: hex32Schema,
  })
  .strict();

const closeStatementSchema = s
  .object({
    logId: hex32Schema,
    treeSize: s.number().int().nonnegative(),
    timestamp: timestampMsSchema,
    bulletinRoot: hex32Schema,
    sthDigest: hex32Schema,
  })
  .strict();

const verificationStepSchema = publicObject({
  id: verificationStepIdSchema,
  status: verificationStepStatusSchema,
  inputs: s.array(s.string()).optional(),
  error: s.string().optional(),
});
const verificationCheckSchema = publicObject({
  id: verificationCheckIdSchema,
  status: verificationStepStatusSchema,
  evidence: verificationEvidenceSchema,
  inputs: s.array(s.string()),
  noteKey: s.enum(PUBLIC_VERIFICATION_CHECK_NOTE_KEY_VALUES).optional(),
  derivedFrom: verificationCheckIdSchema.optional(),
});

const botVotesSummarySchema = publicObject({
  total: s.number().int().nonnegative().optional(),
  affectedBotIds: s.array(s.number().int().nonnegative()).optional(),
  source: s.string().min(1),
});

const tamperSummarySchema = publicObject({
  ignoredVotes: s.number().int().nonnegative(),
  recountedVotes: s.number().int().nonnegative(),
  userRecountedTo: voteChoiceSchema.nullable(),
  affectedBotIds: s.array(s.number().int().nonnegative()).optional(),
});

const apiResponseSchema = <T extends SchemaTypeAny>(schema: T) =>
  publicObject({
    data: schema,
  });

const sessionIdParamSchema = s.string().min(1);
const nonNegativeIntegerQuerySchema = s.string().regex(/^(0|[1-9]\d*)$/);
const positiveIntegerQuerySchema = s.string().regex(/^[1-9]\d*$/);
const bulletinLimitQuerySchema = positiveIntegerQuerySchema.refine((value) => Number(value) <= 1000, {
  message: 'Expected integer <= 1000',
});

const flattenedSchemaErrorSchema = publicObject({
  formErrors: s.array(s.string()),
  fieldErrors: s.object({}).catchall(s.array(s.string())).strict(),
});

export const StandardErrorResponseSchema = s
  .object({
    error: s.string().min(1),
    message: s.string().min(1).optional(),
    statusCode: s.number().int().optional(),
    details: s.string().min(1).optional(),
    issues: flattenedSchemaErrorSchema.optional(),
    reason: s.string().min(1).optional(),
    retryAfter: s.number().nonnegative().optional(),
    limitBytes: s.number().int().nonnegative().optional(),
    receivedBytes: s.number().int().nonnegative().optional(),
    nextAvailableAt: s.string().min(1).optional(),
    remainingExecutions: s.number().int().nonnegative().optional(),
    artifactState: currentArtifactStateSchema.optional(),
    runtimeContractGeneration: s.string().min(1).optional(),
    persistedContractGeneration: s.string().min(1).nullable().optional(),
    carriedContractGeneration: s.string().min(1).nullable().optional(),
    status: verificationStatusSchema.optional(),
    verificationExecutionId: verificationExecutionIdSchema.optional(),
    verificationReport: publicVerificationReportSchema.optional(),
    voteIndex: s.number().int().nonnegative().optional(),
    expectedTreeSize: s.number().int().nonnegative().optional(),
    actualTreeSize: s.number().int().nonnegative().optional(),
    errorCodes: s.array(s.string().min(1)).optional(),
  })
  .strict();

export const SessionCapabilityHeadersSchema = s
  .object({
    [SESSION_ID_HEADER]: s.string().min(1),
    [SESSION_CAPABILITY_HEADER]: s.string().min(1),
  })
  .strict();

export const PathSessionCapabilityHeadersSchema = s
  .object({
    [SESSION_CAPABILITY_HEADER]: s.string().min(1),
  })
  .strict();

export const VerifyQuerySchema = s
  .object({
    includeJournal: s.literal('1').optional(),
  })
  .strict();

export const BulletinQuerySchema = s
  .object({
    offset: nonNegativeIntegerQuerySchema.optional(),
    limit: bulletinLimitQuerySchema.optional(),
  })
  .strict();

export const SessionStatusParamsSchema = s
  .object({
    sessionId: sessionIdParamSchema,
  })
  .strict();

export const VerificationBundleParamsSchema = s
  .object({
    sessionId: sessionIdParamSchema,
    executionId: verificationExecutionIdSchema,
  })
  .strict();

export const ConsistencyProofQuerySchema = s
  .object({
    oldSize: nonNegativeIntegerQuerySchema,
    newSize: nonNegativeIntegerQuerySchema,
  })
  .strict();

export const BulletinVoteProofParamsSchema = s
  .object({
    voteId: s.string().min(1),
  })
  .strict();

export const BotDataParamsSchema = s
  .object({
    id: nonNegativeIntegerQuerySchema,
  })
  .strict();

export const BitmapProofQuerySchema = s
  .object({
    i: nonNegativeIntegerQuerySchema,
    kind: s.enum(['included', 'seen']).optional(),
  })
  .strict();

export const SthQuerySchema = s
  .object({
    auditor: s
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
  })
  .strict();

export const ZkVMInputHashQuerySchema = s
  .object({
    sessionId: sessionIdParamSchema,
    includeData: s.undefined().optional(),
  })
  .strict();

export const VoteRequestSchema: Schema<VoteRequest> = s.typed(
  publicObject({
    commitment: hex32Schema,
    vote: voteChoiceSchema,
    rand: hex32Schema,
    ...turnstileTokenFields,
  }),
);

export const SessionCreateRequestSchema: Schema<SessionCreateRequest> = s.typed(
  publicObject({
    ...turnstileTokenFields,
  }),
);

export const FinalizeRequestSchema: Schema<FinalizeRequest> = s.typed(
  publicObject({
    scenarioId: scenarioIdSchema,
    ...turnstileTokenFields,
  }),
);

export const FinalizeCancelRequestSchema: Schema<FinalizeCancelRequest> = s.typed(
  publicObject({
    executionId: safeVerifierSegmentSchema.min(10),
    reason: s.string().max(256).optional(),
  }),
);

export const VerificationRunRequestSchema: Schema<VerificationRunRequest> = s.typed(publicObject({}));

export const SessionResponseSchema: Schema<SessionResponsePayload> = s.typed(
  apiResponseSchema(
    publicObject({
      sessionId: s.string().min(1),
      electionId: s.string().min(1),
      electionConfigHash: hex32Schema,
      logId: s.string().min(1),
      contractGeneration: s.string().min(1),
      capabilityToken: s.string().min(1),
    }),
  ),
);

export const VoteResponseSchema: Schema<VoteResponsePayload> = s.typed(apiResponseSchema(voteReceiptBaseSchema));

export const ProgressResponseSchema: Schema<ProgressResponsePayload> = s.typed(
  apiResponseSchema(
    publicObject({
      count: s.number().int().nonnegative(),
      total: s.number().int().nonnegative(),
      completed: s.boolean(),
      userVoted: s.boolean(),
      finalized: s.boolean(),
      distribution: tallyCountsSchema.optional(),
      distributionKind: s.string().optional(),
      updatedAt: timestampMsSchema.optional(),
      animationSeed: s.string().optional(),
    }),
  ),
);

const finalizeQueueSchema = publicObject({
  concurrencyLimit: s.number().int().nonnegative(),
  estimatedDurationMs: s.number().int().nonnegative(),
});

const finalizeStateBaseFields = {
  status: s.enum(['pending', 'running', 'succeeded', 'failed', 'timeout']),
  executionId: safeVerifierSegmentSchema,
  queuedAt: timestampMsSchema,
};

const publicFinalizeStateBaseSchema = s.object(finalizeStateBaseFields).strict();

const publicFinalizePendingStateSchema = publicFinalizeStateBaseSchema.extend({
  status: s.literal('pending'),
});

const publicFinalizeRunningStateSchema = publicFinalizeStateBaseSchema.extend({
  status: s.literal('running'),
  startedAt: timestampMsSchema,
});

const publicFinalizeSucceededStateSchema = publicFinalizeStateBaseSchema.extend({
  status: s.literal('succeeded'),
  startedAt: timestampMsSchema,
  completedAt: timestampMsSchema,
});

const publicFinalizeFailedStateSchema = publicFinalizeStateBaseSchema.extend({
  status: s.literal('failed'),
  startedAt: timestampMsSchema.optional(),
  failedAt: timestampMsSchema,
  error: s
    .object({
      code: s.string().min(1),
      message: s.string().min(1),
    })
    .strict(),
});

const publicFinalizeTimeoutStateSchema = publicFinalizeStateBaseSchema.extend({
  status: s.literal('timeout'),
  startedAt: timestampMsSchema.optional(),
  timeoutAt: timestampMsSchema,
});

const publicFinalizeStateSchema = s.union([
  publicFinalizePendingStateSchema,
  publicFinalizeRunningStateSchema,
  publicFinalizeSucceededStateSchema,
  publicFinalizeFailedStateSchema,
  publicFinalizeTimeoutStateSchema,
]);

const internalFinalizeStateBaseSchema = s
  .object({
    ...finalizeStateBaseFields,
    stepFunctionsArn: s.string().min(1).optional(),
  })
  .strict();

const internalFinalizePendingStateSchema = internalFinalizeStateBaseSchema.extend({
  status: s.literal('pending'),
});

const internalFinalizeRunningStateSchema = internalFinalizeStateBaseSchema.extend({
  status: s.literal('running'),
  startedAt: timestampMsSchema,
});

const internalFinalizeSucceededStateSchema = internalFinalizeStateBaseSchema.extend({
  status: s.literal('succeeded'),
  startedAt: timestampMsSchema,
  completedAt: timestampMsSchema,
  bundleMetadata: s
    .object({
      s3BundleKey: s.string().min(1).optional(),
      s3UploadedAt: s.string().min(1).optional(),
    })
    .strict()
    .optional(),
});

const internalFinalizeFailedStateSchema = internalFinalizeStateBaseSchema.extend({
  status: s.literal('failed'),
  startedAt: timestampMsSchema.optional(),
  failedAt: timestampMsSchema,
  error: s
    .object({
      code: s.string().min(1),
      message: s.string().min(1),
      details: s.unknown().optional(),
    })
    .strict(),
});

const internalFinalizeTimeoutStateSchema = internalFinalizeStateBaseSchema.extend({
  status: s.literal('timeout'),
  startedAt: timestampMsSchema.optional(),
  timeoutAt: timestampMsSchema,
});

const internalFinalizeStateSchema = s.union([
  internalFinalizePendingStateSchema,
  internalFinalizeRunningStateSchema,
  internalFinalizeSucceededStateSchema,
  internalFinalizeFailedStateSchema,
  internalFinalizeTimeoutStateSchema,
]);

const stepFunctionsDetailsSchema = s
  .object({
    status: s.string().nullable(),
    startTime: timestampMsSchema.nullable(),
    stopTime: timestampMsSchema.nullable(),
  })
  .strict()
  .nullable();

const sessionStatusFinalizationResultSchema = s
  .object({
    tally: tallySchema,
    bulletinRoot: hex32Schema,
    receiptPublication: receiptPublicationSchema.extend({ timestamp: timestampMsSchema.optional() }).optional(),
    imageId: hex32Schema,
    verifiedTally: currentJournalTallySchema(),
    tamperDetected: s.boolean().optional(),
    scenarios: s.array(s.string()).optional(),
    journal: currentZkvmJournalSchema,
    electionManifest: electionManifestSchema.optional(),
    closeStatement: closeStatementSchema.optional(),
    bitmapProofSource: s.enum(['mock', 'real']).optional(),
    missingSlots: currentJournalUint32Schema(),
    invalidPresentedSlots: currentJournalUint32Schema(),
    rejectedRecords: currentJournalUint32Schema(),
    totalExpected: currentJournalUint32Schema(),
    treeSize: currentJournalPositiveUint32Schema(),
    excludedSlots: currentJournalUint32Schema(),
    sthDigest: hex32Schema,
    seenBitmapRoot: hex32Schema.optional(),
    includedBitmapRoot: hex32Schema,
    inputCommitment: hex32Schema,
    seenIndicesCount: currentJournalUint32Schema(),
    verificationResult: publicVerificationResultSchema.optional(),
    verificationExecutionId: verificationExecutionIdSchema.optional(),
    tamperSummary: tamperSummarySchema.optional(),
  })
  .strict();

const finalizeCancelResponseSchema: Schema<FinalizeCancelResponse> = s.typed(
  publicObject({
    state: publicFinalizeStateSchema,
  }),
);

export const FinalizeAcceptedResponseSchema: Schema<FinalizeAcceptedResponse> = s.typed(
  publicObject({
    executionId: safeVerifierSegmentSchema,
    statusUrl: s.string().min(1),
    state: publicFinalizeStateSchema,
    queue: finalizeQueueSchema.optional().nullable(),
  }),
);

const bulletinRootHistorySchema = publicObject({
  timestamp: timestampMsSchema,
  treeSize: s.number().int().nonnegative(),
  bulletinRoot: hex32Schema,
  signature: s.string().optional(),
});

const bulletinResponseSchema: Schema<BulletinResponsePayload> = s.typed(
  publicObject({
    commitments: s.array(hex32Schema),
    bulletinRoot: hex32Schema,
    treeSize: s.number().int().nonnegative(),
    timestamp: timestampMsSchema,
    rootHistory: s.array(bulletinRootHistorySchema).optional(),
    nextOffset: s.number().int().nonnegative().nullable().optional(),
    hasMore: s.boolean().optional(),
  }),
);

const bulletinProofResponseSchema: Schema<BulletinProofResponsePayload> = s.typed(
  publicObject({
    voteId: s.string().min(1),
    proof: inclusionProofSchema,
  }),
);

const consistencyProofResponseSchema: Schema<ConsistencyProofResponsePayload> = s.typed(
  publicObject({
    oldSize: s.number().int().nonnegative(),
    newSize: s.number().int().nonnegative(),
    rootAtOldSize: hex32Schema,
    rootAtNewSize: hex32Schema,
    proofNodes: s.array(hex32Schema),
    oldSubtreeHashes: s.array(s.string()).optional(),
    appendSubtreeHashes: s.array(s.string()).optional(),
    timestamp: timestampMsSchema,
  }),
);

const bitmapProofResponseSchema: Schema<BitmapProofResponsePayload> = s.typed(
  s
    .object({
      leafChunk: hex32Schema,
      auditPath: s.array(
        s
          .object({
            hash: hex32Schema,
            position: s.enum(['left', 'right']),
          })
          .strict(),
      ),
    })
    .strict(),
);

const sthResponseSchema: Schema<SthResponsePayload> = s.typed(
  s
    .object({
      sth: s
        .object({
          sthDigest: hex32Schema,
          bulletinRoot: hex32Schema,
          treeSize: s.number().int().nonnegative(),
          timestamp: timestampMsSchema,
          logId: s.string(),
        })
        .strict(),
    })
    .strict(),
);

const zkvmInputHashResponseSchema: Schema<ZkVMInputHashResponsePayload> = s.typed(
  s
    .object({
      inputCommitment: hex32Schema,
    })
    .strict(),
);

export const FinalizeSyncResponseSchema: Schema<FinalizeSyncResponsePayload> = s.typed(
  apiResponseSchema(
    publicObject({
      sessionId: s.string().min(1),
      tally: tallySchema,
      bulletinRoot: hex32Schema,
      verifiedTally: currentJournalTallySchema(),
      voteReceipt: voteReceiptSchema,
      receipt: receiptSchema.optional(),
      receiptPublication: receiptPublicationSchema.extend({ timestamp: timestampMsSchema.optional() }).optional(),
      imageId: hex32Schema,
      userVote: publicObject({
        commitment: hex32Schema,
        voteId: s.string().min(1),
        proof: inclusionProofSchema,
      }),
      missingSlots: currentJournalUint32Schema(),
      invalidPresentedSlots: currentJournalUint32Schema(),
      rejectedRecords: currentJournalUint32Schema(),
      totalExpected: currentJournalUint32Schema(),
      treeSize: currentJournalPositiveUint32Schema(),
      excludedSlots: currentJournalUint32Schema(),
      sthDigest: hex32Schema,
      seenBitmapRoot: hex32Schema.optional(),
      includedBitmapRoot: hex32Schema,
      inputCommitment: hex32Schema,
      seenIndicesCount: currentJournalUint32Schema(),
      journal: currentZkvmJournalSchema,
      verificationStatus: verificationStatusSchema,
      verificationReport: publicVerificationReportSchema.optional(),
      verificationExecutionId: verificationExecutionIdSchema.optional(),
      tamperSummary: tamperSummarySchema.optional(),
    }),
  ),
);

export const SessionStatusResponseSchema: Schema<SessionStatusResponsePayload> = s.typed(
  publicObject({
    sessionId: s.string().min(1),
    finalizationState: publicFinalizeStateSchema.nullable(),
    artifactState: currentArtifactStateSchema.optional(),
    queue: finalizeQueueSchema.optional().nullable(),
    progress: s
      .object({
        phase: s.string().min(1),
        source: s.string().min(1),
        percent: s.number().int().nonnegative(),
        updatedAt: timestampMsSchema,
      })
      .strict()
      .optional(),
    finalizationResult: sessionStatusFinalizationResultSchema.nullable(),
    stepFunctions: stepFunctionsDetailsSchema,
    asyncFinalizationMode: s.enum(['enabled', 'disabled']),
  }),
);

const verifyDataBaseShape = {
  electionId: s.string().min(1),
  electionConfigHash: hex32Schema,
  logId: s.string().min(1),
  tally: tallySchema,
  bulletinRoot: hex32Schema,
  scenarioId: scenarioIdSchema,
  verificationStatus: verificationStatusSchema,
  verificationReport: publicVerificationReportSchema.optional(),
  verificationSteps: s.array(verificationStepSchema).optional(),
  verificationChecks: s.array(verificationCheckSchema).optional(),
  imageId: hex32Schema,
  tamperDetected: s.boolean().optional(),
  verifiedTally: currentJournalTallySchema(),
  missingSlots: currentJournalUint32Schema(),
  invalidPresentedSlots: currentJournalUint32Schema(),
  rejectedRecords: currentJournalUint32Schema(),
  totalExpected: currentJournalUint32Schema(),
  treeSize: currentJournalPositiveUint32Schema(),
  excludedSlots: currentJournalUint32Schema(),
  sthDigest: hex32Schema,
  seenBitmapRoot: hex32Schema.optional(),
  includedBitmapRoot: hex32Schema,
  inputCommitment: hex32Schema,
  seenIndicesCount: currentJournalUint32Schema(),
  voteReceipt: voteReceiptSchema.optional(),
  userVote: publicObject({
    commitment: hex32Schema,
    voteId: s.string().min(1).optional(),
    proof: inclusionProofSchema.optional(),
  }).optional(),
  botVotesSummary: botVotesSummarySchema.optional(),
  verificationExecutionId: verificationExecutionIdSchema.optional(),
  tamperSummary: tamperSummarySchema.optional(),
};

export const VerifyResponseSchema: Schema<VerifyResponsePayload> = s.typed(
  apiResponseSchema(
    s.union([
      publicObject({
        ...verifyDataBaseShape,
        journalStatus: s.literal('available'),
        journal: currentZkvmJournalSchema,
      }),
      publicObject({
        ...verifyDataBaseShape,
        journalStatus: s.enum(['omitted', 'unavailable']),
        journal: s.undefined().optional(),
      }),
    ]),
  ),
);

export const VerifyFailClosedResponseSchema: Schema<VerifyFailClosedResponse> = s.typed(
  publicObject({
    error: s.enum(['UNSUPPORTED_CURRENT_ARTIFACT', 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE']),
    message: s.string().min(1),
    artifactState: failClosedArtifactStateSchema,
  }),
);

export const VerificationRunResponseSchema: Schema<VerificationRunResponsePayload> = s.typed(
  apiResponseSchema(
    publicObject({
      verificationStatus: verificationStatusSchema,
      verificationExecutionId: verificationExecutionIdSchema,
      estimatedDurationMs: s.number().int().nonnegative(),
      idempotent: s.boolean(),
    }),
  ),
);

export const FinalizeCallbackResponseSchema: Schema<FinalizeCallbackResponsePayload> = s.typed(
  s
    .object({
      sessionId: sessionIdParamSchema,
      state: internalFinalizeStateSchema,
    })
    .strict(),
);

export const FinalizeCancelResponseSchema = finalizeCancelResponseSchema;
export const BulletinResponseSchema = bulletinResponseSchema;
export const BulletinProofResponseSchema = bulletinProofResponseSchema;
export const ConsistencyProofResponseSchema = consistencyProofResponseSchema;
export const BitmapProofResponseSchema = bitmapProofResponseSchema;
export const SthResponseSchema = sthResponseSchema;
export const ZkVMInputHashResponseSchema = zkvmInputHashResponseSchema;

export type SessionResponse = Infer<typeof SessionResponseSchema>;
export type VoteResponse = Infer<typeof VoteResponseSchema>;
export type ProgressResponse = Infer<typeof ProgressResponseSchema>;
export type FinalizeSyncResponse = Infer<typeof FinalizeSyncResponseSchema>;
export type SessionStatusResponse = Infer<typeof SessionStatusResponseSchema>;
export type VerifyResponse = Infer<typeof VerifyResponseSchema>;
export type VerificationRunResponse = Infer<typeof VerificationRunResponseSchema>;
export type BulletinResponse = Infer<typeof BulletinResponseSchema>;
export type BulletinProofResponse = Infer<typeof BulletinProofResponseSchema>;
export type ConsistencyProofResponse = Infer<typeof ConsistencyProofResponseSchema>;
export type BitmapProofResponse = Infer<typeof BitmapProofResponseSchema>;
export type SthResponse = Infer<typeof SthResponseSchema>;
export type ZkVMInputHashResponse = Infer<typeof ZkVMInputHashResponseSchema>;

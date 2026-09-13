import { hasCoherentPublicScenarioTamperCoreProjection } from '@stark-ballot/verification/scenario-projection';
import { resolveRecordedInclusionProof } from '@stark-ballot/verification/check-evaluator';
import { resolveFailClosedVerificationStatus } from '@stark-ballot/verification/fail-closed-status';
import { hasConsistentPublicAuditArtifactsWithJournal } from '@stark-ballot/verification/public-audit-artifact-consistency';
import {
  closeStatementArtifactSchema,
  electionManifestArtifactSchema,
} from '@stark-ballot/verification/public-audit-artifacts';
import {
  hasCoherentAvailableVoterEvidence,
  hasCoherentVerificationReportExpectedImageId,
} from '@stark-ballot/verification/presentation-policy';
import {
  publicVerificationDevModeReportSchema,
  publicVerificationFailedReportSchema,
  publicVerificationSuccessReportSchema,
} from '@stark-ballot/verification/public-result';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { s, type Infer } from '@stark-ballot/validation/schema';
import { documentOpenApiRefinement } from '@stark-ballot/validation/schema-openapi';
import { normalizeHexString } from '@stark-ballot/zkvm-contract/zkvm/hex';
import {
  apiResponseSchema,
  durationMsSchema,
  finalizationIdSchema,
  hex32Schema,
  publicObject,
  scenarioIdSchema,
  sessionIdSchema,
  tallyWithRequiredTamperedCountSchema,
  timestampMsSchema,
  turnstileTokenFields,
} from './primitives';
import { currentZkvmJournalSchema, publicProofSummaryBaseShape, receiptSchema } from './verification';
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

function hasSameNormalizedHex(left: string, right: string): boolean {
  return normalizeHexString(left) === normalizeHexString(right);
}

export const finalizationAuthoritySchema = publicObject({
  imageId: publicProofSummaryBaseShape.imageId,
  journal: currentZkvmJournalSchema,
  receipt: receiptSchema.optional(),
  electionManifest: electionManifestArtifactSchema.optional(),
  closeStatement: closeStatementArtifactSchema.optional(),
}).superRefine((authority, context) => {
  if ((authority.electionManifest === undefined) !== (authority.closeStatement === undefined)) {
    context.addIssue({ message: 'Finalization public audit artifacts must be present together' });
  }

  if (authority.journal.imageId !== undefined && !hasSameNormalizedHex(authority.imageId, authority.journal.imageId)) {
    context.addIssue({ message: 'Finalization authority ImageID contradicts its journal' });
  }

  if (authority.receipt !== undefined && !hasSameNormalizedHex(authority.imageId, authority.receipt.imageId)) {
    context.addIssue({ message: 'Finalization authority ImageID contradicts its receipt' });
  }

  if (
    !hasConsistentPublicAuditArtifactsWithJournal({
      journal: omitUndefinedProperties(authority.journal),
      electionManifest: authority.electionManifest,
      closeStatement: authority.closeStatement,
    })
  ) {
    context.addIssue({ message: 'Finalization public audit artifacts contradict journal authority' });
  }
});
documentOpenApiRefinement(
  finalizationAuthoritySchema,
  'Audit artifacts are paired and all present ImageIDs and public artifacts agree with journal authority.',
);

const finalizationScenariosSchema = s
  .array(scenarioIdSchema)
  .refine((scenarios) => scenarios.length === 0 || (scenarios.length === 1 && scenarios[0] !== 'S0'), {
    message: 'Expected [] for S0 or one S1-S5 scenario',
  });
documentOpenApiRefinement(
  finalizationScenariosSchema,
  'The list is empty for S0 or contains exactly one of S1 through S5.',
  { maxItems: 1 },
);

const finalizationPresentationBaseShape = {
  tally: tallyWithRequiredTamperedCountSchema,
  verifiedTally: publicProofSummaryBaseShape.verifiedTally,
  tamperDetected: s.boolean(),
  scenarios: finalizationScenariosSchema,
  tamperSummary: publicProofSummaryBaseShape.tamperSummary,
  bulletinRoot: publicProofSummaryBaseShape.bulletinRoot,
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
  bitmapProofSource: s.enum(['mock', 'real']).optional(),
} as const;

export const finalizationPresentationSchema = s.union([
  publicObject({
    ...finalizationPresentationBaseShape,
    verificationStatus: s.enum(['not_run', 'running'] as const),
    verificationReport: s.undefined().optional(),
  }),
  publicObject({
    ...finalizationPresentationBaseShape,
    verificationStatus: s.literal('success'),
    verificationReport: publicVerificationSuccessReportSchema.optional(),
  }),
  publicObject({
    ...finalizationPresentationBaseShape,
    verificationStatus: s.literal('dev_mode'),
    verificationReport: publicVerificationDevModeReportSchema.optional(),
  }),
  publicObject({
    ...finalizationPresentationBaseShape,
    verificationStatus: s.literal('failed'),
    verificationReport: publicVerificationFailedReportSchema.optional(),
  }),
]);

type FinalizationJournalPresentationSharedField = keyof Infer<typeof currentZkvmJournalSchema> &
  keyof Infer<typeof finalizationPresentationSchema>;

const FINALIZATION_JOURNAL_PRESENTATION_SHARED_FIELDS = [
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
] as const satisfies readonly FinalizationJournalPresentationSharedField[];

type AssertNever<TValue extends never> = TValue;
type FinalizationJournalPresentationSharedFieldCoverage = AssertNever<
  Exclude<FinalizationJournalPresentationSharedField, (typeof FINALIZATION_JOURNAL_PRESENTATION_SHARED_FIELDS)[number]>
>;

function hasCoherentFinalizationJournalPresentation(
  journal: Infer<typeof currentZkvmJournalSchema>,
  presentation: Infer<typeof finalizationPresentationSchema>,
  ..._coverage: [FinalizationJournalPresentationSharedFieldCoverage] extends [never] ? [] : [never]
): boolean {
  void _coverage;
  return FINALIZATION_JOURNAL_PRESENTATION_SHARED_FIELDS.every((field) => {
    const journalValue = journal[field];
    const presentationValue = presentation[field];
    switch (field) {
      case 'bulletinRoot':
      case 'sthDigest':
      case 'seenBitmapRoot':
      case 'includedBitmapRoot':
      case 'inputCommitment':
        return (
          typeof journalValue === 'string' &&
          typeof presentationValue === 'string' &&
          hasSameNormalizedHex(journalValue, presentationValue)
        );
      case 'verifiedTally':
        return (
          Array.isArray(journalValue) &&
          Array.isArray(presentationValue) &&
          journalValue.every((value, index) => value === presentationValue[index])
        );
      case 'missingSlots':
      case 'invalidPresentedSlots':
      case 'rejectedRecords':
      case 'totalExpected':
      case 'treeSize':
      case 'excludedSlots':
      case 'seenIndicesCount':
        return journalValue === presentationValue;
    }
  });
}

const finalizationUserVoteSchema = publicObject({
  commitment: hex32Schema,
  voteId: s.string().min(1),
  proof: inclusionProofSchema,
});

const finalizationVoteReceiptSchema = voteReceiptSchema.extend({
  inputCommitment: hex32Schema,
});

export const finalizationVoterEvidenceSchema = s.union([
  publicObject({
    state: s.literal('available'),
    voteReceipt: finalizationVoteReceiptSchema,
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

function hasCoherentFinalizationReportImageIds(
  authority: Infer<typeof finalizationAuthoritySchema>,
  presentation: Infer<typeof finalizationPresentationSchema>,
): boolean {
  const report = presentation.verificationReport;
  if (!hasCoherentVerificationReportExpectedImageId(report, authority.imageId)) {
    return false;
  }
  if (report === undefined || report.status === 'failed') {
    return true;
  }
  return report.receipt_image_id !== null && hasSameNormalizedHex(report.receipt_image_id, authority.imageId);
}

function hasCoherentFinalizationVoterEvidence(
  voterEvidence: Infer<typeof finalizationVoterEvidenceSchema>,
  journal: Infer<typeof currentZkvmJournalSchema>,
): boolean {
  if (voterEvidence.state === 'verification-gated') {
    return true;
  }

  const verificationVoteReceipt = {
    voteId: voterEvidence.voteReceipt.voteId,
    commitment: voterEvidence.voteReceipt.commitment,
    bulletinIndex: voterEvidence.voteReceipt.bulletinIndex,
    bulletinRootAtCast: voterEvidence.voteReceipt.bulletinRootAtCast,
    inputCommitment: voterEvidence.voteReceipt.inputCommitment,
    timestamp: voterEvidence.voteReceipt.castAtMs,
  };
  return (
    hasCoherentAvailableVoterEvidence({
      voterEvidence: {
        availability: 'available',
        voteReceipt: voterEvidence.voteReceipt,
        userVote: voterEvidence.userVote,
      },
      proofAuthority: journal,
    }) &&
    resolveRecordedInclusionProof({
      voteReceipt: verificationVoteReceipt,
      userVote: {
        voteId: voterEvidence.userVote.voteId,
        commitment: voterEvidence.userVote.commitment,
        proof: {
          ...voterEvidence.userVote.proof,
          merklePath: [...voterEvidence.userVote.proof.merklePath],
        },
      },
    }).status === 'success'
  );
}

function hasCoherentFinalizationScenarioPresentation(
  presentation: Infer<typeof finalizationPresentationSchema>,
  journal: Infer<typeof currentZkvmJournalSchema>,
): boolean {
  return hasCoherentPublicScenarioTamperCoreProjection({
    scenarioId: presentation.scenarios[0] ?? 'S0',
    tamperDetected: presentation.tamperDetected,
    tamperedCount: presentation.tally.tamperedCount,
    proof: {
      excludedSlots: journal.excludedSlots,
      rejectedRecords: journal.rejectedRecords,
      verifiedTally: journal.verifiedTally,
    },
    counts: presentation.tally.counts,
    ...(presentation.tamperSummary === undefined ? {} : { tamperSummary: presentation.tamperSummary }),
  });
}

function hasFailClosedFinalizationVerificationStatus(
  authority: Infer<typeof finalizationAuthoritySchema>,
  presentation: Infer<typeof finalizationPresentationSchema>,
): boolean {
  return (
    resolveFailClosedVerificationStatus({
      currentStatus: presentation.verificationStatus,
      journal: omitUndefinedProperties(authority.journal),
      claimedImageId: authority.imageId,
      ...(authority.journal.imageId === undefined ? {} : { comparisonImageId: authority.journal.imageId }),
      ...(presentation.verificationReport === undefined ? {} : { verificationReport: presentation.verificationReport }),
    }) === presentation.verificationStatus
  );
}

export const finalizationResultSchema = publicObject({
  authority: finalizationAuthoritySchema,
  presentation: finalizationPresentationSchema,
  voterEvidence: finalizationVoterEvidenceSchema,
  artifactAvailability: finalizationArtifactAvailabilitySchema,
}).superRefine((result, context) => {
  if (!hasCoherentFinalizationJournalPresentation(result.authority.journal, result.presentation)) {
    context.addIssue({ message: 'Finalization presentation contradicts its journal authority' });
  }

  if (!hasCoherentFinalizationReportImageIds(result.authority, result.presentation)) {
    context.addIssue({ message: 'Finalization verifier report ImageID contradicts authority' });
  }

  if (!hasCoherentFinalizationVoterEvidence(result.voterEvidence, result.authority.journal)) {
    context.addIssue({ message: 'Finalization voter evidence contradicts journal authority' });
  }

  if (!hasCoherentFinalizationScenarioPresentation(result.presentation, result.authority.journal)) {
    context.addIssue({ message: 'Finalization scenario presentation contains contradictory tamper facts' });
  }

  if (!hasFailClosedFinalizationVerificationStatus(result.authority, result.presentation)) {
    context.addIssue({ message: 'Finalization verification status is not fail closed' });
  }

  const hasReport = result.presentation.verificationReport !== undefined;
  const reportAvailable = result.artifactAvailability.report === 'available';
  const hasOmittedFailedReportArtifact =
    result.presentation.verificationStatus === 'failed' && !hasReport && reportAvailable;
  if (hasReport !== reportAvailable && !hasOmittedFailedReportArtifact) {
    context.addIssue({ message: 'Finalization report availability contradicts report presence' });
  }

  if (
    result.artifactAvailability.seenBitmap === 'available' &&
    result.artifactAvailability.includedBitmap !== 'available'
  ) {
    context.addIssue({ message: 'Seen bitmap availability requires included bitmap availability' });
  }
});
documentOpenApiRefinement(
  finalizationResultSchema,
  'Authority, presentation, voter evidence, verifier report, tamper scenario, and artifact availability are mutually coherent and fail closed.',
);

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

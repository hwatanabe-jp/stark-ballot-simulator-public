import type {
  FinalizationPublicAuditArtifactsState,
  FinalizationResultAuthority,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import { createUnavailableFinalizationArtifacts } from '@stark-ballot/application/finalize/finalization-types';
import type { ZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { CloseStatement, ElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { isSupportedZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import { VOTE_CHOICES } from '@stark-ballot/domain/shared/constants';
import { toPublicZkvmJournal } from '@stark-ballot/zkvm-contract/zkvm/public-journal';
import {
  resolveFinalizationTamperDetected,
  resolveScenarioTamperCount,
} from '@stark-ballot/verification/finalization-tamper';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import {
  resolveConsistentPublicAuditArtifacts as resolveVerificationPublicAuditArtifacts,
  type PublicAuditArtifactConsistencyIssue,
} from '@stark-ballot/verification/public-audit-artifact-consistency';
import { admitFinalizationResultAuthority } from '@stark-ballot/application/finalize/finalization-storage';

export type { PublicAuditArtifactConsistencyIssue };

interface PublicAuditArtifactResolution {
  publicInputArtifact?: Extract<
    FinalizationPublicAuditArtifactsState,
    { availability: 'available' }
  >['publicInputArtifact'];
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  issues: PublicAuditArtifactConsistencyIssue[];
}

function buildCountsRecord(verifiedTally: number[]): Record<(typeof VOTE_CHOICES)[number], number> {
  const record = {} as Record<(typeof VOTE_CHOICES)[number], number>;
  for (const [index, choice] of VOTE_CHOICES.entries()) {
    const value = verifiedTally[index];
    record[choice] = Number.isFinite(value) ? (value ?? 0) : 0;
  }
  return record;
}

function resolveUsableTally(
  tally: FinalizationResultAuthority['tally'] | undefined,
  fallback: FinalizationResultAuthority['tally'],
): FinalizationResultAuthority['tally'] {
  // Keep a structurally valid claimed tally for presentation flows like S2/S4,
  // while fail-closed verification still compares it against the canonical journal.
  if (!tally || typeof tally !== 'object') {
    return fallback;
  }

  const counts = (tally as { counts?: Partial<Record<(typeof VOTE_CHOICES)[number], unknown>> }).counts;
  if (!counts || typeof counts !== 'object') {
    return fallback;
  }

  for (const choice of VOTE_CHOICES) {
    const value = counts[choice];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback;
    }
  }

  if (typeof tally.totalVotes !== 'number' || !Number.isFinite(tally.totalVotes)) {
    return fallback;
  }
  if (typeof tally.tamperedCount !== 'number' || !Number.isFinite(tally.tamperedCount)) {
    return fallback;
  }

  return tally;
}

function buildTamperSummary(
  scenarioContext?: FinalizationScenarioContext | null,
): FinalizationResultAuthority['tamperSummary'] {
  if (!scenarioContext) {
    return undefined;
  }

  const ignoredVotes = scenarioContext.summary.ignoredCount;
  const recountedVotes = scenarioContext.summary.recountedCount;
  if (ignoredVotes <= 0 && recountedVotes <= 0) {
    return undefined;
  }

  return {
    ignoredVotes,
    recountedVotes,
    userRecountedTo: scenarioContext.summary.userRecountChoice,
    ...(scenarioContext.summary.affectedBotIds ? { affectedBotIds: scenarioContext.summary.affectedBotIds } : {}),
  };
}

function applyScenarioContext(
  result: FinalizationResultAuthority,
  scenarioContext?: FinalizationScenarioContext | null,
): FinalizationResultAuthority {
  if (!scenarioContext) {
    return result;
  }

  const scenarioTamperCount = resolveScenarioTamperCount({
    ignoredVotes: scenarioContext.summary.ignoredCount,
    recountedVotes: scenarioContext.summary.recountedCount,
  });
  const excludedSlots = result.journal.excludedSlots;
  const rejectedRecords = result.journal.rejectedRecords;
  const tamperDetected = resolveFinalizationTamperDetected({
    excludedSlots,
    rejectedRecords,
    scenarioTamperCount,
  });

  return {
    ...result,
    tally: {
      ...result.tally,
      counts: scenarioContext.claimedCounts,
      totalVotes: scenarioContext.claimedTotalVotes,
      tamperedCount: Math.max(excludedSlots, scenarioTamperCount),
    },
    tamperDetected,
    scenarios: scenarioContext.scenarios,
    ...omitUndefinedProperties({ tamperSummary: buildTamperSummary(scenarioContext) }),
  };
}

export function buildFinalizationResultFromJournal(options: {
  journal: ZkVMJournal;
  imageId?: string;
  scenarioContext?: FinalizationScenarioContext | null;
  publicAuditArtifacts?: Extract<FinalizationPublicAuditArtifactsState, { availability: 'available' }>;
}): FinalizationResultAuthority {
  const { scenarioContext } = options;
  const journal = toPublicZkvmJournal(options.journal);
  const verifiedTally = journal.verifiedTally;
  const excludedSlots = journal.excludedSlots;
  const totalVotes = journal.totalExpected;
  const tamperDetected = resolveFinalizationTamperDetected({
    excludedSlots,
    rejectedRecords: journal.rejectedRecords,
  });
  const imageId = options.imageId ?? '';

  const baseResult: FinalizationResultAuthority = omitUndefinedProperties({
    tally: {
      counts: buildCountsRecord(verifiedTally),
      totalVotes,
      tamperedCount: excludedSlots,
    },
    imageId,
    tamperDetected,
    scenarios: [],
    journal,
    artifacts: {
      ...createUnavailableFinalizationArtifacts(),
      ...(options.publicAuditArtifacts ? { publicAudit: options.publicAuditArtifacts } : {}),
    },
  });

  return applyScenarioContext(baseResult, scenarioContext);
}

export function canonicalizeFinalizationResult(
  result: unknown,
  scenarioContext?: FinalizationScenarioContext | null,
): FinalizationResultAuthority | undefined {
  const candidate = admitFinalizationResultAuthority(result);
  if (!candidate || !isSupportedZkVMJournal(candidate.journal)) {
    return undefined;
  }

  const journal = toPublicZkvmJournal(candidate.journal);
  const storedPublicAudit = candidate.artifacts.publicAudit;
  const artifactResolution = resolveConsistentPublicAuditArtifacts(
    omitUndefinedProperties({
      journal,
      publicInputArtifact:
        storedPublicAudit.availability === 'available' ? storedPublicAudit.publicInputArtifact : undefined,
      electionManifest: storedPublicAudit.availability === 'available' ? storedPublicAudit.electionManifest : undefined,
      closeStatement: storedPublicAudit.availability === 'available' ? storedPublicAudit.closeStatement : undefined,
      hasLocalPublicInputAuthority: true,
    }),
  );
  if (artifactResolution.issues.length > 0) {
    return undefined;
  }
  const { publicInputArtifact, electionManifest, closeStatement } = artifactResolution;

  const derived = buildFinalizationResultFromJournal(
    omitUndefinedProperties({
      journal,
      imageId: candidate.imageId,
      scenarioContext,
      publicAuditArtifacts:
        publicInputArtifact && electionManifest && closeStatement
          ? {
              availability: 'available' as const,
              publicInputArtifact,
              electionManifest,
              closeStatement,
            }
          : undefined,
    }),
  );
  const storedScenarioTamperCount = resolveScenarioTamperCount(candidate.tamperSummary);

  const canonical: FinalizationResultAuthority = omitUndefinedProperties({
    tally: resolveUsableTally(candidate.tally, derived.tally),
    imageId: candidate.imageId,
    tamperDetected:
      Boolean(candidate.tamperDetected) ||
      resolveFinalizationTamperDetected({
        excludedSlots: derived.journal.excludedSlots,
        rejectedRecords: derived.journal.rejectedRecords,
        scenarioTamperCount: storedScenarioTamperCount,
      }),
    scenarios: candidate.scenarios,
    journal,
    artifacts: {
      publicAudit: derived.artifacts.publicAudit,
      receipt: candidate.artifacts.receipt,
      receiptPublication: candidate.artifacts.receiptPublication,
      bitmap: candidate.artifacts.bitmap,
    },
    ...omitUndefinedProperties({ tamperSummary: candidate.tamperSummary }),
  });

  return scenarioContext ? applyScenarioContext(canonical, scenarioContext) : canonical;
}

export function hydrateFinalizationResultFromJournal(
  result: unknown,
  scenarioContext?: FinalizationScenarioContext | null,
): FinalizationResultAuthority | undefined {
  return canonicalizeFinalizationResult(result, scenarioContext);
}

export function hasConsistentPublicAuditArtifacts(
  result: Pick<FinalizationResultAuthority, 'journal' | 'artifacts'> | undefined,
): boolean {
  if (!result || !isSupportedZkVMJournal(result.journal)) {
    return false;
  }

  const journal = toPublicZkvmJournal(result.journal);
  const publicAudit = result.artifacts.publicAudit;
  if (publicAudit.availability !== 'available') {
    return false;
  }
  const artifactResolution = resolveConsistentPublicAuditArtifacts(
    omitUndefinedProperties({
      journal,
      publicInputArtifact: publicAudit.publicInputArtifact,
      electionManifest: publicAudit.electionManifest,
      closeStatement: publicAudit.closeStatement,
      hasLocalPublicInputAuthority: true,
    }),
  );

  return Boolean(
    artifactResolution.issues.length === 0 &&
    artifactResolution.publicInputArtifact &&
    artifactResolution.electionManifest &&
    artifactResolution.closeStatement,
  );
}

export function resolveConsistentPublicAuditArtifacts(input: {
  journal: ZkVMJournal;
  publicInputArtifact?: Extract<
    FinalizationPublicAuditArtifactsState,
    { availability: 'available' }
  >['publicInputArtifact'];
  electionManifest?: ElectionManifest;
  closeStatement?: CloseStatement;
  hasLocalPublicInputAuthority?: boolean;
}): PublicAuditArtifactResolution {
  return resolveVerificationPublicAuditArtifacts(
    omitUndefinedProperties({
      journal: input.journal,
      publicInputArtifact: input.publicInputArtifact,
      electionManifest: input.electionManifest,
      closeStatement: input.closeStatement,
      hasLocalPublicInputAuthority: Boolean(input.hasLocalPublicInputAuthority),
    }),
  );
}

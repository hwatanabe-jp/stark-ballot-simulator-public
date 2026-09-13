import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import type { SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult, ZkVMExecutor } from '@stark-ballot/application/finalize/zkvm-executor';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ProofBundleService } from '@stark-ballot/application/finalize/proof-bundle-service';
import { ApplicationErrorCode } from '@stark-ballot/application';
import {
  createUnavailableFinalizationArtifacts,
  type FinalizationBitmapDisposition,
  type FinalizationId,
  type FinalizationResultAuthority,
  type FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import type { VerificationResultStore } from '@stark-ballot/application/finalize/finalization-result-store';
import type { FinalizationRecord } from '@stark-ballot/application/finalize/finalization-record';
import { normalizeExecutionReceipt } from '@stark-ballot/verification/receipt-normalizer';
import { buildSupportedPublicInputArtifactFromZkvmInput } from '@stark-ballot/verification/public-input';
import { normalizeBitmapRoot } from '@stark-ballot/verification/bitmap-root';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { isSupportedZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import { toPublicZkvmJournal } from '@stark-ballot/zkvm-contract/zkvm/public-journal';
import { getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import { normalizeHexString } from '@stark-ballot/crypto-primitives';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import {
  resolveFinalizationTamperDetected,
  resolveScenarioTamperCount,
} from '@stark-ballot/verification/finalization-tamper';
import { buildUserVoteArtifacts, UserVoteArtifactsUnavailableError } from './user-vote-artifacts';
import type { FinalizeScenarioContext, FinalizeSessionError, FinalizeSyncPayload, Result } from './types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import type { SessionId } from '@stark-ballot/domain/types/identifiers';

export interface FinalizeSyncInput {
  sessionId: SessionId;
  finalizationId: FinalizationId;
  queuedAtMs: number;
  voting: SessionVotingRecord;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  expectedImageId: string;
  scenario: FinalizeScenarioContext;
  allowDevMode: boolean;
  debugFinalize: boolean;
  debugFileStore?: boolean;
  executorModeLabel?: string;
  bitmapProofSource?: 'mock' | 'real';
}

export interface FinalizeSyncDependencies {
  store: VoteStore & FinalizationStore & VerificationResultStore;
  getExecutor: () => Promise<ZkVMExecutor>;
  proofBundleService: ProofBundleService;
  now?: () => number;
}

function toFinalizationScenarioContext(scenario: FinalizeScenarioContext): FinalizationScenarioContext {
  return {
    scenarios: scenario.scenariosApplied,
    tamperMode: scenario.tamperMode,
    claimedCounts: scenario.claimedCounts,
    claimedTotalVotes: scenario.claimedTotalVotes,
    summary: {
      ignoredCount: scenario.summary.ignoredCount,
      recountedCount: scenario.summary.recountedCount,
      userRecountChoice: scenario.summary.userRecountChoice,
      ...(scenario.affectedBotIds ? { affectedBotIds: scenario.affectedBotIds } : {}),
    },
  };
}

export async function finalizeSync(
  input: FinalizeSyncInput,
  deps: FinalizeSyncDependencies,
): Promise<Result<FinalizeSyncPayload, FinalizeSessionError>> {
  const startedAtMs = (deps.now ?? Date.now)();
  try {
    const executor = await deps.getExecutor();
    logger.info(`[API] Using ${executor.type} zkVM executor`);
    logger.info(input.executorModeLabel ?? '[API] zkVM executor mode supplied by runtime adapter');

    const zkVMResult = await executor.execute(input.zkvmInput);
    const executionReceipt = zkVMResult.receipt;

    if (input.debugFinalize) {
      logger.debug('[DEBUG] zkVMResult after execution:', {
        verifiedTally: zkVMResult.verifiedTally,
        missingSlots: zkVMResult.missingSlots,
        invalidPresentedSlots: zkVMResult.invalidPresentedSlots,
        rejectedRecords: zkVMResult.rejectedRecords,
        validVotes: zkVMResult.validVotes,
        excludedSlots: zkVMResult.excludedSlots,
        totalExpected: zkVMResult.totalExpected,
        treeSize: zkVMResult.treeSize,
      });
    }

    const scenarioTamperCount = resolveScenarioTamperCount({
      ignoredVotes: input.scenario.summary.ignoredCount,
      recountedVotes: input.scenario.summary.recountedCount,
    });
    const reportedMethodVersion =
      typeof (zkVMResult as { methodVersion?: unknown }).methodVersion === 'number'
        ? (zkVMResult as { methodVersion: number }).methodVersion
        : undefined;
    const publicJournal = admitCurrentExecutionJournal(zkVMResult);
    if (!publicJournal) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.INTERNAL_ERROR,
          details: {
            details: `Unsupported zkVM journal contract (methodVersion=${String(reportedMethodVersion ?? 'unknown')})`,
          },
        },
      };
    }

    const actualImageId = zkVMResult.imageId ?? getStringProperty(zkVMResult, 'imageID');
    if (!actualImageId || actualImageId !== input.expectedImageId) {
      return {
        ok: false,
        error: {
          kind: 'invalid_image_id',
          expected: input.expectedImageId,
          actual: actualImageId ?? null,
        },
      };
    }

    const normalizedReceipt = normalizeExecutionReceipt(executionReceipt, actualImageId);
    const electionManifest = buildElectionManifest(input.zkvmInput.electionId, input.electionConfig);
    const excludedSlots = zkVMResult.excludedSlots;
    const effectiveTamperedCount = Math.max(excludedSlots, scenarioTamperCount);
    const artifactSourceResult: FinalizationResultAuthority = {
      tally: {
        counts: input.scenario.claimedCounts,
        totalVotes: input.scenario.claimedTotalVotes,
        tamperedCount: effectiveTamperedCount,
      },
      imageId: actualImageId || 'zkvm-image-v' + zkVMResult.methodVersion,
      journal: publicJournal,
      artifacts: createUnavailableFinalizationArtifacts(),
    };

    let userVoteArtifacts;
    try {
      userVoteArtifacts = buildUserVoteArtifacts({
        voting: input.voting,
        finalizationResult: artifactSourceResult,
      });
    } catch (error) {
      if (!(error instanceof UserVoteArtifactsUnavailableError)) {
        logger.error('[API] Failed to build exact user vote artifacts', error);
        return {
          ok: false,
          error: {
            kind: 'api',
            code: ApplicationErrorCode.INTERNAL_ERROR,
            details: {
              details: 'Failed to build exact user vote artifacts',
            },
          },
        };
      }

      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.VERIFICATION_FAILED,
          details: {
            details: error.message,
          },
        },
      };
    }

    const proofBundleOutcome = await deps.proofBundleService.createBundle({
      sessionId: input.sessionId,
      finalizationId: input.finalizationId,
      zkvmInput: input.zkvmInput,
      electionConfig: input.electionConfig,
      electionManifest,
      zkvmResult: zkVMResult,
      normalizedReceipt,
      expectedImageId: actualImageId,
      allowDevMode: input.allowDevMode,
      verificationMode: executor.type === 'mock' ? 'mock' : 'verify',
    });

    if (!proofBundleOutcome.ok) {
      if (proofBundleOutcome.error.type === 'verifier_failed') {
        const verifierFailure = proofBundleOutcome.error;
        const details =
          verifierFailure.status === 'failed'
            ? {
                status: 'failed' as const,
                finalizationId: verifierFailure.finalizationId,
                verificationReport: verifierFailure.report,
              }
            : {
                status: 'dev_mode' as const,
                finalizationId: verifierFailure.finalizationId,
                verificationReport: verifierFailure.report,
              };
        return {
          ok: false,
          error: {
            kind: 'api',
            code: ApplicationErrorCode.VERIFICATION_FAILED,
            details,
          },
        };
      }

      logger.error('[API] proof bundle creation failed', proofBundleOutcome.error.error);
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.INTERNAL_ERROR,
          details: { details: 'Proof bundle creation failed' },
        },
      };
    }

    const { finalizationId, verificationResult } = proofBundleOutcome;
    if (finalizationId !== input.finalizationId) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.INVALID_FINALIZATION_ARTIFACT,
          details: {
            details: 'Proof bundle finalization authority does not match the requested finalization',
          },
        },
      };
    }

    const publicInputArtifact = buildSupportedPublicInputArtifactFromZkvmInput(
      input.zkvmInput,
      zkVMResult.methodVersion,
      {
        finalizationId,
      },
    );
    const closeStatement = buildCloseStatement({
      logId: input.zkvmInput.logId,
      treeSize: zkVMResult.treeSize,
      timestamp: input.zkvmInput.timestamp,
      bulletinRoot: zkVMResult.bulletinRoot,
    });

    const bitmap = buildBitmapData({
      zkvmResult: zkVMResult,
      bitmapProofSource: input.bitmapProofSource ?? executor.type,
    });

    let finalizationResult: FinalizationResultAuthority = {
      tally: {
        counts: input.scenario.claimedCounts,
        totalVotes: input.scenario.claimedTotalVotes,
        tamperedCount: effectiveTamperedCount,
      },
      imageId: actualImageId || 'zkvm-image-v' + zkVMResult.methodVersion,
      tamperDetected: resolveFinalizationTamperDetected({
        excludedSlots: zkVMResult.excludedSlots,
        rejectedRecords: zkVMResult.rejectedRecords,
        scenarioTamperCount,
      }),
      journal: publicJournal,
      artifacts: {
        publicAudit: {
          availability: 'available',
          publicInputArtifact,
          electionManifest,
          closeStatement,
        },
        receipt: {
          availability: 'available',
          receipt: normalizedReceipt.receipt,
        },
        receiptPublication: { availability: 'unavailable' },
        bitmap:
          bitmap.disposition.availability === 'available' && bitmap.bitmapProofSource
            ? {
                availability: 'available',
                proofSource: bitmap.bitmapProofSource,
                data: bitmap.disposition.data,
              }
            : { availability: 'unavailable' },
      },
      scenarios: input.scenario.scenarios,
      ...omitUndefinedProperties({
        tamperSummary:
          input.scenario.scenarioResult &&
          (input.scenario.summary.ignoredCount > 0 || input.scenario.summary.recountedCount > 0)
            ? {
                ignoredVotes: input.scenario.summary.ignoredCount,
                recountedVotes: input.scenario.summary.recountedCount,
                userRecountedTo: input.scenario.summary.userRecountChoice,
                ...(input.scenario.affectedBotIds ? { affectedBotIds: input.scenario.affectedBotIds } : {}),
              }
            : undefined,
      }),
    };
    const receiptData = {
      receipt: JSON.stringify({
        methodVersion: zkVMResult.methodVersion,
        sthDigest: zkVMResult.sthDigest,
        verifiedTally: zkVMResult.verifiedTally,
        includedBitmapRoot: zkVMResult.includedBitmapRoot,
      }),
      timestamp: (deps.now ?? Date.now)(),
    };
    const completedAtMs = (deps.now ?? Date.now)();
    const succeededState = {
      status: 'succeeded' as const,
      finalizationId,
      queuedAtMs: input.queuedAtMs,
      startedAtMs,
      completedAtMs,
    };
    const finalizationRecord: Extract<FinalizationRecord, { state: { status: 'succeeded' } }> = {
      sessionId: input.sessionId,
      finalizationId,
      scenarioContext: toFinalizationScenarioContext(input.scenario),
      state: succeededState,
      finalizationResult: {
        finalizationId,
        ...finalizationResult,
      },
    };

    const debugEnabled = input.debugFileStore ?? false;
    if (debugEnabled || input.debugFinalize) {
      logger.debug('[API][finalize][DEBUG] Attempting to save finalizationResult', {
        session_id_hash: hashSessionIdForLogging(input.sessionId),
        hasFinalizationResult: !!finalizationResult,
        verifiedTally: finalizationResult.journal.verifiedTally,
        timestamp: new Date().toISOString(),
      });
    }

    const committed = await deps.store.commitSuccessfulFinalization({
      record: finalizationRecord,
      receipt: receiptData,
      bitmap: bitmap.disposition,
      verificationResult,
    });
    const { finalizationId: committedFinalizationId, ...committedAuthority } = committed.record.finalizationResult;
    if (committedFinalizationId !== finalizationId) {
      throw new Error('Committed finalization authority does not match the requested finalization');
    }
    finalizationResult = committedAuthority;
    if (committed.receiptPublication) {
      logger.info('[API] Receipt saved to board:', {
        receiptHash: committed.receiptPublication.receiptHash,
        boardIndex: committed.receiptPublication.boardIndex,
      });
    }

    if (debugEnabled || input.debugFinalize) {
      logger.debug('[API][finalize][DEBUG] commitSuccessfulFinalization() completed', {
        session_id_hash: hashSessionIdForLogging(input.sessionId),
        timestamp: new Date().toISOString(),
      });
    }

    if (committed.bitmap.availability === 'available') {
      logger.info('[API] Saved bitmap data for session', {
        session_id_hash: hashSessionIdForLogging(input.sessionId),
      });
    }
    const { bulletinRoot, inputCommitment, voteReceipt, userVoteProof } = userVoteArtifacts;

    if (input.debugFinalize) {
      logger.debug('[DEBUG] finalizationResult before API response:', {
        tally: finalizationResult.tally,
        verifiedTally: finalizationResult.journal.verifiedTally,
        missingSlots: finalizationResult.journal.missingSlots,
        invalidPresentedSlots: finalizationResult.journal.invalidPresentedSlots,
        validVotes: finalizationResult.journal.validVotes,
        excludedSlots: finalizationResult.journal.excludedSlots,
        totalExpected: finalizationResult.journal.totalExpected,
        treeSize: finalizationResult.journal.treeSize,
      });
    }

    const receiptJournal = normalizedReceipt.receipt.journal;
    if (typeof receiptJournal !== 'string') {
      throw new Error('Receipt journal is missing or invalid');
    }

    return {
      ok: true,
      value: {
        sessionId: input.sessionId,
        finalizationId,
        state: committed.record.state,
        finalizationResult,
        verificationResult,
        bitmapDisposition: committed.bitmap,
        bulletinRoot,
        voteReceipt,
        receipt: normalizedReceipt.receipt,
        receiptJournal,
        userVote: userVoteProof,
        inputCommitment,
      },
    };
  } catch (zkError) {
    logger.error('zkVM execution failed:', zkError);
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ApplicationErrorCode.INTERNAL_ERROR,
        details: { details: 'Proof generation failed' },
      },
    };
  }
}

function admitCurrentExecutionJournal(result: ZkVMExecutionResult): ReturnType<typeof toPublicZkvmJournal> | undefined {
  try {
    const journal = toPublicZkvmJournal(result);
    return isSupportedZkVMJournal(journal) ? journal : undefined;
  } catch {
    return undefined;
  }
}

function buildBitmapData(params: { zkvmResult: ZkVMExecutionResult; bitmapProofSource: 'mock' | 'real' }): {
  disposition: FinalizationBitmapDisposition;
  bitmapProofSource?: 'mock' | 'real';
} {
  const includedBitmap = params.zkvmResult.includedBitmap ? [...params.zkvmResult.includedBitmap] : null;
  if (!includedBitmap) {
    logger.info('[API] Exact included bitmap unavailable; bitmap proof disabled');
    return { disposition: { availability: 'unavailable' } };
  }

  const normalizedRoot = normalizeBitmapRoot(params.zkvmResult.includedBitmapRoot);
  const computedRoot = computeIncludedBitmapRoot(includedBitmap);
  if (normalizeHexString(computedRoot) === normalizeHexString(normalizedRoot)) {
    logger.info('[API] Using exact included bitmap from zkVM execution');
  } else {
    logger.warn('[API] Bitmap root mismatch; disabling bitmap proof', {
      expectedRoot: normalizedRoot,
      computedRoot,
    });
    return { disposition: { availability: 'unavailable' } };
  }

  const bitmapData = {
    includedBitmap,
    includedBitmapRoot: normalizeBitmapRoot(params.zkvmResult.includedBitmapRoot),
    ...buildSeenBitmapData(params.zkvmResult),
    treeSize: params.zkvmResult.treeSize,
    finalizedAtMs: Date.now(),
  };

  return {
    disposition: { availability: 'available', data: bitmapData },
    bitmapProofSource: params.bitmapProofSource,
  };
}

function buildSeenBitmapData(zkvmResult: ZkVMExecutionResult): { seenBitmap?: boolean[]; seenBitmapRoot?: string } {
  if (!zkvmResult.seenBitmap || !zkvmResult.seenBitmapRoot) {
    return {};
  }

  const normalizedSeenRoot = normalizeBitmapRoot(zkvmResult.seenBitmapRoot);
  const computedSeenRoot = computeIncludedBitmapRoot(zkvmResult.seenBitmap);
  if (normalizeHexString(computedSeenRoot) !== normalizeHexString(normalizedSeenRoot)) {
    logger.warn('[API] Seen bitmap root mismatch; omitting seen bitmap proof support', {
      expectedRoot: normalizedSeenRoot,
      computedRoot: computedSeenRoot,
    });
    return {};
  }

  logger.info('[API] Using exact seen bitmap from zkVM execution');
  return {
    seenBitmap: [...zkvmResult.seenBitmap],
    seenBitmapRoot: normalizedSeenRoot,
  };
}

import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import type { FinalizationBitmapStore, FinalizationStore } from '@stark-ballot/application/finalize/finalization-store';
import type { SessionData } from '@stark-ballot/domain/types/server';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult, ZkVMExecutor } from '@stark-ballot/application/finalize/zkvm-executor';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ProofBundleService } from '@stark-ballot/application/finalize/proof-bundle-service';
import {
  ApplicationErrorCode,
  type FinalizationBitmapData,
  type FinalizationResultAuthority,
} from '@stark-ballot/application/finalize/finalization-types';
import { normalizeExecutionReceipt } from '@stark-ballot/verification/receipt-normalizer';
import { buildSupportedPublicInputArtifactFromZkvmInput } from '@stark-ballot/verification/public-input';
import { normalizeBitmapRoot } from '@stark-ballot/verification/bitmap-root';
import { buildCloseStatement, buildElectionManifest } from '@stark-ballot/verification/public-audit-artifacts';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { isSupportedZkVMJournal } from '@stark-ballot/zkvm-contract/zkvm/journal-guards';
import { toPublicZkvmJournal } from '@stark-ballot/zkvm-contract/zkvm/public-journal';
import { getStringProperty } from '@stark-ballot/domain/utils/guards';
import { normalizeHexString } from '@stark-ballot/domain/utils/hex';
import { logger } from '@stark-ballot/diagnostics/logger';
import { hashSessionIdForLogging } from '@stark-ballot/diagnostics/logging';
import { resolveFinalizationTamperDetected } from '@stark-ballot/domain/finalize/finalization-tamper';
import { isCurrentArtifactBoundaryError } from '@stark-ballot/domain/contract';
import { buildUserVoteArtifacts, UserVoteArtifactsUnavailableError } from './user-vote-artifacts';
import type { FinalizeScenarioContext, FinalizeSessionError, FinalizeSyncPayload, Result } from './types';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export interface FinalizeSyncInput {
  sessionId: string;
  session: SessionData;
  contractGeneration: string;
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
  store: VoteStore & FinalizationStore;
  getExecutor: () => Promise<ZkVMExecutor>;
  proofBundleService: ProofBundleService;
  now?: () => number;
  assertAdmissibleFinalizationArtifactPatch?: (
    session: SessionData,
    patch: {
      finalized: true;
      finalizationResult: FinalizationResultAuthority;
      finalizationContractGeneration: string;
    },
    expectedContractGeneration: string,
  ) => void;
}

export async function finalizeSync(
  input: FinalizeSyncInput,
  deps: FinalizeSyncDependencies,
): Promise<Result<FinalizeSyncPayload, FinalizeSessionError>> {
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

    const scenarioTamperCount = input.scenario.summary.ignoredCount + input.scenario.summary.recountedCount;
    const reportedMethodVersion =
      typeof (zkVMResult as { methodVersion?: unknown }).methodVersion === 'number'
        ? (zkVMResult as { methodVersion: number }).methodVersion
        : undefined;
    if (!isSupportedZkVMJournal(zkVMResult)) {
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
    const publicJournal = toPublicZkvmJournal(zkVMResult);
    const artifactSourceResult: FinalizationResultAuthority = {
      tally: {
        counts: input.scenario.claimedCounts,
        totalVotes: input.scenario.claimedTotalVotes,
        tamperedCount: effectiveTamperedCount,
      },
      imageId: actualImageId || 'zkvm-image-v' + zkVMResult.methodVersion,
      journal: publicJournal,
    };

    let userVoteArtifacts;
    try {
      userVoteArtifacts = buildUserVoteArtifacts({
        session: input.session,
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
      contractGeneration: input.contractGeneration,
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
        return {
          ok: false,
          error: {
            kind: 'api',
            code: ApplicationErrorCode.VERIFICATION_FAILED,
            details: {
              status: proofBundleOutcome.error.status,
              verificationExecutionId: proofBundleOutcome.error.executionId,
              verificationReport: proofBundleOutcome.error.report,
            },
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

    const { executionId, verificationResult } = proofBundleOutcome;
    if (typeof executionId !== 'string' || executionId.length === 0) {
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ApplicationErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE,
          details: {
            details: 'Finalization result is missing execution authority',
          },
        },
      };
    }

    const publicInputArtifact = buildSupportedPublicInputArtifactFromZkvmInput(
      input.zkvmInput,
      zkVMResult.methodVersion,
      input.contractGeneration,
      {
        executionId,
        source: 'generated',
      },
    );
    const closeStatement = buildCloseStatement({
      logId: input.zkvmInput.logId,
      treeSize: zkVMResult.treeSize,
      timestamp: input.zkvmInput.timestamp,
      bulletinRoot: zkVMResult.bulletinRoot,
    });

    const bitmap = buildBitmapData({
      store: deps.store,
      zkvmResult: zkVMResult,
      bitmapProofSource: input.bitmapProofSource ?? executor.type,
    });

    const finalizationResult: FinalizationResultAuthority = {
      tally: {
        counts: input.scenario.claimedCounts,
        totalVotes: input.scenario.claimedTotalVotes,
        tamperedCount: effectiveTamperedCount,
      },
      verificationResult,
      receipt: normalizedReceipt.receipt,
      imageId: actualImageId || 'zkvm-image-v' + zkVMResult.methodVersion,
      tamperDetected: resolveFinalizationTamperDetected({
        excludedSlots: zkVMResult.excludedSlots,
        rejectedRecords: zkVMResult.rejectedRecords,
        scenarioTamperCount,
      }),
      journal: publicJournal,
      publicInputArtifact,
      electionManifest,
      closeStatement,
      ...omitUndefinedProperties({
        bitmapProofSource: bitmap.bitmapProofSource,
        bitmapData: bitmap.bitmapData,
      }),
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
    try {
      deps.assertAdmissibleFinalizationArtifactPatch?.(
        input.session,
        {
          finalized: true,
          finalizationResult,
          finalizationContractGeneration: input.contractGeneration,
        },
        input.contractGeneration,
      );
    } catch (error) {
      if (isCurrentArtifactBoundaryError(error)) {
        return {
          ok: false,
          error: {
            kind: 'api',
            code:
              error.code === 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE'
                ? ApplicationErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
                : ApplicationErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
            details: {
              details: error.message,
              artifactState: error.artifactState,
              ...error.details,
            },
          },
        };
      }
      throw error;
    }

    const receiptData = {
      receipt: JSON.stringify({
        methodVersion: zkVMResult.methodVersion,
        sthDigest: zkVMResult.sthDigest,
        verifiedTally: zkVMResult.verifiedTally,
        includedBitmapRoot: zkVMResult.includedBitmapRoot,
      }),
      timestamp: (deps.now ?? Date.now)(),
    };
    let receiptHash = '';
    let boardIndex = 0;
    if (deps.store.finalizeSessionWithReceiptPublication) {
      try {
        const boardResult = await deps.store.finalizeSessionWithReceiptPublication(
          input.sessionId,
          finalizationResult,
          input.contractGeneration,
          receiptData,
          executionId,
        );
        receiptHash = boardResult.receiptHash;
        boardIndex = boardResult.boardIndex;
        finalizationResult.receiptPublication = {
          receiptHash,
          boardIndex,
          timestamp: receiptData.timestamp,
        };
        logger.info('[API] Receipt saved to board:', {
          receiptHash,
          boardIndex,
        });
      } catch (error) {
        if (isCurrentArtifactBoundaryError(error)) {
          return {
            ok: false,
            error: {
              kind: 'api',
              code:
                error.code === 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE'
                  ? ApplicationErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
                  : ApplicationErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
              details: {
                details: error.message,
                artifactState: error.artifactState,
                ...error.details,
              },
            },
          };
        }
        logger.error('[API] Failed to atomically finalize receipt publication:', error);
        throw error;
      }
    }

    if (receiptHash) {
      finalizationResult.receiptPublication = {
        receiptHash,
        boardIndex,
        timestamp: receiptData.timestamp,
      };
    }

    const debugEnabled = input.debugFileStore ?? false;
    if (debugEnabled || input.debugFinalize) {
      logger.debug('[API][finalize][DEBUG] Attempting to save finalizationResult', {
        session_id_hash: hashSessionIdForLogging(input.sessionId),
        hasFinalizationResult: !!finalizationResult,
        verifiedTally: finalizationResult.journal.verifiedTally,
        timestamp: new Date().toISOString(),
      });
    }

    if (!deps.store.finalizeSessionWithReceiptPublication) {
      try {
        await deps.store.finalizeSession(input.sessionId, finalizationResult, input.contractGeneration, executionId);
      } catch (error) {
        if (isCurrentArtifactBoundaryError(error)) {
          return {
            ok: false,
            error: {
              kind: 'api',
              code:
                error.code === 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE'
                  ? ApplicationErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
                  : ApplicationErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
              details: {
                details: error.message,
                artifactState: error.artifactState,
                ...error.details,
              },
            },
          };
        }
        throw error;
      }
    }

    if (debugEnabled || input.debugFinalize) {
      logger.debug('[API][finalize][DEBUG] finalizeSession() completed', {
        session_id_hash: hashSessionIdForLogging(input.sessionId),
        timestamp: new Date().toISOString(),
      });
    }

    if (deps.store.saveBitmapData && bitmap.bitmapDataToSave) {
      try {
        await deps.store.saveBitmapData(input.sessionId, bitmap.bitmapDataToSave);
      } catch (error) {
        if (isCurrentArtifactBoundaryError(error)) {
          return {
            ok: false,
            error: {
              kind: 'api',
              code:
                error.code === 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE'
                  ? ApplicationErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
                  : ApplicationErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
              details: {
                details: error.message,
                artifactState: error.artifactState,
                ...error.details,
              },
            },
          };
        }
        throw error;
      }

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
        verificationExecutionId: executionId,
        finalizationResult,
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

function buildBitmapData(params: {
  store: FinalizationBitmapStore;
  zkvmResult: ZkVMExecutionResult;
  bitmapProofSource: 'mock' | 'real';
}): {
  bitmapDataToSave: FinalizationBitmapData | null;
  bitmapProofSource?: 'mock' | 'real';
  bitmapData?: FinalizationBitmapData;
} {
  const shouldSaveBitmap = typeof params.store.saveBitmapData === 'function';
  if (!shouldSaveBitmap) {
    return { bitmapDataToSave: null };
  }

  const includedBitmap = params.zkvmResult.includedBitmap ? [...params.zkvmResult.includedBitmap] : null;
  if (!includedBitmap) {
    logger.info('[API] Exact included bitmap unavailable; bitmap proof disabled');
    return { bitmapDataToSave: null };
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
    return { bitmapDataToSave: null };
  }

  const bitmapData = {
    includedBitmap,
    includedBitmapRoot: normalizeBitmapRoot(params.zkvmResult.includedBitmapRoot),
    ...buildSeenBitmapData(params.zkvmResult),
    treeSize: params.zkvmResult.treeSize,
    finalizedAt: Date.now(),
  };

  return {
    bitmapDataToSave: bitmapData,
    bitmapProofSource: params.bitmapProofSource,
    bitmapData,
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

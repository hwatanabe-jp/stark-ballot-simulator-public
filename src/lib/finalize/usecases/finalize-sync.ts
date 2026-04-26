import type { VoteStore } from '@/types/voteStore';
import type { FinalizationResultAuthority, SessionData } from '@/types/server';
import type { ZkVMInput } from '@/lib/zkvm/types';
import type { ZkVMExecutionResult } from '@/lib/zkvm/executor';
import type { ZkVMExecutor } from '@/lib/zkvm/executor-factory';
import type { ElectionConfig } from '@/lib/zkvm/election-config';
import type { ProofBundleService } from '@/lib/finalize/proof-bundle-service';
import { ErrorCode } from '@/lib/errors/apiErrors';
import { normalizeExecutionReceipt } from '@/lib/verification/receipt-normalizer';
import { buildSupportedPublicInputArtifactFromZkvmInput } from '@/lib/verification/public-input-contract';
import { normalizeBitmapRoot } from '@/lib/verification/bitmap-root';
import { buildCloseStatement, buildElectionManifest } from '@/lib/verification/public-audit-artifacts';
import { sanitizeVerificationReportForPublicResponse } from '@/lib/verification/public-verification-result';
import { computeIncludedBitmapRoot } from '@/lib/zkvm/bitmap';
import { isSupportedZkVMJournal } from '@/lib/zkvm/journal-guards';
import { toPublicZkvmJournal } from '@/lib/zkvm/public-journal';
import { getStringProperty } from '@/lib/utils/guards';
import { normalizeHexString, isValidHexString, addHexPrefix } from '@/lib/utils/hex';
import { logger } from '@/lib/utils/logger';
import { projectFinalizationResultForPublicResponse } from '@/lib/finalize/finalization-result';
import { resolveFinalizationTamperDetected } from '@/lib/finalize/finalization-tamper';
import type { CurrentZkVMJournal } from '@/lib/zkvm/types';
import { isCurrentArtifactBoundaryError } from '@/lib/contract';
import { assertAdmissibleFinalizationArtifactPatch } from '@/lib/store/finalizationArtifactAdmission';
import { buildUserVoteArtifacts, UserVoteArtifactsUnavailableError } from './user-vote-artifacts';
import type { FinalizeScenarioContext, FinalizeSessionError, FinalizeSyncPayload, Result } from './types';

export interface FinalizeSyncInput {
  sessionId: string;
  session: SessionData;
  contractGeneration: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  expectedImageId: string;
  publicBaseUrl: string;
  scenario: FinalizeScenarioContext;
  allowDevMode: boolean;
  debugFinalize: boolean;
  buildBundleUrl: (baseUrl: string, sessionId: string, executionId: string, ...segments: string[]) => string;
}

export interface FinalizeSyncDependencies {
  store: VoteStore;
  getExecutor: () => Promise<ZkVMExecutor>;
  proofBundleService: ProofBundleService;
  now?: () => number;
}

export async function finalizeSync(
  input: FinalizeSyncInput,
  deps: FinalizeSyncDependencies,
): Promise<Result<FinalizeSyncPayload, FinalizeSessionError>> {
  try {
    const executor = await deps.getExecutor();
    logger.info(`[API] Using ${executor.type} zkVM executor`);

    if (process.env.USE_MOCK_ZKVM === 'true') {
      logger.info('[API] Mock zkVM mode (JavaScript, ~100ms)');
    } else if (process.env.RISC0_DEV_MODE === '1') {
      logger.info('[API] Real zkVM dev mode (Rust binary, ~40ms, Fake receipts)');
    } else {
      logger.info('[API] Real zkVM production mode (Rust binary, ~366s for 64 votes, STARK proofs)');
    }

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
          code: ErrorCode.INTERNAL_ERROR,
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
            code: ErrorCode.INTERNAL_ERROR,
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
          code: ErrorCode.VERIFICATION_FAILED,
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
      publicBaseUrl: input.publicBaseUrl,
      allowDevMode: input.allowDevMode,
      verificationMode: executor.type === 'mock' ? 'mock' : 'verify',
      buildBundleUrl: input.buildBundleUrl,
    });

    if (!proofBundleOutcome.ok) {
      if (proofBundleOutcome.error.type === 'verifier_failed') {
        return {
          ok: false,
          error: {
            kind: 'api',
            code: ErrorCode.VERIFICATION_FAILED,
            details: {
              status: proofBundleOutcome.error.status,
              verificationExecutionId: proofBundleOutcome.error.executionId,
              verificationReport: sanitizeVerificationReportForPublicResponse(proofBundleOutcome.error.report),
            },
          },
        };
      }

      logger.error('[API] proof bundle creation failed', proofBundleOutcome.error.error);
      return {
        ok: false,
        error: {
          kind: 'api',
          code: ErrorCode.INTERNAL_ERROR,
          details: { details: 'Proof bundle creation failed' },
        },
      };
    }

    const verificationResult = proofBundleOutcome.verificationResult;

    const publicInputArtifact = buildSupportedPublicInputArtifactFromZkvmInput(
      input.zkvmInput,
      zkVMResult.methodVersion,
      input.contractGeneration,
      {
        executionId: verificationResult.executionId,
        bundleKey: verificationResult.s3BundleKey,
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
    });

    const finalizationResult: FinalizationResultAuthority = {
      tally: {
        counts: input.scenario.claimedCounts,
        totalVotes: input.scenario.claimedTotalVotes,
        tamperedCount: effectiveTamperedCount,
      },
      s3BundleKey: verificationResult.s3BundleKey,
      s3UploadedAt: verificationResult.s3UploadedAt,
      receipt: verificationResult.s3BundleKey ? undefined : normalizedReceipt.receipt,
      receiptRaw: verificationResult.s3BundleKey ? undefined : normalizedReceipt.rawPayload,
      receiptPublication: undefined,
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
      bitmapProofSource: bitmap.bitmapProofSource,
      bitmapData: bitmap.bitmapData ?? undefined,
      scenarios: input.scenario.scenarios,
      verificationResult,
      verificationExecutionId: verificationResult.executionId,
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
    };
    try {
      assertAdmissibleFinalizationArtifactPatch(
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
                ? ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
                : ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
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

    let receiptHash = '';
    let boardIndex = 0;
    if (deps.store.saveReceiptToBoard) {
      try {
        const receiptData = {
          receipt: JSON.stringify({
            methodVersion: zkVMResult.methodVersion,
            sthDigest: zkVMResult.sthDigest,
            verifiedTally: zkVMResult.verifiedTally,
            includedBitmapRoot: zkVMResult.includedBitmapRoot,
          }),
          timestamp: (deps.now ?? Date.now)(),
        };
        const boardResult = await deps.store.saveReceiptToBoard(input.sessionId, receiptData);
        receiptHash = boardResult.receiptHash;
        boardIndex = boardResult.boardIndex;
        logger.info('[API] Receipt saved to board:', {
          receiptHash,
          boardIndex,
        });
      } catch (error) {
        logger.error('[API] Failed to save receipt to board:', error);
        throw new Error('Receipt publication failed');
      }
    }

    if (receiptHash) {
      finalizationResult.receiptPublication = {
        receiptHash,
        boardIndex,
        timestamp: (deps.now ?? Date.now)(),
      };
    }

    const debugEnabled = process.env.DEBUG_FILE_STORE === '1';
    if (debugEnabled || input.debugFinalize) {
      const projected = projectFinalizationResultForPublicResponse(finalizationResult);
      logger.debug('[API][finalize][DEBUG] Attempting to save finalizationResult', {
        sessionId: input.sessionId,
        hasFinalizationResult: !!finalizationResult,
        verifiedTally: projected.verifiedTally,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      await deps.store.finalizeSession(input.sessionId, finalizationResult, input.contractGeneration);
    } catch (error) {
      if (isCurrentArtifactBoundaryError(error)) {
        return {
          ok: false,
          error: {
            kind: 'api',
            code:
              error.code === 'CORRUPT_OR_UNREADABLE_FINALIZED_STATE'
                ? ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
                : ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
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

    if (debugEnabled || input.debugFinalize) {
      logger.debug('[API][finalize][DEBUG] finalizeSession() completed', {
        sessionId: input.sessionId,
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
                  ? ErrorCode.CORRUPT_OR_UNREADABLE_FINALIZED_STATE
                  : ErrorCode.UNSUPPORTED_CURRENT_ARTIFACT,
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

      logger.info('[API] Saved bitmap data for session:', input.sessionId);
    }
    input.session.finalized = true;
    input.session.finalizationResult = finalizationResult;

    const { bulletinRoot, inputCommitment, voteReceipt, userVoteProof } = userVoteArtifacts;

    const normalizeHex32 = (value: string | undefined, label: string): string => {
      if (!isValidHexString(value ?? '', 32)) {
        throw new Error(`Invalid ${label} (expected 32-byte hex)`);
      }
      return addHexPrefix(normalizeHexString(value ?? ''));
    };

    if (input.debugFinalize) {
      const projected = projectFinalizationResultForPublicResponse(finalizationResult);
      logger.debug('[DEBUG] finalizationResult before API response:', {
        tally: finalizationResult.tally,
        verifiedTally: projected.verifiedTally,
        missingSlots: projected.missingSlots,
        invalidPresentedSlots: projected.invalidPresentedSlots,
        validVotes: projected.journal.validVotes,
        excludedSlots: projected.excludedSlots,
        totalExpected: projected.totalExpected,
        treeSize: projected.treeSize,
      });
    }

    const receiptJournal = normalizedReceipt.receipt.journal;
    if (typeof receiptJournal !== 'string') {
      throw new Error('Receipt journal is missing or invalid');
    }

    const projected = projectFinalizationResultForPublicResponse(finalizationResult);
    const projectedVerificationResult = projected.verificationResult;
    const currentJournal = projected.journal as CurrentZkVMJournal;

    return {
      ok: true,
      value: {
        sessionId: input.sessionId,
        tally: {
          counts: finalizationResult.tally.counts,
          totalVotes: finalizationResult.tally.totalVotes,
          tamperedCount: finalizationResult.tally.tamperedCount,
        },
        bulletinRoot,
        verifiedTally: projected.verifiedTally,
        voteReceipt,
        receipt: { ...normalizedReceipt.receipt, imageId: actualImageId, journal: receiptJournal },
        receiptPublication:
          finalizationResult.receiptPublication ??
          (receiptHash
            ? {
                receiptHash,
                boardIndex,
              }
            : undefined),
        imageId: normalizeHex32(projected.imageId, 'imageId'),
        userVote: userVoteProof,
        missingSlots: projected.missingSlots,
        invalidPresentedSlots: projected.invalidPresentedSlots,
        rejectedRecords: projected.rejectedRecords,
        totalExpected: projected.totalExpected,
        treeSize: projected.treeSize,
        excludedSlots: projected.excludedSlots,
        sthDigest: normalizeHex32(projected.sthDigest, 'sthDigest'),
        ...(projected.seenBitmapRoot
          ? { seenBitmapRoot: normalizeHex32(projected.seenBitmapRoot, 'seenBitmapRoot') }
          : {}),
        includedBitmapRoot: normalizeHex32(projected.includedBitmapRoot, 'includedBitmapRoot'),
        inputCommitment,
        seenIndicesCount: projected.seenIndicesCount,
        journal: currentJournal,
        verificationStatus: projectedVerificationResult?.status ?? 'not_run',
        verificationReport: projectedVerificationResult?.report,
        verificationExecutionId: projectedVerificationResult?.executionId ?? finalizationResult.verificationExecutionId,
        tamperSummary: finalizationResult.tamperSummary,
      },
    };
  } catch (zkError) {
    logger.error('zkVM execution failed:', zkError);
    return {
      ok: false,
      error: {
        kind: 'api',
        code: ErrorCode.INTERNAL_ERROR,
        details: { details: 'Proof generation failed' },
      },
    };
  }
}

function buildBitmapData(params: { store: VoteStore; zkvmResult: ZkVMExecutionResult }): {
  bitmapDataToSave: NonNullable<SessionData['finalizationResult']>['bitmapData'] | null;
  bitmapProofSource?: 'mock' | 'real';
  bitmapData?: NonNullable<SessionData['finalizationResult']>['bitmapData'];
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

  const bitmapProofSource: 'mock' | 'real' = process.env.USE_MOCK_ZKVM === 'true' ? 'mock' : 'real';

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
    bitmapProofSource,
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

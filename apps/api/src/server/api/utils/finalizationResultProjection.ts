import type {
  FinalizationResultAuthority,
  FinalizeSyncPayload,
} from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizationBitmapRecord } from '@stark-ballot/application/finalize/finalization-store';
import type { FinalizationResource, FinalizationResult } from '@stark-ballot/api-contract/schemas/finalizations';
import { scenarioIdSchema, type ScenarioId } from '@stark-ballot/api-contract/schemas/primitives';
import type { AwsVerificationDeliveryMetadataInput } from '@stark-ballot/aws-adapters/finalize/finalizationDeliveryMetadataStore';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { sanitizeFinalizationResultVerificationStatus } from '@stark-ballot/verification/fail-closed-status';
import type {
  PublicVerificationDevModeReport,
  PublicVerificationFailedReport,
  PublicVerificationSuccessReport,
} from '@stark-ballot/verification/public-result';
import { projectVerificationResultForPublicResponse } from '@stark-ballot/verification/public-result';
import type { VerificationResult } from '@stark-ballot/verification/shared/types';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import { toPublicZkvmJournal } from '@stark-ballot/zkvm-contract/zkvm/public-journal';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

interface FinalizationResultProjectionEvidence {
  verificationResult?: VerificationResult;
  deliveryMetadata?: AwsVerificationDeliveryMetadataInput;
  bitmapData?: FinalizationBitmapRecord;
}

type PublicFinalizationVerificationState =
  | { verificationStatus: 'not_run' | 'running'; verificationReport?: undefined }
  | { verificationStatus: 'success'; verificationReport?: PublicVerificationSuccessReport }
  | { verificationStatus: 'dev_mode'; verificationReport?: PublicVerificationDevModeReport }
  | { verificationStatus: 'failed'; verificationReport?: PublicVerificationFailedReport };

function projectPublicFinalizationVerificationState(
  result: VerificationResult | undefined,
): PublicFinalizationVerificationState {
  const projected = projectVerificationResultForPublicResponse(result ?? { status: 'not_run' });
  switch (projected.status) {
    case 'not_run':
    case 'running':
      return { verificationStatus: projected.status };
    case 'success':
      return {
        verificationStatus: 'success',
        ...(projected.report ? { verificationReport: projected.report } : {}),
      };
    case 'dev_mode':
      return {
        verificationStatus: 'dev_mode',
        ...(projected.report ? { verificationReport: projected.report } : {}),
      };
    case 'failed':
      return {
        verificationStatus: 'failed',
        ...(projected.report ? { verificationReport: projected.report } : {}),
      };
  }
}

function normalizeHex32(value: string | undefined, label: string): string {
  if (!isValidHexString(value ?? '', 32)) {
    throw new Error(`Invalid ${label} (expected 32-byte hex)`);
  }
  return addHexPrefix(normalizeHexString(value ?? ''));
}

function assertSameHex32(left: string, right: string, label: string): void {
  if (normalizeHex32(left, label) !== normalizeHex32(right, label)) {
    throw new Error(`${label} does not match canonical journal authority`);
  }
}

function projectPublicReceiptMetadata(metadata: ReceiptWithImageId['metadata']): { isFake: boolean } | undefined {
  return typeof metadata?.isFake === 'boolean' ? { isFake: metadata.isFake } : undefined;
}

function admitFinalizationScenarios(values: string[]): ScenarioId[] {
  const scenarios = values.map((value) => {
    const admitted = scenarioIdSchema.safeParse(value);
    if (!admitted.success) {
      throw new Error('Finalization result contains an unknown scenario');
    }
    return admitted.data;
  });
  if (scenarios.length > 1 || scenarios[0] === 'S0') {
    throw new Error('Finalization result contains a non-canonical scenario projection');
  }
  return scenarios;
}

function deriveArtifactAvailability(
  evidence: FinalizationResultProjectionEvidence,
): FinalizationResult['artifactAvailability'] {
  const { verificationResult, deliveryMetadata } = evidence;
  return {
    bundle: deliveryMetadata?.s3BundleKey || verificationResult ? 'available' : 'unavailable',
    report: verificationResult?.report ? 'available' : 'unavailable',
    includedBitmap: evidence.bitmapData?.includedBitmap ? 'available' : 'unavailable',
    seenBitmap: evidence.bitmapData?.seenBitmap ? 'available' : 'unavailable',
  };
}

function assertResultMirrorsMatchJournal(result: FinalizationResultAuthority): void {
  const journal = toPublicZkvmJournal(result.journal);
  if (journal.imageId !== undefined) {
    assertSameHex32(result.imageId, journal.imageId, 'imageId');
  }
  const receipt = result.artifacts.receipt;
  if (receipt.availability === 'available' && receipt.receipt.imageId !== undefined) {
    assertSameHex32(result.imageId, receipt.receipt.imageId, 'receipt imageId');
  }
  const bitmap = result.artifacts.bitmap;
  if (bitmap.availability === 'available') {
    assertSameHex32(bitmap.data.includedBitmapRoot, journal.includedBitmapRoot, 'includedBitmapRoot');
    if (bitmap.data.treeSize !== journal.treeSize) {
      throw new Error('bitmap treeSize does not match canonical journal authority');
    }
    if (bitmap.data.seenBitmapRoot !== undefined) {
      assertSameHex32(bitmap.data.seenBitmapRoot, journal.seenBitmapRoot, 'seenBitmapRoot');
    }
  }
}

export function projectFinalizationResultForPublicResponse(
  result: FinalizationResultAuthority,
  voterEvidence?: FinalizationResult['voterEvidence'],
  evidence: FinalizationResultProjectionEvidence = {},
): FinalizationResult {
  assertResultMirrorsMatchJournal(result);
  const sanitized = sanitizeFinalizationResultVerificationStatus({
    ...result,
    ...omitUndefinedProperties({ verificationResult: evidence.verificationResult }),
  });
  const journal = toPublicZkvmJournal(sanitized.journal);
  const verificationResult = sanitized.verificationResult;
  const imageId = normalizeHex32(sanitized.imageId, 'imageId');
  const receipt = sanitized.artifacts.receipt;
  const receiptPublication = sanitized.artifacts.receiptPublication;
  const publicAudit = sanitized.artifacts.publicAudit;
  const bitmap = sanitized.artifacts.bitmap;
  if (sanitized.tamperDetected === undefined || sanitized.scenarios === undefined) {
    throw new Error('Finalization result is missing admitted scenario presentation authority');
  }
  const scenarios = admitFinalizationScenarios(sanitized.scenarios);
  const resolvedVoterEvidence = voterEvidence ?? {
    state: 'verification-gated',
    ...omitUndefinedProperties({
      receiptPublication: receiptPublication.availability === 'available' ? receiptPublication.publication : undefined,
    }),
  };

  return {
    authority: {
      imageId,
      journal,
      ...omitUndefinedProperties({
        receipt:
          receipt.availability === 'available'
            ? {
                imageId: normalizeHex32(receipt.receipt.imageId ?? sanitized.imageId, 'receipt imageId'),
                seal: receipt.receipt.seal,
                ...omitUndefinedProperties({
                  journal: typeof receipt.receipt.journal === 'string' ? receipt.receipt.journal : undefined,
                  metadata: projectPublicReceiptMetadata(receipt.receipt.metadata),
                }),
              }
            : undefined,
        electionManifest:
          publicAudit.availability === 'available'
            ? {
                ...publicAudit.electionManifest,
                choices: [...publicAudit.electionManifest.choices],
              }
            : undefined,
        closeStatement: publicAudit.availability === 'available' ? publicAudit.closeStatement : undefined,
      }),
    },
    presentation: {
      tally: sanitized.tally,
      verifiedTally: [...journal.verifiedTally],
      tamperDetected: sanitized.tamperDetected,
      scenarios,
      ...omitUndefinedProperties({ tamperSummary: sanitized.tamperSummary }),
      bulletinRoot: normalizeHex32(journal.bulletinRoot, 'bulletinRoot'),
      missingSlots: journal.missingSlots,
      invalidPresentedSlots: journal.invalidPresentedSlots,
      rejectedRecords: journal.rejectedRecords,
      totalExpected: journal.totalExpected,
      treeSize: journal.treeSize,
      excludedSlots: journal.excludedSlots,
      sthDigest: normalizeHex32(journal.sthDigest, 'sthDigest'),
      seenBitmapRoot: normalizeHex32(journal.seenBitmapRoot, 'seenBitmapRoot'),
      includedBitmapRoot: normalizeHex32(journal.includedBitmapRoot, 'includedBitmapRoot'),
      inputCommitment: normalizeHex32(journal.inputCommitment, 'inputCommitment'),
      seenIndicesCount: journal.seenIndicesCount,
      ...omitUndefinedProperties({
        bitmapProofSource: bitmap.availability === 'available' ? bitmap.proofSource : undefined,
      }),
      ...projectPublicFinalizationVerificationState(verificationResult),
    },
    voterEvidence: resolvedVoterEvidence,
    artifactAvailability: deriveArtifactAvailability(evidence),
  };
}

function projectVoteReceiptForPublicFinalizeResponse(
  voteReceipt: FinalizeSyncPayload['voteReceipt'],
): Extract<FinalizationResult['voterEvidence'], { state: 'available' }>['voteReceipt'] {
  if (voteReceipt.inputCommitment === undefined) {
    throw new Error('Finalization vote receipt is missing its input commitment');
  }
  return {
    voteId: voteReceipt.voteId,
    commitment: voteReceipt.commitment,
    bulletinIndex: voteReceipt.bulletinIndex,
    bulletinRootAtCast: voteReceipt.bulletinRootAtCast,
    castAtMs: voteReceipt.timestamp,
    inputCommitment: voteReceipt.inputCommitment,
  };
}

export function projectFinalizeSyncPayloadForResponse(payload: FinalizeSyncPayload): FinalizationResource {
  if (payload.state.finalizationId !== payload.finalizationId) {
    throw new Error('Synchronous finalization state identity mismatch');
  }

  const journal = toPublicZkvmJournal(payload.finalizationResult.journal);
  assertSameHex32(payload.bulletinRoot, journal.bulletinRoot, 'bulletinRoot');
  assertSameHex32(payload.inputCommitment, journal.inputCommitment, 'inputCommitment');

  const finalizationResult = projectFinalizationResultForPublicResponse(
    payload.finalizationResult,
    {
      state: 'available',
      voteReceipt: projectVoteReceiptForPublicFinalizeResponse(payload.voteReceipt),
      userVote: payload.userVote,
      ...omitUndefinedProperties({
        receiptPublication:
          payload.finalizationResult.artifacts.receiptPublication.availability === 'available'
            ? payload.finalizationResult.artifacts.receiptPublication.publication
            : undefined,
      }),
    },
    {
      verificationResult: payload.verificationResult,
      ...(payload.bitmapDisposition.availability === 'available'
        ? {
            bitmapData: {
              sessionId: payload.sessionId,
              finalizationId: payload.finalizationId,
              ...payload.bitmapDisposition.data,
            },
          }
        : {}),
    },
  );

  return {
    ...payload.state,
    runtimeDiagnostics: {
      asyncMode: 'disabled',
    },
    result: finalizationResult,
  };
}

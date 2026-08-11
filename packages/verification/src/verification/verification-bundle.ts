import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ZkVMExecutionResult } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import { serializeZkvmAggregatorInput } from '@stark-ballot/zkvm-contract/zkvm/host-io';
import { toPublicZkvmJournal } from '@stark-ballot/zkvm-contract/zkvm/public-journal';
import type { ReceiptWithImageId } from '@stark-ballot/verification/image-id-types';
import type { AdmittedReceiptPayload } from '@stark-ballot/verification/receipt-normalizer';
import {
  buildCloseStatement,
  buildElectionManifest,
  resolveElectionConfigForManifest,
  type ElectionManifest,
} from '@stark-ballot/verification/public-audit-artifacts';
import { createIncludedBitmapArtifact } from '@stark-ballot/verification/included-bitmap-artifact';
import { createSeenBitmapArtifact } from '@stark-ballot/verification/seen-bitmap-artifact';
import { getStringProperty } from '@stark-ballot/validation/unknown-value-guards';
import {
  buildSupportedPublicInputArtifactFromZkvmInput,
  buildPublicInputArtifactFromZkvmInput,
} from '@stark-ballot/verification/public-input';
import { resolveConsistentPublicAuditArtifacts } from './public-audit-artifact-consistency';

export interface VerificationBundleArtifactContext {
  sessionId: string;
  createdAt: string;
  zkvmInput: ZkVMInput;
  electionConfig: ElectionConfig;
  electionManifest?: ElectionManifest;
  zkvmResult: ZkVMExecutionResult;
  normalizedReceipt?: {
    receipt?: ReceiptWithImageId;
    rawPayload?: AdmittedReceiptPayload;
  };
}

export interface VerificationBundleArtifacts {
  artifacts: Record<string, unknown>;
}

export function buildVerificationBundleArtifacts(
  context: VerificationBundleArtifactContext,
): VerificationBundleArtifacts {
  const serializedInput = serializeZkvmAggregatorInput(context.zkvmInput);
  const privateInputPayload = {
    ...serializedInput,
    election_config: {
      totalExpected: context.electionConfig.totalExpected,
      choices: [...context.electionConfig.choices],
      version: context.electionConfig.version,
      botCount: context.electionConfig.botCount,
      merkleTreeDepth: context.electionConfig.merkleTreeDepth,
    },
  };

  const publicInput = buildPublicInputArtifactFromZkvmInput(context.zkvmInput, context.zkvmResult.methodVersion);
  const canonicalJournal = toPublicZkvmJournal(context.zkvmResult);
  const publicInputArtifact = buildSupportedPublicInputArtifactFromZkvmInput(
    context.zkvmInput,
    context.zkvmResult.methodVersion,
    { source: 'generated' },
  );

  const electionManifest =
    context.electionManifest ??
    buildElectionManifest(
      context.zkvmInput.electionId,
      resolveElectionConfigForManifest({
        electionConfig: context.electionConfig,
        electionConfigHash: context.zkvmInput.electionConfigHash,
        totalExpected: context.zkvmInput.totalExpected,
      }),
    );

  const closeStatement = buildCloseStatement({
    logId: publicInput.logId,
    treeSize: canonicalJournal.treeSize,
    timestamp: publicInput.timestamp,
    bulletinRoot: canonicalJournal.bulletinRoot,
  });

  const artifactResolution = resolveConsistentPublicAuditArtifacts({
    journal: canonicalJournal,
    publicInputArtifact,
    electionManifest,
    closeStatement,
    hasLocalPublicInputAuthority: true,
  });
  if (artifactResolution.issues.length > 0) {
    throw new Error(
      `Public audit artifacts are inconsistent with canonical proof data: ${artifactResolution.issues
        .map((issue) => `${issue.artifact}:${issue.reason}`)
        .join(', ')}`,
    );
  }

  const receiptPayload = resolveReceiptPayload(context);
  const artifacts: Record<string, unknown> = {
    'input.json': privateInputPayload,
    'public-input.json': publicInput,
    'election-manifest.json': electionManifest,
    'close-statement.json': closeStatement,
    'journal.json': canonicalJournal,
    'receipt.json': receiptPayload,
    'metadata.json': {
      sessionId: context.sessionId,
      createdAt: context.createdAt,
      methodVersion: context.zkvmResult.methodVersion,
    },
  };

  if (context.zkvmResult.includedBitmap) {
    artifacts['included-bitmap.json'] = createIncludedBitmapArtifact({
      includedBitmap: context.zkvmResult.includedBitmap,
      includedBitmapRoot: context.zkvmResult.includedBitmapRoot,
      treeSize: context.zkvmResult.treeSize,
    });
  }

  if (context.zkvmResult.seenBitmap && context.zkvmResult.seenBitmapRoot) {
    artifacts['seen-bitmap.json'] = createSeenBitmapArtifact({
      seenBitmap: context.zkvmResult.seenBitmap,
      seenBitmapRoot: context.zkvmResult.seenBitmapRoot,
      treeSize: context.zkvmResult.treeSize,
    });
  }

  return { artifacts };
}

function resolveReceiptPayload(context: VerificationBundleArtifactContext): unknown {
  const { zkvmResult, normalizedReceipt } = context;
  const derivedImageId =
    normalizedReceipt?.receipt?.imageId ?? zkvmResult.imageId ?? getStringProperty(zkvmResult, 'imageID');

  if (zkvmResult.receipt?.raw && typeof zkvmResult.receipt.raw === 'object') {
    return injectImageIdentifiers(zkvmResult.receipt.raw as Record<string, unknown>, derivedImageId);
  }

  if (normalizedReceipt?.rawPayload) {
    return injectImageIdentifiers(normalizedReceipt.rawPayload, derivedImageId);
  }

  if (normalizedReceipt?.receipt) {
    const { receipt } = normalizedReceipt;
    return {
      receipt: {
        seal: receipt.seal,
        journal: receipt.journal,
        imageId: receipt.imageId,
        image_id: receipt.imageId,
      },
      imageId: receipt.imageId,
      image_id: receipt.imageId,
    };
  }

  throw new Error('zkVM receipt payload unavailable for verification bundle');
}

function injectImageIdentifiers(
  payload: Record<string, unknown>,
  imageId: string | undefined,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  if (imageId) {
    if (typeof cloned['image_id'] !== 'string') {
      cloned['image_id'] = imageId;
    }
    if (typeof cloned['imageId'] !== 'string') {
      cloned['imageId'] = imageId;
    }

    if (cloned['receipt'] && typeof cloned['receipt'] === 'object') {
      const receipt = cloned['receipt'] as Record<string, unknown>;
      if (typeof receipt['image_id'] !== 'string') {
        receipt['image_id'] = imageId;
      }
      if (typeof receipt['imageId'] !== 'string') {
        receipt['imageId'] = imageId;
      }
    }
  }

  return cloned;
}

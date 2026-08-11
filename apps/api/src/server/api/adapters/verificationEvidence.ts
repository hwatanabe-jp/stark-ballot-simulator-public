import type {
  FinalizationBitmapData,
  FinalizationBitmapStore,
} from '@stark-ballot/application/finalize/finalization-store';
import type { SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import type { VoteStore } from '@stark-ballot/domain/types/voteStore';
import { asBitmapBitIndex } from '@stark-ballot/verification/bitmap-proof-types';
import type {
  AdmittedConsistencyProof,
  BitmapProofResponse,
  EvidenceAcquisition,
} from '@stark-ballot/verification/engine-types';
import { resolveBitmapProofResponse, type BitmapProofFinalizationResult } from '../handlers/bitmapProof';
import { resolveConsistencyProofData } from '../handlers/bulletin';

type BitmapEvidenceStore = VoteStore & FinalizationBitmapStore;

export interface AcquireConsistencyProofEvidenceOptions {
  session: SessionVotingRecord;
  fromTreeSize?: number;
  toTreeSize?: number;
  generatedAtMs: number;
}

export function acquireConsistencyProofEvidence({
  session,
  fromTreeSize,
  toTreeSize,
  generatedAtMs,
}: AcquireConsistencyProofEvidenceOptions): EvidenceAcquisition<AdmittedConsistencyProof> {
  if (fromTreeSize === undefined || toTreeSize === undefined) {
    return {
      kind: 'unavailable',
      message: 'Consistency proof evidence is unavailable.',
    };
  }

  try {
    const resolution = resolveConsistencyProofData({
      session,
      fromTreeSize,
      toTreeSize,
      generatedAtMs,
    });
    if (!resolution.ok) {
      return {
        kind: 'malformed',
        message: resolution.message,
      };
    }
    const { oldSubtreeHashes, appendSubtreeHashes, ...required } = resolution.data;
    return {
      kind: 'admitted',
      value: {
        ...required,
        ...(oldSubtreeHashes !== undefined ? { oldSubtreeHashes } : {}),
        ...(appendSubtreeHashes !== undefined ? { appendSubtreeHashes } : {}),
      },
    };
  } catch (error) {
    return {
      kind: 'transport_failed',
      message: `Consistency proof acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface BitmapProofEvidence {
  included: EvidenceAcquisition<BitmapProofResponse>;
  seen?: EvidenceAcquisition<BitmapProofResponse>;
}

export interface AcquireBitmapProofEvidenceOptions {
  store: BitmapEvidenceStore;
  sessionId: string;
  finalizationId: string;
  finalizationResult: BitmapProofFinalizationResult;
  voteIndex?: number;
}

function unavailableBitmapEvidence(message: string): EvidenceAcquisition<BitmapProofResponse> {
  return { kind: 'unavailable', message };
}

function malformedBitmapEvidence(message: string): EvidenceAcquisition<BitmapProofResponse> {
  return { kind: 'malformed', message };
}

export async function acquireBitmapProofEvidence({
  store,
  sessionId,
  finalizationId,
  finalizationResult,
  voteIndex,
}: AcquireBitmapProofEvidenceOptions): Promise<BitmapProofEvidence> {
  const includeSeenProof = typeof finalizationResult.journal.seenBitmapRoot === 'string';
  if (voteIndex === undefined) {
    const included = unavailableBitmapEvidence('Bitmap proof evidence is unavailable without a user vote index.');
    return {
      included,
      ...(includeSeenProof ? { seen: included } : {}),
    };
  }

  let bitIndex: ReturnType<typeof asBitmapBitIndex>;
  try {
    bitIndex = asBitmapBitIndex(voteIndex);
  } catch {
    const included = malformedBitmapEvidence('Bitmap proof vote index is invalid.');
    return {
      included,
      ...(includeSeenProof ? { seen: included } : {}),
    };
  }

  let bitmapData: FinalizationBitmapData | null;
  try {
    bitmapData = await store.getBitmapData(sessionId, finalizationId);
  } catch (error) {
    const included: EvidenceAcquisition<BitmapProofResponse> = {
      kind: 'transport_failed',
      message: `Bitmap proof acquisition failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    return {
      included,
      ...(includeSeenProof ? { seen: included } : {}),
    };
  }
  if (!bitmapData) {
    const included = unavailableBitmapEvidence('Bitmap proof data is unavailable.');
    return {
      included,
      ...(includeSeenProof ? { seen: included } : {}),
    };
  }

  const acquireKind = (kind: 'included' | 'seen'): EvidenceAcquisition<BitmapProofResponse> => {
    const resolution = resolveBitmapProofResponse({
      bitmapData,
      finalizationResult,
      index: bitIndex,
      kind,
    });
    return resolution.ok
      ? { kind: 'admitted', value: resolution.response }
      : malformedBitmapEvidence(resolution.message);
  };

  return {
    included: acquireKind('included'),
    ...(includeSeenProof ? { seen: acquireKind('seen') } : {}),
  };
}

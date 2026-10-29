import type { SessionId } from '@stark-ballot/domain/types/identifiers';
import type { SessionVotingStore } from '@stark-ballot/domain/types/voteStore';
import type { StoredVoteRecord, SessionVotingRecord } from '@stark-ballot/domain/types/sessionRecords';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';

type CtProofProvider = {
  getInclusionProof(
    voteId: string,
    treeSize: number,
  ):
    | {
        leafIndex: number;
        treeSize: number;
        proofNodes: string[];
        rootHash: string;
      }
    | null
    | undefined;
};

export type ExactCtProof = {
  leafIndex: number;
  merklePath: string[];
  bulletinRootAtCast: string;
  treeSize: number;
};

function throwCtProofUnavailable(): never {
  throw new Error('CT_PROOF_UNAVAILABLE');
}

function rethrowAsCtProofUnavailable(error: unknown): never {
  if (error instanceof Error && error.message === 'CT_PROOF_UNAVAILABLE') {
    throw error;
  }
  throwCtProofUnavailable();
}

export function deriveExactCtProof(params: {
  bulletin?: CtProofProvider;
  voteId?: string;
  leafIndex: number;
  rootAtCast?: string;
}): ExactCtProof {
  const { bulletin, voteId, leafIndex, rootAtCast } = params;

  if (!bulletin || !voteId || !Number.isInteger(leafIndex) || leafIndex < 0 || !rootAtCast) {
    throwCtProofUnavailable();
  }

  const castTreeSize = leafIndex + 1;

  let ctProof;
  try {
    ctProof = bulletin.getInclusionProof(voteId, castTreeSize);
  } catch {
    throwCtProofUnavailable();
  }

  if (!ctProof || !Array.isArray(ctProof.proofNodes)) {
    throwCtProofUnavailable();
  }

  if (ctProof.leafIndex !== leafIndex || ctProof.treeSize !== castTreeSize) {
    throwCtProofUnavailable();
  }

  try {
    const normalizedRootAtCast = normalizeHex(rootAtCast, { allowEmpty: true });
    const normalizedProofRoot = normalizeHex(ctProof.rootHash, { allowEmpty: true });
    if (normalizedRootAtCast !== normalizedProofRoot) {
      throwCtProofUnavailable();
    }

    return {
      leafIndex,
      merklePath: ctProof.proofNodes.map((node) => normalizeHex(node, { allowEmpty: true })),
      bulletinRootAtCast: normalizedRootAtCast,
      treeSize: ctProof.treeSize,
    };
  } catch (error) {
    rethrowAsCtProofUnavailable(error);
  }
}

export type VoteWithCtProof = ExactCtProof & { voteData: StoredVoteRecord };
export type TimestampedCtProof = ExactCtProof & { timestamp: number };

function deriveStoredVoteProof(
  voteInfo: { voteData: StoredVoteRecord; index: number } | null,
  voting: SessionVotingRecord | null,
): VoteWithCtProof | null {
  if (!voteInfo || !voting) return null;
  return {
    voteData: voteInfo.voteData,
    ...deriveExactCtProof({
      bulletin: voting.bulletin,
      voteId: voteInfo.voteData.voteId,
      leafIndex: voteInfo.index,
      rootAtCast: voteInfo.voteData.rootAtCast,
    }),
  };
}

function timestampedVoteProof(proof: VoteWithCtProof | null): TimestampedCtProof | null {
  return proof
    ? {
        leafIndex: proof.leafIndex,
        merklePath: proof.merklePath,
        bulletinRootAtCast: proof.bulletinRootAtCast,
        treeSize: proof.treeSize,
        timestamp: proof.voteData.timestamp,
      }
    : null;
}

export async function readStoredVoteProof(
  store: Pick<SessionVotingStore, 'getVoteById' | 'getVotingRecord'>,
  sessionId: SessionId,
  voteId: string,
): Promise<VoteWithCtProof | null> {
  const voteInfo = await store.getVoteById(sessionId, voteId);
  const voting = await store.getVotingRecord(sessionId);
  return deriveStoredVoteProof(voteInfo, voting);
}

export async function readIndexedVoteProof(
  store: Pick<SessionVotingStore, 'getVoteByIdWithProof'>,
  owner: { sessionId: SessionId } | undefined,
  voteId: string,
): Promise<TimestampedCtProof | null> {
  if (!owner) return null;
  return timestampedVoteProof(await store.getVoteByIdWithProof(owner.sessionId, voteId));
}

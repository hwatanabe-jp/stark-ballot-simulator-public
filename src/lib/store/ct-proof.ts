import { normalizeHex } from '@/lib/utils/hex';

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

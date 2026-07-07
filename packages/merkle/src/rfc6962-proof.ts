export interface CanonicalRfc6962Proof {
  leafIndex: number;
  treeSize: number;
  merklePath: string[];
  bulletinRootAtCast: string;
}

type Rfc6962ProofCandidate = Partial<CanonicalRfc6962Proof>;

/**
 * Normalize a boundary proof into the canonical internal RFC 6962 shape.
 */
export function toCanonicalRfc6962Proof(
  proof: Rfc6962ProofCandidate | null | undefined,
): CanonicalRfc6962Proof | undefined {
  if (!proof) {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(proof, 'proofMode')) {
    return undefined;
  }

  if (
    typeof proof.leafIndex !== 'number' ||
    typeof proof.treeSize !== 'number' ||
    !Array.isArray(proof.merklePath) ||
    typeof proof.bulletinRootAtCast !== 'string'
  ) {
    return undefined;
  }

  const merklePath = proof.merklePath.filter((entry): entry is string => typeof entry === 'string');
  if (merklePath.length !== proof.merklePath.length) {
    return undefined;
  }

  return {
    leafIndex: proof.leafIndex,
    treeSize: proof.treeSize,
    merklePath,
    bulletinRootAtCast: proof.bulletinRootAtCast,
  };
}

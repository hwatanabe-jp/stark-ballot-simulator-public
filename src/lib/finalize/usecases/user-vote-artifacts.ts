import type { FinalizationResultAuthority, SessionData } from '@/types/server';
import type { FinalizeSyncResponse } from '@/lib/validation/apiSchemas';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@/lib/utils/hex';

export class UserVoteArtifactsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserVoteArtifactsUnavailableError';
  }
}

export type UserVoteArtifacts = {
  bulletinRoot: string;
  inputCommitment: string;
  voteReceipt: FinalizeSyncResponse['data']['voteReceipt'];
  userVoteProof: FinalizeSyncResponse['data']['userVote'];
};

export function buildUserVoteArtifacts(params: {
  session: SessionData;
  finalizationResult: FinalizationResultAuthority;
}): UserVoteArtifacts {
  const { session, finalizationResult } = params;
  const userVoteIndex = session.userVoteIndex;
  if (typeof userVoteIndex !== 'number') {
    throw new UserVoteArtifactsUnavailableError('User vote index is missing for finalization');
  }

  const voteData = session.votes.get(userVoteIndex);
  if (!voteData) {
    throw new UserVoteArtifactsUnavailableError('Exact user vote record is missing for finalization');
  }
  if (!voteData.voteId) {
    throw new UserVoteArtifactsUnavailableError('Vote identifier is missing for user vote');
  }

  const bulletin = session.bulletin;
  if (!bulletin || typeof bulletin.getInclusionProof !== 'function') {
    throw new UserVoteArtifactsUnavailableError('Bulletin inclusion proof function unavailable for user vote');
  }

  const castTreeSize = userVoteIndex + 1;
  const inclusionProof = bulletin.getInclusionProof(voteData.voteId, castTreeSize);
  if (!inclusionProof || !Array.isArray(inclusionProof.proofNodes)) {
    throw new UserVoteArtifactsUnavailableError('Bulletin inclusion proof unavailable for user vote');
  }
  if (inclusionProof.leafIndex !== userVoteIndex) {
    throw new Error('User vote inclusion proof leaf index mismatch');
  }
  if (inclusionProof.treeSize !== castTreeSize) {
    throw new Error('User vote inclusion proof tree size mismatch');
  }

  const finalMerklePath = inclusionProof.proofNodes.map((node: string) => addHexPrefix(node));
  const proofTreeSize = inclusionProof.treeSize;

  const normalizeHex32 = (value: string | undefined, label: string): string => {
    if (!isValidHexString(value ?? '', 32)) {
      throw new Error(`Invalid ${label} (expected 32-byte hex)`);
    }
    return addHexPrefix(normalizeHexString(value ?? ''));
  };

  const normalizedCommitment = normalizeHex32(voteData.commit, 'user commitment');
  const bulletinRoot = normalizeHex32(finalizationResult.journal.bulletinRoot, 'bulletinRoot');
  const inputCommitment = normalizeHex32(finalizationResult.journal.inputCommitment, 'inputCommitment');
  if (!voteData.rootAtCast) {
    throw new UserVoteArtifactsUnavailableError('Exact cast-time bulletin root is missing for user vote');
  }
  const bulletinRootAtCast = normalizeHex32(voteData.rootAtCast, 'bulletinRootAtCast');
  const proofRootAtCast = normalizeHex32(inclusionProof.rootHash, 'proof bulletinRootAtCast');
  if (bulletinRootAtCast !== proofRootAtCast) {
    throw new UserVoteArtifactsUnavailableError('Stored cast root does not match exact cast-time inclusion proof root');
  }

  const voteReceipt: FinalizeSyncResponse['data']['voteReceipt'] = {
    voteId: voteData.voteId,
    commitment: normalizedCommitment,
    bulletinIndex: inclusionProof.leafIndex,
    bulletinRootAtCast,
    timestamp: voteData.timestamp ?? Date.now(),
    inputCommitment,
  };

  const userVoteProof: FinalizeSyncResponse['data']['userVote'] = {
    commitment: normalizedCommitment,
    voteId: voteData.voteId,
    proof: {
      leafIndex: inclusionProof.leafIndex,
      merklePath: finalMerklePath,
      treeSize: proofTreeSize,
      bulletinRootAtCast,
    },
  };

  return {
    bulletinRoot,
    inputCommitment,
    voteReceipt,
    userVoteProof,
  };
}

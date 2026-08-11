import type { FinalizationResultAuthority } from '../finalize/finalization-types';
import { isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';

export type VerificationReadFailure =
  | {
      availability: 'unavailable';
      reason: 'finalization_not_current' | 'user_vote_unavailable';
    }
  | {
      availability: 'corrupt';
      reason:
        'invalid_artifact' | 'incomplete_session_authority' | 'session_identity_mismatch' | 'voter_evidence_mismatch';
    };

export interface VerificationReadSource {
  sessionId: string;
  electionId?: string;
  electionConfigHash?: string;
  logId?: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  userVote?: {
    index: number;
    voteId?: string;
    commitment: string;
  };
  finalization: {
    finalizationId: string;
    authority: FinalizationResultAuthority;
  };
}

export interface AvailableVerificationVoterEvidence {
  availability: 'available';
  voteReceipt: {
    voteId: string;
    commitment: string;
    bulletinIndex: number;
    bulletinRootAtCast: string;
    castAtMs: number;
    inputCommitment?: string;
  };
  userVote: {
    commitment: string;
    voteId: string;
    proof: {
      leafIndex: number;
      treeSize: number;
      merklePath: string[];
      bulletinRootAtCast: string;
    };
  };
}

export interface UnavailableVerificationVoterEvidence {
  availability: 'unavailable';
  reason: 'vote_id_unavailable' | 'exact_proof_unavailable';
  userVote: {
    commitment: string;
    voteId?: string;
  };
}

export type VerificationVoterEvidence = AvailableVerificationVoterEvidence | UnavailableVerificationVoterEvidence;

export type VerificationReadSourceResult =
  | {
      availability: 'available';
      source: VerificationReadSource;
    }
  | VerificationReadFailure;

export interface UnavailableExactVoterEvidenceRead {
  availability: 'unavailable';
  reason: 'exact_proof_unavailable';
}

export type ExactVoterEvidenceReadResult =
  | AvailableVerificationVoterEvidence
  | UnavailableExactVoterEvidenceRead
  | Extract<VerificationReadFailure, { availability: 'corrupt' }>;

export interface VerificationReadPort {
  readCurrent: (sessionId: string) => Promise<VerificationReadSourceResult>;
  readExactVoterEvidence: (input: {
    sessionId: string;
    voteId: string;
    voteIndex: number;
    expectedCommitment: string;
  }) => Promise<ExactVoterEvidenceReadResult>;
}

export type PreparedVerificationRead =
  | {
      availability: 'available';
      source: VerificationReadSource & {
        electionId: string;
        electionConfigHash: string;
        logId: string;
        userVote: NonNullable<VerificationReadSource['userVote']>;
      };
      voterEvidence: VerificationVoterEvidence;
    }
  | VerificationReadFailure;

function isCompleteSessionAuthority(source: VerificationReadSource): source is VerificationReadSource & {
  electionId: string;
  electionConfigHash: string;
  logId: string;
  userVote: NonNullable<VerificationReadSource['userVote']>;
} {
  const { electionId, electionConfigHash, logId, userVote } = source;
  if (
    typeof electionId !== 'string' ||
    electionId.length === 0 ||
    typeof electionConfigHash !== 'string' ||
    !isValidHexString(electionConfigHash, 32) ||
    typeof logId !== 'string' ||
    !isValidHexString(logId, 32) ||
    !userVote ||
    !Number.isSafeInteger(userVote.index) ||
    userVote.index < 0 ||
    !isValidHexString(userVote.commitment, 32)
  ) {
    return false;
  }

  const { journal } = source.finalization.authority;
  return (
    journal.electionId === electionId &&
    isValidHexString(journal.electionConfigHash, 32) &&
    normalizeHexString(journal.electionConfigHash) === normalizeHexString(electionConfigHash)
  );
}

function hasMatchingExactVoterEvidence(
  evidence: AvailableVerificationVoterEvidence,
  source: VerificationReadSource & {
    userVote: NonNullable<VerificationReadSource['userVote']>;
  },
): boolean {
  const { userVote } = source;
  return (
    evidence.voteReceipt.voteId === userVote.voteId &&
    evidence.userVote.voteId === userVote.voteId &&
    evidence.voteReceipt.bulletinIndex === userVote.index &&
    evidence.userVote.proof.leafIndex === userVote.index &&
    normalizeHexString(evidence.voteReceipt.commitment) === normalizeHexString(userVote.commitment) &&
    normalizeHexString(evidence.userVote.commitment) === normalizeHexString(userVote.commitment)
  );
}

export async function prepareVerificationRead(
  input: {
    sessionId: string;
    finalizationId: string;
  },
  port: VerificationReadPort,
): Promise<PreparedVerificationRead> {
  const current = await port.readCurrent(input.sessionId);
  if (current.availability !== 'available') {
    return current;
  }

  const { source } = current;
  if (source.sessionId !== input.sessionId) {
    return {
      availability: 'corrupt',
      reason: 'session_identity_mismatch',
    };
  }
  if (source.finalization.finalizationId !== input.finalizationId) {
    return {
      availability: 'unavailable',
      reason: 'finalization_not_current',
    };
  }
  if (!isCompleteSessionAuthority(source)) {
    return {
      availability: 'corrupt',
      reason: 'incomplete_session_authority',
    };
  }

  if (!source.userVote.voteId) {
    return {
      availability: 'available',
      source,
      voterEvidence: {
        availability: 'unavailable',
        reason: 'vote_id_unavailable',
        userVote: {
          commitment: source.userVote.commitment,
        },
      },
    };
  }

  const voterEvidence = await port.readExactVoterEvidence({
    sessionId: input.sessionId,
    voteId: source.userVote.voteId,
    voteIndex: source.userVote.index,
    expectedCommitment: source.userVote.commitment,
  });
  if (voterEvidence.availability === 'corrupt') {
    return voterEvidence;
  }
  if (voterEvidence.availability === 'available' && !hasMatchingExactVoterEvidence(voterEvidence, source)) {
    return {
      availability: 'corrupt',
      reason: 'voter_evidence_mismatch',
    };
  }

  return {
    availability: 'available',
    source,
    voterEvidence:
      voterEvidence.availability === 'available'
        ? voterEvidence
        : {
            ...voterEvidence,
            userVote: {
              commitment: source.userVote.commitment,
              voteId: source.userVote.voteId,
            },
          },
  };
}

import type { SessionIdentityRecord, SessionVotingRecord, StoredVoteRecord } from './sessionRecords';
import type { RecordVerificationObservationResult, VerificationObservationWrite } from './verificationObservation';
import type { SessionId } from './identifiers';

/**
 * Lightweight voting projection for polling endpoints. Finalization status is
 * projected by the application from its separately owned record.
 */
export type SessionVotingSummary = {
  sessionId: SessionId;
  botCount: number;
  userParticipation: SessionVotingRecord['userParticipation'];
};

export interface SessionIdentityStore {
  /**
   * Atomically creates complete identity and empty voting records.
   */
  createSession(): Promise<SessionIdentityRecord>;

  getSessionIdentity(sessionId: SessionId): Promise<SessionIdentityRecord | null>;
}

export interface SessionVotingStore {
  getVotingRecord(sessionId: SessionId): Promise<SessionVotingRecord | null>;

  getSessionVotingSummary?(sessionId: SessionId): Promise<SessionVotingSummary | null>;

  touchSession(sessionId: SessionId): Promise<void>;

  getActiveSessionCount(): Promise<number>;

  getVoteById(sessionId: SessionId, voteId: string): Promise<{ voteData: StoredVoteRecord; index: number } | null>;

  getVoteByIdWithProof(
    sessionId: SessionId,
    voteId: string,
  ): Promise<{
    voteData: StoredVoteRecord;
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null>;

  getVoteProof(voteId: string): Promise<{
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null>;
}

export interface VerificationObservationStore {
  recordVerificationObservation(
    sessionId: SessionId,
    finalizationId: string,
    observation: VerificationObservationWrite,
  ): Promise<RecordVerificationObservationResult>;
}

export type VoteStore = SessionIdentityStore & SessionVotingStore & VerificationObservationStore;

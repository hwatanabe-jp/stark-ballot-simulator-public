import type {
  AddVoteResult,
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
  VoteData,
} from './sessionRecords';
import type { RecordVerificationObservationResult, VerificationObservationWrite } from './verificationObservation';

/**
 * Lightweight voting projection for polling endpoints. Finalization status is
 * projected by the application from its separately owned record.
 */
export type SessionVotingSummary = {
  sessionId: string;
  botCount: number;
  userParticipation: SessionVotingRecord['userParticipation'];
};

export interface SessionIdentityStore {
  /**
   * Atomically creates complete identity and empty voting records.
   */
  createSession(): Promise<SessionIdentityRecord>;

  getSessionIdentity(sessionId: string): Promise<SessionIdentityRecord | null>;
}

export interface SessionVotingStore {
  getVotingRecord(sessionId: string): Promise<SessionVotingRecord | null>;

  getSessionVotingSummary?(sessionId: string): Promise<SessionVotingSummary | null>;

  addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult>;

  addBotVotes(sessionId: string, votes: VoteData[]): Promise<void>;

  touchSession(sessionId: string): Promise<void>;

  getActiveSessionCount(): Promise<number>;

  getVoteById(sessionId: string, voteId: string): Promise<{ voteData: StoredVoteRecord; index: number } | null>;

  getVoteByIdWithProof(
    sessionId: string,
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
    sessionId: string,
    finalizationId: string,
    observation: VerificationObservationWrite,
  ): Promise<RecordVerificationObservationResult>;
}

export type VoteStore = SessionIdentityStore & SessionVotingStore & VerificationObservationStore;

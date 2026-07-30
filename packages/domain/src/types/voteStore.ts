/**
 * VoteStore interface defining the contract for all session store implementations
 */

import type { CurrentArtifactState } from '@stark-ballot/domain/contract';
import type { VoteData, SessionData, AddVoteResult } from './server';
import type { RecordVerificationObservationResult, VerificationObservation } from './verificationObservation';

/**
 * Lightweight session summary for polling endpoints.
 */
export type SessionSummary = {
  sessionId: string;
  botCount: number;
  contractGeneration?: string;
  finalizationArtifactState?: CurrentArtifactState;
  userVoteIndex?: number;
  finalized: boolean;
};

export type SessionStoreUpdate = Partial<
  Pick<SessionData, 'electionId' | 'electionConfigHash' | 'electionConfig' | 'logId'>
>;

/**
 * Interface for session/vote storage implementations
 *
 * This interface defines the contract that all storage implementations
 * (MockSessionStore, DynamoSessionStore, etc.) must follow.
 */
export interface VoteStore {
  /**
   * Create a new voting session
   * @returns The created session data
   */
  createSession(): Promise<SessionData>;

  /**
   * Get a session by its ID
   * @param sessionId - The unique session identifier
   * @returns The session data or null if not found
   */
  getSession(sessionId: string): Promise<SessionData | null>;

  /**
   * Get a minimal session summary without vote data.
   * @param sessionId - The unique session identifier
   * @returns The session summary or null if not found
   */
  getSessionSummary?(sessionId: string): Promise<SessionSummary | null>;

  /**
   * Add a single vote to a session
   * @param sessionId - The session to add the vote to
   * @param voteData - The vote data to add
   * @returns The result containing leaf index and Merkle path
   */
  addVote(sessionId: string, voteData: VoteData): Promise<AddVoteResult>;

  /**
   * Add multiple bot votes to a session
   * @param sessionId - The session to add votes to
   * @param votes - Array of vote data from bots
   */
  addBotVotes(sessionId: string, votes: VoteData[]): Promise<void>;

  /**
   * Update session data
   * @param sessionId - The session to update
   * @param data - Partial session data to update
   * @returns The updated session data or void
   */
  updateSession(sessionId: string, data?: SessionStoreUpdate): Promise<SessionData | void>;

  /**
   * Record the first browser verification observation for the current execution.
   */
  recordVerificationObservation(
    sessionId: string,
    observation: VerificationObservation,
  ): Promise<RecordVerificationObservationResult>;

  /**
   * Get the count of active sessions
   * @returns The number of active sessions
   */
  getActiveSessionCount(): Promise<number>;

  /**
   * Get a vote by its unique ID
   * @param sessionId - The session containing the vote
   * @param voteId - The unique vote identifier
   * @returns The vote data and index, or null if not found
   */
  getVoteById(sessionId: string, voteId: string): Promise<{ voteData: VoteData; index: number } | null>;

  /**
   * Get a vote with its inclusion proof
   * @param sessionId - The session containing the vote
   * @param voteId - The unique vote identifier
   * @returns The vote data with proof information, or null if the vote does not belong to the session
   * @throws Error('CT_PROOF_UNAVAILABLE') when the vote belongs to the session but exact CT evidence is unavailable
   */
  getVoteByIdWithProof(
    sessionId: string,
    voteId: string,
  ): Promise<{
    voteData: VoteData;
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null>;

  /**
   * Get the proof for a specific vote
   * @param voteId - The unique vote identifier
   * @returns The proof data containing leaf index, Merkle path, and root
   */
  getVoteProof(voteId: string): Promise<{
    leafIndex: number;
    merklePath: string[];
    bulletinRootAtCast: string;
    treeSize: number;
  } | null>;
}

/**
 * VoteStore interface defining the contract for all session store implementations
 */

import type { CurrentArtifactState } from '@/lib/contract';
import type { VoteData, SessionData, AddVoteResult, FinalizationState, FinalizationResultAuthority } from './server';

type FinalizationSucceededMetadata = Extract<FinalizationState, { status: 'succeeded' }>['bundleMetadata'];
type FinalizationFailedError = Extract<FinalizationState, { status: 'failed' }>['error'];

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

/**
 * Interface for session/vote storage implementations
 *
 * This interface defines the contract that all storage implementations
 * (MockSessionStore, AmplifySessionStore, etc.) must follow.
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
  updateSession(sessionId: string, data?: Partial<SessionData>): Promise<SessionData | void>;

  /**
   * Get the count of active sessions
   * @returns The number of active sessions
   */
  getActiveSessionCount(): Promise<number>;

  /**
   * Finalize a voting session with results
   * @param sessionId - The session to finalize
   * @param result - The finalization result data
   * @param contractGeneration - The carried contract generation for this write
   */
  finalizeSession(sessionId: string, result: FinalizationResultAuthority, contractGeneration: string): Promise<void>;

  /**
   * Record the queued state for an async finalization execution.
   */
  markFinalizationQueued(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      contractGeneration: string;
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState>;

  /**
   * Record when the async finalization begins processing.
   */
  markFinalizationRunning(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt: number;
      contractGeneration: string;
      stepFunctionsArn?: string;
      scenarioContext?: SessionData['finalizationScenarioContext'] | null;
    },
  ): Promise<FinalizationState>;

  /**
   * Record a successful async finalization completion.
   */
  markFinalizationSucceeded(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt: number;
      completedAt: number;
      contractGeneration: string;
      bundleMetadata?: FinalizationSucceededMetadata;
      stepFunctionsArn?: string;
      finalizationResult: FinalizationResultAuthority;
    },
  ): Promise<FinalizationState>;

  /**
   * Record a failed async finalization attempt.
   */
  markFinalizationFailed(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      failedAt: number;
      contractGeneration: string;
      error: FinalizationFailedError;
      stepFunctionsArn?: string;
    },
  ): Promise<FinalizationState>;

  /**
   * Record a timeout for an async finalization attempt.
   */
  markFinalizationTimedOut(
    sessionId: string,
    payload: {
      executionId: string;
      queuedAt: number;
      startedAt?: number;
      timeoutAt: number;
      contractGeneration: string;
      stepFunctionsArn?: string;
    },
  ): Promise<FinalizationState>;

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

  /**
   * Save bitmap data after finalization
   * @param sessionId - The session ID
   * @param bitmapData - The bitmap data to store
   */
  saveBitmapData?(
    sessionId: string,
    bitmapData: {
      includedBitmap: boolean[];
      includedBitmapRoot: string;
      seenBitmap?: boolean[];
      seenBitmapRoot?: string;
      treeSize: number;
      finalizedAt: number;
    },
  ): Promise<void>;

  /**
   * Get stored bitmap data
   * @param sessionId - The session ID
   * @returns The stored bitmap data or null if not found
   */
  getBitmapData?(sessionId: string): Promise<{
    sessionId: string;
    includedBitmap: boolean[];
    includedBitmapRoot: string;
    seenBitmap?: boolean[];
    seenBitmapRoot?: string;
    treeSize: number;
    finalizedAt: number;
  } | null>;

  /**
   * Save receipt to bulletin board
   * @param sessionId - The session ID
   * @param receipt - The receipt data to save
   * @returns The receipt hash and board index
   */
  saveReceiptToBoard?(
    sessionId: string,
    receipt: { receipt: string; timestamp: number },
  ): Promise<{ receiptHash: string; boardIndex: number }>;
}

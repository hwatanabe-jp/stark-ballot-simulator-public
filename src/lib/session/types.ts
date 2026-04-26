import type { ClientFinalizationSnapshot } from '@/lib/finalize/client-finalization-result';

export type VoteChoice = 'A' | 'B' | 'C' | 'D' | 'E';

export type SessionPhase = 'voting' | 'finalizing' | 'verifying';

export interface SessionData {
  sessionId: string;
  capabilityToken: string;
  contractGeneration?: string;
  lastActivity: number;
  expiresAt?: number;
  phase?: SessionPhase;
  electionId?: string;
  electionConfigHash?: string;
  logId?: string;
  myVote?: VoteChoice;
  myCommit?: string;
  myRand?: string;
  /** Unique vote identifier returned after casting a vote */
  voteId?: string;
  /** Bulletin index assigned at cast time */
  bulletinIndex?: number;
  /** Bulletin root at cast time (hex string) */
  bulletinRootAtCast?: string;
  /** Timestamp when user triggered STARK verification from result page */
  verificationRequestedAt?: number;
  finalizeResult?: ClientFinalizationSnapshot;
}

export interface SessionManager {
  generateSessionId(initialSessionId: string | undefined, capabilityToken: string, contractGeneration?: string): string;
  checkTimeout(): boolean;
  clearSession(): void;
  updateLastActivity(): void;
  getSessionData(): SessionData | null;
  saveSessionData(data: Partial<SessionData>): void;
}

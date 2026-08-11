import type { ClientFinalizationSnapshot } from '@stark-ballot/web/finalize/client-finalization-result';

export type VoteChoice = 'A' | 'B' | 'C' | 'D' | 'E';

export type SessionPhase = 'voting' | 'finalizing' | 'verifying';

export interface ServerIssuedSessionIdentity {
  sessionId: string;
  capabilityToken: string;
  electionId: string;
  electionConfigHash: string;
  logId: string;
}

interface BrowserSessionRecordBase extends ServerIssuedSessionIdentity {
  lastActivity: number;
  expiresAt: number;
  myVote?: VoteChoice;
  myCommit?: string;
  myRand?: string;
  /** Unique vote identifier returned after casting a vote */
  voteId?: string;
  /** Bulletin index assigned at cast time */
  bulletinIndex?: number;
  /** Bulletin root at cast time (hex string) */
  bulletinRootAtCast?: string;
}

interface ActiveBrowserSessionRecord extends BrowserSessionRecordBase {
  phase: 'voting' | 'finalizing';
  finalizeResult?: never;
  verificationRequestedAt?: never;
}

interface VerifyingBrowserSessionRecord extends BrowserSessionRecordBase {
  phase: 'verifying';
  /** Timestamp when user triggered STARK verification from result page */
  verificationRequestedAt?: number;
  finalizeResult: ClientFinalizationSnapshot;
}

export type SessionData = ActiveBrowserSessionRecord | VerifyingBrowserSessionRecord;

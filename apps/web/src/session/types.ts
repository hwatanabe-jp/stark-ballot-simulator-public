import type { BrowserSessionIdentity } from './identity';
import type { ClientFinalizationSnapshot } from '@stark-ballot/web/finalize/client-finalization-result';
import type { VoteChoice } from '@stark-ballot/verification/shared/constants';

export type { VoteChoice };

export type SessionPhase = 'voting' | 'finalizing' | 'verifying';

export interface ServerIssuedSessionIdentity extends BrowserSessionIdentity {
  electionId: string;
  electionConfigHash: string;
  logId: string;
}

interface BrowserSessionRecordBase extends ServerIssuedSessionIdentity {
  lastActivity: number;
  expiresAt: number;
}

export type PrivateOpening =
  | { myVote: VoteChoice; myCommit: string; myRand: string }
  | { myVote?: never; myCommit?: never; myRand?: never };

export type CastReceipt =
  | {
      /** Unique vote identifier returned after casting a vote */
      voteId: string;
      /** Bulletin index assigned at cast time */
      bulletinIndex: number;
      /** Bulletin root at cast time (hex string) */
      bulletinRootAtCast: string;
    }
  | { voteId?: never; bulletinIndex?: never; bulletinRootAtCast?: never };

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

export type SessionData = (ActiveBrowserSessionRecord | VerifyingBrowserSessionRecord) & PrivateOpening & CastReceipt;

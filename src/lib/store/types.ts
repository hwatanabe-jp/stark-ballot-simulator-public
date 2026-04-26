/**
 * Store types for session management
 */

import type { VoteChoice } from '@/shared/constants';
import type { ZkVMJournal } from '@/lib/zkvm/types';
import type { SimpleBulletinBoard } from '@/lib/bulletin/simple-bulletin-board';

/**
 * Vote data stored in session
 */
export interface VoteData {
  commit: string;
  vote: VoteChoice;
  rand: string;
}

/**
 * Bulletin root history entry
 */
export interface BulletinRootEntry {
  root: string;
  timestamp: number;
  voteCount: number;
}

/**
 * Session data structure
 */
export interface SessionData {
  sessionId: string;
  votes: Map<number, VoteData>;
  bulletin?: SimpleBulletinBoard;
  bulletinRootHistory: BulletinRootEntry[];
  userVoteIndex?: number;
  botCount: number;
  finalized: boolean;
  createdAt: number;
  lastActivity: number;
  finalizedAt?: number;

  // Optional fields for zkVM results
  receipt?: string;
  zkVMJournal?: ZkVMJournal;
}

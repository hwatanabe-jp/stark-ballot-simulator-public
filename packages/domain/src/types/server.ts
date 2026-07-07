import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import type { FailClosedCurrentArtifactState } from '@stark-ballot/domain/contract/currentArtifact';
import type { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import type { ScenarioTamperMode } from '@stark-ballot/domain/types/scenario';
import type { FinalizationResultPersistence, FinalizationStatePersistence } from './finalization';

export interface ElectionConfig {
  totalExpected: number;
  choices: readonly string[];
  version: string;
  botCount: number;
  merkleTreeDepth: number;
}

export interface FinalizationScenarioContext {
  scenarios: string[];
  tamperMode: ScenarioTamperMode;
  claimedCounts: Record<VoteChoice, number>;
  claimedTotalVotes: number;
  summary: {
    ignoredCount: number;
    recountedCount: number;
    userRecountChoice: VoteChoice | null;
    affectedBotIds?: number[];
  };
}

/**
 * Data structure for individual votes in the STARK Ballot Simulator system
 */
export interface VoteData {
  /** Unique vote identifier (UUID v4) for tracking and auditing */
  voteId?: string;
  /** The voter's choice (A, B, C, D, or E) */
  vote: VoteChoice;
  /** Random value used in commitment generation */
  rand: string;
  /** Domain-separated SHA-256 commitment (v1.0) */
  commit: string;
  /** Merkle tree path for inclusion proof */
  path: string[];
  /** Unix timestamp in milliseconds when the vote was cast */
  timestamp?: number;
  /** Bulletin board root snapshot at the moment of casting */
  rootAtCast?: string;
  /** Tree size associated with the proof (required for CT proofs) */
  treeSize?: number;
}

/**
 * Root snapshot for bulletin board history tracking
 */
export interface RootSnapshot {
  timestamp: number;
  root: string;
  treeSize: number;
  signature?: string;
}

export interface SessionData {
  sessionId: string;
  contractGeneration?: string;
  finalizationContractGeneration?: string;
  hasPersistedFinalizationBranch?: boolean;
  finalizationArtifactState?: FailClosedCurrentArtifactState;
  /** Election identifier (UUID v4) for this voting session */
  electionId?: string;
  /** Hash of election configuration (includes totalExpected) */
  electionConfigHash?: string;
  /** Canonical election configuration when available for manifest generation */
  electionConfig?: ElectionConfig;
  /** Log identifier for bulletin board (RFC 6962) */
  logId?: string;
  votes: Map<number, VoteData>;
  /** Public bulletin board for recording all vote commitments */
  bulletin?: SimpleBulletinBoard;
  botCount: number;
  finalized: boolean;
  createdAt: number;
  lastActivity: number;
  userVoteIndex?: number;
  /** History of Merkle root snapshots for append-only verification */
  bulletinRootHistory?: RootSnapshot[];
  finalizationResult?: FinalizationResultPersistence;

  /**
   * Async finalize state machine (pending → running → terminal).
   */
  finalizationState?: FinalizationStatePersistence;

  /**
   * Scenario context persisted during async finalization (claimed tally, summary, mode).
   */
  finalizationScenarioContext?: FinalizationScenarioContext;
}

export interface AddVoteResult {
  leafIndex: number;
  merklePath: string[];
  bulletinRootAtCast: string;
}

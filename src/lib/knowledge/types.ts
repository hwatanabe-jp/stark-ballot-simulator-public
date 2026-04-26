import type { VoteChoice } from '../session/types';

/**
 * Knowledge phases corresponding to the voting flow
 */
export type KnowledgePhase = 'session' | 'vote' | 'result' | 'verify';

/**
 * Verification step statuses
 */
export type VerificationStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'not_run';

/**
 * Verification step identifiers (final_design vocabulary)
 */
export type VerificationStepId = 'cast_as_intended' | 'recorded_as_cast' | 'counted_as_recorded' | 'stark_verification';

/**
 * Proof bundle download status
 */
export type ProofBundleStatus = 'not_downloaded' | 'downloaded';

/**
 * Tamper scenario identifier
 */
export type ScenarioId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

/**
 * Bot voting status (UI-generated)
 */
export type BotVotesStatus = 'pending' | 'completed' | { status: 'pending' | 'completed'; total?: number };

/**
 * Inclusion proof structure (final_design vocabulary)
 */
export interface InclusionProof {
  leafIndex: number;
  treeSize: number;
  merklePath: string[];
  bulletinRootAtCast: string;
}

/**
 * Verification step result
 */
export interface VerificationStep {
  id: VerificationStepId;
  status: VerificationStepStatus;
  inputs: string[];
  error?: string;
}

/**
 * Verification report summary
 */
export interface VerificationReportSummary {
  status: string;
  duration_ms?: number;
  errors?: string[];
}

/**
 * Tally counts structure
 */
export interface TallyCounts {
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
}

/**
 * Vote receipt structure
 */
export interface VoteReceipt {
  voteId: string;
  commitment: string;
  bulletinIndex: number;
  bulletinRootAtCast: string;
  timestamp: number;
  inputCommitment?: string;
}

/**
 * Receipt publication info
 */
export interface ReceiptPublication {
  receiptHash: string;
  boardIndex: number;
}

/**
 * Knowledge data structure - all known information
 * Keys follow final_design.md vocabulary with user./bot. scope prefixes
 */
export interface KnowledgeData {
  // ── Session phase ──────────────────────────────────────────────────────────
  sessionId?: string;
  electionId?: string;
  electionConfigHash?: string;
  logId?: string;

  // ── Vote phase (user scoped) ───────────────────────────────────────────────
  'user.choice'?: VoteChoice;
  'user.random'?: string;
  'user.commitment'?: string;
  'user.voteId'?: string;
  'user.bulletinIndex'?: number;
  'user.bulletinRootAtCast'?: string;
  'user.voteTimestamp'?: number;
  botVotesStatus?: BotVotesStatus;
  scenarioId?: ScenarioId;

  // ── Result phase ───────────────────────────────────────────────────────────
  'tally.counts'?: TallyCounts;
  'tally.totalVotes'?: number;
  'tally.tamperedCount'?: number;
  missingSlots?: number;
  invalidPresentedSlots?: number;
  rejectedRecords?: number;
  validVotes?: number;
  excludedSlots?: number;
  totalExpected?: number;
  bulletinRoot?: string;
  treeSize?: number;
  sthDigest?: string;
  seenBitmapRoot?: string;
  includedBitmapRoot?: string;
  inputCommitment?: string;
  imageId?: string;
  receiptPublication?: ReceiptPublication;
  proofBundleStatus?: ProofBundleStatus;

  // ── Verify phase ───────────────────────────────────────────────────────────
  'user.voteReceipt'?: VoteReceipt;
  'user.merklePath'?: InclusionProof;
  'verification.steps'?: VerificationStep[];
  'verification.reportSummary'?: VerificationReportSummary;

  // ── Bot verification (scoped, on-demand) ───────────────────────────────────
  'bot.id'?: number;
  'bot.choice'?: VoteChoice;
  'bot.random'?: string;
  'bot.commitment'?: string;
  'bot.voteId'?: string;
  'bot.bulletinIndex'?: number;
  'bot.bulletinRootAtCast'?: string;
  'bot.voteTimestamp'?: number;
  'bot.merklePath'?: InclusionProof;
  'bot.verification.steps'?: VerificationStep[];
}

/**
 * Knowledge item for display in the panel
 */
export interface KnowledgeItem {
  key: keyof KnowledgeData;
  value: unknown;
  isNew: boolean;
  addedAt: number;
}

/**
 * Listener for knowledge updates
 */
export type KnowledgeUpdateListener = (items: KnowledgeItem[], phase: KnowledgePhase) => void;

/**
 * All valid knowledge keys
 */
export const KNOWLEDGE_KEYS = [
  // Session
  'sessionId',
  'electionId',
  'electionConfigHash',
  'logId',
  // Vote
  'user.choice',
  'user.random',
  'user.commitment',
  'user.voteId',
  'user.bulletinIndex',
  'user.bulletinRootAtCast',
  'user.voteTimestamp',
  'botVotesStatus',
  'scenarioId',
  // Result
  'tally.counts',
  'tally.totalVotes',
  'tally.tamperedCount',
  'missingSlots',
  'invalidPresentedSlots',
  'rejectedRecords',
  'validVotes',
  'excludedSlots',
  'totalExpected',
  'bulletinRoot',
  'treeSize',
  'sthDigest',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'inputCommitment',
  'imageId',
  'receiptPublication',
  'proofBundleStatus',
  // Verify
  'user.voteReceipt',
  'user.merklePath',
  'verification.steps',
  'verification.reportSummary',
  // Bot
  'bot.id',
  'bot.choice',
  'bot.random',
  'bot.commitment',
  'bot.voteId',
  'bot.bulletinIndex',
  'bot.bulletinRootAtCast',
  'bot.voteTimestamp',
  'bot.merklePath',
  'bot.verification.steps',
] as const satisfies readonly (keyof KnowledgeData)[];

/**
 * Hash fields that should be displayed with truncation
 */
export const HASH_FIELDS: readonly (keyof KnowledgeData)[] = [
  'electionConfigHash',
  'user.random',
  'user.commitment',
  'user.bulletinRootAtCast',
  'bulletinRoot',
  'sthDigest',
  'seenBitmapRoot',
  'includedBitmapRoot',
  'inputCommitment',
  'imageId',
  'bot.random',
  'bot.commitment',
  'bot.bulletinRootAtCast',
];

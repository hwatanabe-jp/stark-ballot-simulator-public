import type { VoteChoice } from '@/shared/constants';

export interface Receipt {
  tally: Record<VoteChoice, number>;
  bulletinRoot: string;
  /**
   * Claimed tally total from the presentation layer.
   * This differs from the journal's `total_votes`, which counts presented input
   * records rather than the claimed UI tally projection.
   * Slot-based omission authority comes from `missingSlots`, not this field.
   */
  totalVotes: number;
  tamperedCount: number;
  /**
   * Count of slots omitted from zkVM input (expected tree size minus seen slots).
   * When正 > 0、静かな除外のシグナルとして扱う。
   */
  missingSlots?: number;
  /**
   * Count of presented in-range slots that still failed counting.
   */
  invalidPresentedSlots?: number;
  /**
   * Count of rejected records, including duplicates and out-of-range entries.
   */
  rejectedRecords?: number;
  /**
   * Slot-based fail-closed exclusion signal.
   */
  excludedSlots?: number;
  /** Number of votes successfully tallied by the zkVM. */
  validVotes?: number;
  /**
   * Verified tally emitted by the zkVM journal (A-E 順の配列)。
   * claimed tally と比較することで再集計シナリオを特定する。
   */
  verifiedTally?: number[];
  botTamperInfo?: {
    originalChoice: VoteChoice;
    recountedTo: VoteChoice;
    count: number;
  };
  randomError?: boolean;
}

export interface VoteData {
  commitment: string;
  path: string[];
  leafIndex: number;
  choice: VoteChoice;
  random: string;
  treeSize?: number;
}

export interface TamperDetectionResult {
  isTampered: boolean;
  detectedScenarios: string[];
  details: {
    ignoreUserVote: boolean;
    recountUserAsOther: boolean;
    recountedTo?: VoteChoice;
    ignoreBotVotes: boolean;
    ignoredBotCount?: number;
    recountBotVotes: boolean;
    recountedBotInfo?: {
      originalChoice: VoteChoice;
      recountedTo: VoteChoice;
      count: number;
    };
    randomErrors: boolean;
    indexAnomaly?: boolean;
    invalidPresentedSlotsCount?: number;
    missingSlotsCount?: number;
    validVotesCount?: number;
  };
}

/**
 * Duplicate Detection System
 * Ensures vote uniqueness using Set-based tracking
 */

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  duplicateType?: 'voteId' | 'commitment';
}

export interface BatchCheckResult {
  uniqueCount: number;
  duplicateCount: number;
  duplicates: Array<{
    voteId: string;
    type: 'voteId' | 'commitment';
  }>;
}

export interface DuplicateStatistics {
  totalChecks: number;
  uniqueVoteIds: number;
  uniqueCommitments: number;
  duplicateVoteIds: number;
  duplicateCommitments: number;
  duplicateRate?: number;
}

export interface DetectorState {
  voteIds: string[];
  commitments: string[];
}

export class DuplicateDetector {
  private voteIdSet: Set<string>;
  private commitmentSet: Set<string>;
  private totalChecks: number;
  private duplicateVoteIdCount: number;
  private duplicateCommitmentCount: number;

  constructor() {
    this.voteIdSet = new Set();
    this.commitmentSet = new Set();
    this.totalChecks = 0;
    this.duplicateVoteIdCount = 0;
    this.duplicateCommitmentCount = 0;
  }

  /**
   * Check for duplicate vote
   */
  checkDuplicate(voteId: string, commitment: string): DuplicateCheckResult {
    this.totalChecks++;

    const voteIdExists = this.voteIdSet.has(voteId);
    const commitmentExists = this.commitmentSet.has(commitment);

    if (voteIdExists) {
      this.duplicateVoteIdCount++;
      // Still try to add commitment if it's new
      if (!commitmentExists) {
        this.commitmentSet.add(commitment);
      }
      return { isDuplicate: true, duplicateType: 'voteId' };
    }

    if (commitmentExists) {
      this.duplicateCommitmentCount++;
      // Still add the voteId since it's new
      this.voteIdSet.add(voteId);
      return { isDuplicate: true, duplicateType: 'commitment' };
    }

    this.voteIdSet.add(voteId);
    this.commitmentSet.add(commitment);

    return { isDuplicate: false };
  }

  /**
   * Check batch of votes
   */
  checkBatch(votes: Array<{ voteId: string; commitment: string }>): BatchCheckResult {
    const duplicates: Array<{ voteId: string; type: 'voteId' | 'commitment' }> = [];

    for (const vote of votes) {
      const result = this.checkDuplicate(vote.voteId, vote.commitment);
      if (result.isDuplicate) {
        if (!result.duplicateType) {
          throw new Error('Duplicate type missing for detected duplicate');
        }
        duplicates.push({
          voteId: vote.voteId,
          type: result.duplicateType,
        });
      }
    }

    return {
      uniqueCount: votes.length - duplicates.length,
      duplicateCount: duplicates.length,
      duplicates,
    };
  }

  /**
   * Get statistics
   */
  getStatistics(): DuplicateStatistics {
    const stats: DuplicateStatistics = {
      totalChecks: this.totalChecks,
      uniqueVoteIds: this.voteIdSet.size,
      uniqueCommitments: this.commitmentSet.size,
      duplicateVoteIds: this.duplicateVoteIdCount,
      duplicateCommitments: this.duplicateCommitmentCount,
    };

    if (this.totalChecks > 0) {
      const totalDuplicates = this.duplicateVoteIdCount + this.duplicateCommitmentCount;
      stats.duplicateRate = (totalDuplicates / this.totalChecks) * 100;
    }

    return stats;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.voteIdSet.clear();
    this.commitmentSet.clear();
    this.totalChecks = 0;
    this.duplicateVoteIdCount = 0;
    this.duplicateCommitmentCount = 0;
  }

  /**
   * Export current state
   */
  exportState(): DetectorState {
    return {
      voteIds: Array.from(this.voteIdSet),
      commitments: Array.from(this.commitmentSet),
    };
  }

  /**
   * Import state
   */
  importState(state: DetectorState): void {
    this.clear();
    for (const voteId of state.voteIds) {
      this.voteIdSet.add(voteId);
    }
    for (const commitment of state.commitments) {
      this.commitmentSet.add(commitment);
    }
  }
}

export type TamperSeverity = 'none' | 'warning' | 'critical';

export type ClaimedTallyMismatchSource = 'none' | 'user' | 'bot' | 'unknown';

export interface TamperMetrics {
  missingSlots: number;
  invalidPresentedSlots: number;
  validVotes: number;
  excludedSlots?: number;
  totalExpected?: number;
  verifiedTally?: number[];
  claimedTallyMismatch?: boolean;
  claimedTallyMismatchSource?: Exclude<ClaimedTallyMismatchSource, 'none'>;
}

export interface TamperAssessment {
  tamperDetected: boolean;
  missingSlots: number;
  invalidPresentedSlots: number;
  validVotes: number;
  excludedSlots: number;
  claimedTallyMismatch: boolean;
  claimedTallyMismatchSource: ClaimedTallyMismatchSource;
  completenessRatio?: number;
  reasons: string[];
  severity: TamperSeverity;
  summary: string;
}

export interface TamperClassification {
  likelyScenario: 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
  confidence: number;
  summary: string;
}

export class TamperVerifier {
  evaluate(metrics: TamperMetrics): TamperAssessment {
    const missingSlots = Math.max(0, metrics.missingSlots);
    const invalidPresentedSlots = Math.max(0, metrics.invalidPresentedSlots);
    const validVotes = Math.max(0, metrics.validVotes);
    const excludedSlots = Math.max(0, metrics.excludedSlots ?? missingSlots + invalidPresentedSlots);
    const claimedTallyMismatch = metrics.claimedTallyMismatch === true;
    const claimedTallyMismatchSource: ClaimedTallyMismatchSource = claimedTallyMismatch
      ? (metrics.claimedTallyMismatchSource ?? 'unknown')
      : 'none';

    const reasons: string[] = [];
    let severity: TamperSeverity = 'none';
    const summaryParts: string[] = [];

    if (missingSlots > 0) {
      reasons.push('missingSlots');
      severity = 'critical';
      summaryParts.push(`${missingSlots} slots were never presented to the zkVM`);
    }

    if (invalidPresentedSlots > 0) {
      reasons.push('invalidPresentedSlots');
      if (severity === 'none') {
        severity = 'warning';
      }
      summaryParts.push(`${invalidPresentedSlots} presented slots failed zkVM validation`);
    }

    if (excludedSlots > 0 && missingSlots === 0 && invalidPresentedSlots === 0) {
      reasons.push('excludedSlots');
      severity = 'critical';
      summaryParts.push(`${excludedSlots} excluded slots were reported by the zkVM`);
    }

    if (claimedTallyMismatch) {
      reasons.push('claimedTallyMismatch');
      if (severity === 'none') {
        severity = 'warning';
      }
      summaryParts.push('Published tally disagrees with the verified tally');
    }

    const tamperDetected = reasons.length > 0;
    const completenessRatio = this.computeCompletenessRatio(metrics.totalExpected, validVotes);

    if (!tamperDetected) {
      summaryParts.push('No tampering indicators detected. All votes processed.');
    }

    return {
      tamperDetected,
      missingSlots,
      invalidPresentedSlots,
      validVotes,
      excludedSlots,
      claimedTallyMismatch,
      claimedTallyMismatchSource,
      completenessRatio,
      reasons,
      severity,
      summary: summaryParts.join(' '),
    };
  }

  classifyScenario(assessment: TamperAssessment): TamperClassification {
    if (!assessment.tamperDetected) {
      return {
        likelyScenario: 'S0',
        confidence: 1,
        summary: 'All exclusion metrics are zero - honest execution.',
      };
    }

    const { missingSlots, invalidPresentedSlots, claimedTallyMismatch, claimedTallyMismatchSource } = assessment;

    if (claimedTallyMismatch && missingSlots === 0 && invalidPresentedSlots === 0) {
      if (claimedTallyMismatchSource === 'user') {
        return {
          likelyScenario: 'S2',
          confidence: 0.8,
          summary: 'Claimed tally mismatch affects the user vote - likely claimed-tally tampering.',
        };
      }

      if (claimedTallyMismatchSource === 'bot') {
        return {
          likelyScenario: 'S4',
          confidence: 0.75,
          summary: 'Claimed tally mismatch affects a bot vote - likely claimed-tally tampering.',
        };
      }
    }

    if (missingSlots > 0 && invalidPresentedSlots === 0 && !claimedTallyMismatch) {
      const likelyScenario = missingSlots === 1 ? 'S1' : 'S3';
      const confidence = missingSlots === 1 ? 0.75 : 0.65;
      return {
        likelyScenario,
        confidence,
        summary: `${missingSlots} missing slot${missingSlots === 1 ? '' : 's'} detected - likely vote omission tampering.`,
      };
    }

    if (invalidPresentedSlots > 0 && missingSlots === 0 && !claimedTallyMismatch) {
      return {
        likelyScenario: 'S5',
        confidence: 0.55,
        summary: `${invalidPresentedSlots} invalid presented slot${
          invalidPresentedSlots === 1 ? '' : 's'
        } detected - likely validation or random-error tampering.`,
      };
    }

    // Mixed tampering or high-volume manipulation
    return {
      likelyScenario: 'S5',
      confidence: 0.65,
      summary: 'Multiple exclusion types detected – likely combined or random tampering.',
    };
  }

  generateReport(assessment: TamperAssessment): string {
    const classification = this.classifyScenario(assessment);
    const lines: string[] = [];

    lines.push('=== Tamper Assessment Summary ===');
    lines.push(`Tamper detected: ${assessment.tamperDetected ? 'YES' : 'NO'}`);
    lines.push(`Severity: ${assessment.severity}`);
    lines.push(`Missing slots: ${assessment.missingSlots}`);
    lines.push(`Invalid presented slots: ${assessment.invalidPresentedSlots}`);
    lines.push(`Valid votes: ${assessment.validVotes}`);
    lines.push(`Excluded slots: ${assessment.excludedSlots}`);
    lines.push(
      `Claimed tally mismatch: ${assessment.claimedTallyMismatch ? assessment.claimedTallyMismatchSource : 'none'}`,
    );

    if (typeof assessment.completenessRatio === 'number') {
      lines.push(`Completeness ratio: ${(assessment.completenessRatio * 100).toFixed(2)}%`);
    }

    lines.push('');
    lines.push(`Reasons: ${assessment.reasons.length > 0 ? assessment.reasons.join(', ') : 'none'}`);
    lines.push(`Summary: ${assessment.summary}`);
    lines.push('');
    lines.push(
      `Likely scenario: ${classification.likelyScenario} (confidence ${(classification.confidence * 100).toFixed(0)}%)`,
    );
    lines.push(`Scenario summary: ${classification.summary}`);

    return lines.join('\n');
  }

  private computeCompletenessRatio(totalExpected: number | undefined, counted: number): number | undefined {
    if (!totalExpected || totalExpected <= 0) {
      return undefined;
    }

    return Math.max(0, Math.min(1, counted / totalExpected));
  }
}

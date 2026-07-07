import { describe, it, expect } from 'vitest';
import { TamperVerifier } from './tamper-verifier';
import type { TamperAssessment, TamperMetrics } from './tamper-verifier';

const VERIFIED_TALLY: number[] = [14, 13, 13, 12, 12];

describe('TamperVerifier (exclusion model)', () => {
  const verifier = new TamperVerifier();

  const baseMetrics: TamperMetrics = {
    missingSlots: 0,
    invalidPresentedSlots: 0,
    validVotes: 64,
    totalExpected: 64,
    verifiedTally: VERIFIED_TALLY,
  };

  describe('evaluate', () => {
    it('reports clean result when all exclusion counts are zero', () => {
      const result = verifier.evaluate(baseMetrics);

      expect(result.tamperDetected).toBe(false);
      expect(result.severity).toBe('none');
      expect(result.reasons).toHaveLength(0);
      expect(result.excludedSlots).toBe(0);
    });

    it('flags missing slots as critical tampering', () => {
      const result = verifier.evaluate({ ...baseMetrics, missingSlots: 2, validVotes: 62 });

      expect(result.tamperDetected).toBe(true);
      expect(result.reasons).toContain('missingSlots');
      expect(result.severity).toBe('critical');
      expect(result.excludedSlots).toBe(2);
      expect(result.summary).toContain('2 slots were never presented to the zkVM');
    });

    it('flags invalid presented slots as warning-level tampering', () => {
      const result = verifier.evaluate({ ...baseMetrics, invalidPresentedSlots: 3, validVotes: 61 });

      expect(result.tamperDetected).toBe(true);
      expect(result.reasons).toContain('invalidPresentedSlots');
      expect(result.severity).toBe('warning');
      expect(result.excludedSlots).toBe(3);
      expect(result.summary).toContain('3 presented slots failed zkVM validation');
    });

    it('escalates severity to critical when both missing and invalid votes exist', () => {
      const result = verifier.evaluate({
        ...baseMetrics,
        missingSlots: 1,
        invalidPresentedSlots: 2,
        validVotes: 61,
      });

      expect(result.tamperDetected).toBe(true);
      expect(result.reasons).toEqual(['missingSlots', 'invalidPresentedSlots']);
      expect(result.severity).toBe('critical');
      expect(result.excludedSlots).toBe(3);
    });

    it('computes completeness ratio when totalExpected is provided', () => {
      const result = verifier.evaluate({ ...baseMetrics, missingSlots: 1, validVotes: 63 });

      expect(result.completenessRatio).toBeCloseTo(63 / 64, 5);
    });

    it('flags claimed tally mismatches without inventing slot failures', () => {
      const result = verifier.evaluate({
        ...baseMetrics,
        claimedTallyMismatch: true,
        claimedTallyMismatchSource: 'user',
      });

      expect(result.tamperDetected).toBe(true);
      expect(result.reasons).toEqual(['claimedTallyMismatch']);
      expect(result.excludedSlots).toBe(0);
      expect(result.claimedTallyMismatchSource).toBe('user');
    });
  });

  describe('classifyScenario', () => {
    const classify = (assessment: TamperAssessment) => verifier.classifyScenario(assessment);

    it('returns S0 when no tampering detected', () => {
      const assessment = verifier.evaluate(baseMetrics);
      const classification = classify(assessment);

      expect(classification.likelyScenario).toBe('S0');
      expect(classification.confidence).toBe(1);
    });

    it('identifies S1/S3-style missing vote patterns', () => {
      const assessment = verifier.evaluate({ ...baseMetrics, missingSlots: 1, validVotes: 63 });
      const classification = classify(assessment);

      expect(['S1', 'S3']).toContain(classification.likelyScenario);
      expect(classification.confidence).toBeGreaterThan(0.6);
      expect(classification.summary).toContain('missing slot');
    });

    it('identifies S2 from user claimed-tally mismatch', () => {
      const assessment = verifier.evaluate({
        ...baseMetrics,
        claimedTallyMismatch: true,
        claimedTallyMismatchSource: 'user',
      });
      const classification = classify(assessment);

      expect(classification.likelyScenario).toBe('S2');
      expect(classification.confidence).toBeGreaterThan(0.5);
      expect(classification.summary).toContain('Claimed tally mismatch');
    });

    it('identifies S4 from bot claimed-tally mismatch', () => {
      const assessment = verifier.evaluate({
        ...baseMetrics,
        claimedTallyMismatch: true,
        claimedTallyMismatchSource: 'bot',
      });
      const classification = classify(assessment);

      expect(classification.likelyScenario).toBe('S4');
      expect(classification.confidence).toBeGreaterThan(0.5);
      expect(classification.summary).toContain('Claimed tally mismatch');
    });

    it('does not classify invalid presented slots as S2 or S4', () => {
      const assessment = verifier.evaluate({ ...baseMetrics, invalidPresentedSlots: 2, validVotes: 62 });
      const classification = classify(assessment);

      expect(classification.likelyScenario).toBe('S5');
      expect(classification.summary).toContain('invalid presented slot');
    });

    it('falls back to S5 when both metrics spike', () => {
      const assessment = verifier.evaluate({
        ...baseMetrics,
        missingSlots: 4,
        invalidPresentedSlots: 5,
        validVotes: 55,
      });
      const classification = classify(assessment);

      expect(classification.likelyScenario).toBe('S5');
      expect(classification.confidence).toBeGreaterThan(0.4);
      expect(classification.summary).toContain('Multiple exclusion types');
    });
  });

  describe('generateReport', () => {
    it('produces human-readable report summarizing assessment', () => {
      const assessment = verifier.evaluate({
        ...baseMetrics,
        missingSlots: 2,
        invalidPresentedSlots: 1,
        validVotes: 61,
      });
      const report = verifier.generateReport(assessment);

      expect(report).toContain('Tamper Assessment Summary');
      expect(report).toContain('Missing slots: 2');
      expect(report).toContain('Invalid presented slots: 1');
      expect(report).toContain('Valid votes: 61');
      expect(report).toContain('Likely scenario');
    });
  });
});

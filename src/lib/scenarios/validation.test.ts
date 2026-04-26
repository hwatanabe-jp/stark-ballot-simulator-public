import { describe, it, expect } from 'vitest';
import {
  toggleScenario,
  isValidScenarioCombination,
  getScenarioConflicts,
  hasScenarioConflicts,
  isScenarioInConflict,
  type ScenarioId,
} from './validation';

const ALL_SCENARIOS: ScenarioId[] = ['S1', 'S2', 'S3', 'S4', 'S5'];
const MUTUALLY_EXCLUSIVE_PAIRS: Array<[ScenarioId, ScenarioId]> = [
  ['S1', 'S2'],
  ['S3', 'S4'],
];

describe('scenarios/validation', () => {
  describe('toggleScenario', () => {
    it('adds scenario when not present', () => {
      const selection = new Set<ScenarioId>();
      const result = toggleScenario('S1', selection);

      expect(result.has('S1')).toBe(true);
      expect(selection.size).toBe(0); // original set unchanged
    });

    it('removes scenario when already present', () => {
      const selection = new Set<ScenarioId>(['S1']);
      const result = toggleScenario('S1', selection);

      expect(result.has('S1')).toBe(false);
      expect(selection.has('S1')).toBe(true);
    });

    it('does not remove conflicting scenarios automatically', () => {
      const selection = new Set<ScenarioId>(['S2']);
      const result = toggleScenario('S1', selection);

      expect(result.has('S1')).toBe(true);
      expect(result.has('S2')).toBe(true);
    });

    it('allows adding non-conflicting options', () => {
      const selection = new Set<ScenarioId>(['S1', 'S3']);
      const result = toggleScenario('S5', selection);

      expect(result.has('S1')).toBe(true);
      expect(result.has('S3')).toBe(true);
      expect(result.has('S5')).toBe(true);
    });
  });

  describe('conflict detection helpers', () => {
    it('reports no conflicts for empty selection', () => {
      const selection = new Set<ScenarioId>();
      expect(getScenarioConflicts(selection)).toHaveLength(0);
      expect(hasScenarioConflicts(selection)).toBe(false);
      ALL_SCENARIOS.forEach((scenario) => {
        expect(isScenarioInConflict(scenario, selection)).toBe(false);
      });
    });

    it('identifies conflicts for mutually exclusive pairs', () => {
      MUTUALLY_EXCLUSIVE_PAIRS.forEach(([first, second]) => {
        const selection = new Set<ScenarioId>([first, second]);
        const conflicts = getScenarioConflicts(selection);

        expect(conflicts).toEqual(expect.arrayContaining([first, second]));
        expect(hasScenarioConflicts(selection)).toBe(true);
        expect(isScenarioInConflict(first, selection)).toBe(true);
        expect(isScenarioInConflict(second, selection)).toBe(true);
      });
    });

    it('does not mark unrelated scenarios as conflicting', () => {
      const selection = new Set<ScenarioId>(['S1', 'S3', 'S5']);
      expect(getScenarioConflicts(selection)).toHaveLength(0);
      expect(hasScenarioConflicts(selection)).toBe(false);
      selection.forEach((scenario) => {
        expect(isScenarioInConflict(scenario, selection)).toBe(false);
      });
    });

    it('only marks conflicting scenarios when additional options are selected', () => {
      const selection = new Set<ScenarioId>(['S1', 'S2', 'S5']);
      const conflicts = getScenarioConflicts(selection);

      expect(conflicts).toEqual(expect.arrayContaining(['S1', 'S2']));
      expect(conflicts).not.toContain('S5');
      expect(isScenarioInConflict('S5', selection)).toBe(false);
    });
  });

  describe('isValidScenarioCombination', () => {
    it('accepts empty and single selections', () => {
      expect(isValidScenarioCombination([])).toBe(true);
      ALL_SCENARIOS.forEach((scenario) => {
        expect(isValidScenarioCombination([scenario])).toBe(true);
      });
    });

    it('rejects mutually exclusive combinations', () => {
      MUTUALLY_EXCLUSIVE_PAIRS.forEach(([first, second]) => {
        expect(isValidScenarioCombination([first, second])).toBe(false);
        expect(isValidScenarioCombination([second, first])).toBe(false);
      });
    });

    it('accepts valid multi-scenario combinations', () => {
      expect(isValidScenarioCombination(['S1', 'S3'])).toBe(true);
      expect(isValidScenarioCombination(['S2', 'S4', 'S5'])).toBe(true);
    });
  });
});

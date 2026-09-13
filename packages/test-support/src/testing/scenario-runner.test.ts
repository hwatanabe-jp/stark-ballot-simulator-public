import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScenarioRunner } from './scenario-runner';
import type { ScenarioConfig, ScenarioResult } from './scenario-runner';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

const observedFinalizations = vi.hoisted(() => ({
  scenarios: [] as string[],
  tamperOutcomes: [] as boolean[],
  proofProfiles: [] as unknown[],
}));

// Mock the CLITestHelpers module
vi.mock('./cli-test-helpers', () => {
  function resolveFinalizationCountDiagnostics(data: {
    debug?: {
      missingSlots?: number;
      invalidPresentedSlots?: number;
      validVotes?: number;
      excludedSlots?: number;
    };
    missingSlots?: number;
    invalidPresentedSlots?: number;
    validVotes?: number;
    excludedSlots?: number;
  }) {
    return {
      missingSlots: data.debug?.missingSlots ?? data.missingSlots,
      invalidPresentedSlots: data.debug?.invalidPresentedSlots ?? data.invalidPresentedSlots,
      validVotes: data.debug?.validVotes ?? data.validVotes,
      excludedSlots: data.debug?.excludedSlots ?? data.excludedSlots,
    };
  }

  class MockCLITestHelpers {
    constructor(_baseUrl?: string, _operatorAuthHeaders?: Record<string, string>, proofProfile?: unknown) {
      observedFinalizations.proofProfiles.push(proofProfile);
    }

    createSession = vi.fn().mockResolvedValue('test-session-id');
    submitVote = vi.fn().mockResolvedValue({ leafIndex: 0, merklePath: [], commitment: '0xabc' });
    generateBotVotes = vi.fn().mockResolvedValue(true);
    finalizeWithScenarios = vi.fn().mockImplementation((_sessionId: string, scenarioId: ScenarioResult['scenario']) => {
      observedFinalizations.scenarios.push(scenarioId);
      const observedTamper = observedFinalizations.tamperOutcomes.shift();
      if (observedTamper === undefined) {
        throw new Error(`Missing independently observed outcome for ${scenarioId}`);
      }
      return Promise.resolve({
        data: {
          result: {
            verifiedTally: [10, 15, 20, 14, 5],
            totalVotes: 64,
            bulletinRoot: '0xroot',
          },
          proof: {
            tamperDetected: observedTamper,
            receipt: '{"mock": true}',
            imageId: 'test-image',
          },
          debug: {
            verifiedTally: [10, 15, 20, 14, 5],
            missingSlots: observedTamper ? 1 : 0,
            invalidPresentedSlots: 0,
            validVotes: observedTamper ? 63 : 64,
            excludedSlots: observedTamper ? 1 : 0,
          },
        },
      });
    });
  }

  return { CLITestHelpers: MockCLITestHelpers, resolveFinalizationCountDiagnostics };
});

function useObservedTamperOutcomes(...outcomes: readonly boolean[]): void {
  observedFinalizations.tamperOutcomes.splice(0, observedFinalizations.tamperOutcomes.length, ...outcomes);
}

describe('ScenarioRunner', () => {
  let runner: ScenarioRunner;
  const mockProofProfile = {
    executor: 'mock',
    evidence: 'mock',
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    observedFinalizations.scenarios.length = 0;
    observedFinalizations.proofProfiles.length = 0;
    useObservedTamperOutcomes(false);
    runner = new ScenarioRunner(mockProofProfile);
  });

  describe('runScenario', () => {
    it.each([
      { scenario: 'S0', observedTamper: false, expectedPassed: true },
      { scenario: 'S0', observedTamper: true, expectedPassed: false },
      { scenario: 'S3', observedTamper: true, expectedPassed: true },
      { scenario: 'S3', observedTamper: false, expectedPassed: false },
    ])(
      'compares the independently observed $observedTamper outcome for $scenario',
      async ({ scenario, observedTamper, expectedPassed }) => {
        useObservedTamperOutcomes(observedTamper);
        const config: ScenarioConfig = {
          scenario,
          userChoice: 'A',
        };

        const result = await runner.runScenario(config);

        expect(result.scenario).toBe(scenario);
        expect(result.tamperDetected).toBe(observedTamper);
        expect(result.passed).toBe(expectedPassed);
        expect(result.errors).toEqual(
          expectedPassed ? [] : [`Tamper detection mismatch: expected ${scenario !== 'S0'}, got ${observedTamper}`],
        );
      },
    );

    it('injects one semantic proof profile before constructing its helper', () => {
      expect(observedFinalizations.proofProfiles).toEqual([mockProofProfile]);
    });
  });

  describe('runAllScenarios', () => {
    it('runs S0-S5 in order while comparing independently supplied observations', async () => {
      const observedTamperOutcomes = [true, false, true, false, true, false];
      useObservedTamperOutcomes(...observedTamperOutcomes);

      const results = await runner.runAllScenarios({
        userChoice: 'A',
      });

      expect(observedFinalizations.scenarios).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
      expect(results.map((result) => result.scenario)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
      expect(results.map((result) => result.tamperDetected)).toEqual(observedTamperOutcomes);
      expect(results.map((result) => result.passed)).toEqual([false, false, true, false, true, false]);
    });

    it('should handle errors gracefully', async () => {
      // Mock helpers to throw errors
      const errorHelpers = {
        createSession: vi.fn().mockRejectedValue(new Error('Connection failed')),
        submitVote: vi.fn(),
        generateBotVotes: vi.fn(),
        finalizeWithScenarios: vi.fn(),
      };

      // Create a new runner with mocked error helpers
      const errorRunner = new ScenarioRunner(mockProofProfile, 'http://localhost:3000', errorHelpers);

      const results = await errorRunner.runAllScenarios({
        userChoice: 'A',
      });

      expect(results).toHaveLength(6);
      results.forEach((result) => {
        expect(result.passed).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(strictDefined(result.errors[0])).toContain('Connection failed');
      });
    });
  });

  describe('generateReport', () => {
    it('should generate a summary report of all results', () => {
      const results: ScenarioResult[] = [
        {
          scenario: 'S0',
          passed: true,
          tamperDetected: false,
          duration: 100,
          errors: [],
        },
        {
          scenario: 'S1',
          passed: true,
          tamperDetected: true,
          duration: 120,
          errors: [],
          details: {
            missingSlots: 1,
            invalidPresentedSlots: 0,
            validVotes: 63,
            excludedSlots: 1,
          },
        },
        {
          scenario: 'S2',
          passed: false,
          tamperDetected: false,
          duration: 80,
          errors: ['Connection timeout'],
        },
      ];

      // Test detailed report
      const detailedReport = runner.generateReport(results);
      expect(detailedReport).toContain('Test Summary Report');
      expect(detailedReport).toContain('Total Tests: 3');
      expect(detailedReport).toContain('Passed: 2');
      expect(detailedReport).toContain('Failed: 1');
      expect(detailedReport).toContain('S0: PASS (no tamper,');
      expect(detailedReport).toContain('S1: PASS (tamper detected,');
      expect(detailedReport).toContain('S2: FAIL (no tamper,');
      expect(detailedReport).toContain('missingSlots=1');
      expect(detailedReport).toContain('validVotes=63');
      expect(detailedReport).toContain('Connection timeout');

      // Test simple report
      const simpleReport = runner.generateReport(results, 'simple');
      expect(simpleReport).toContain('Test Summary');
      expect(simpleReport).toContain('Total: 3');
      expect(simpleReport).toContain('Passed: 2');
      expect(simpleReport).toContain('Failed: 1');
      expect(simpleReport).toContain('S0: PASS');
      expect(simpleReport).toContain('S1: PASS');
      expect(simpleReport).toContain('S2: FAIL');
      expect(simpleReport).toContain('Connection timeout');
    });
  });

  describe('configuration validation', () => {
    it('should validate scenario names', () => {
      const config: ScenarioConfig = {
        scenario: 'S99', // Invalid scenario
        userChoice: 'A',
      };

      expect(() => runner.validateConfig(config)).toThrow('Invalid scenario: S99');
    });

    it('should validate user choice', () => {
      const config: ScenarioConfig = {
        scenario: 'S0',
        userChoice: 'Z', // Invalid choice
      };

      expect(() => runner.validateConfig(config)).toThrow('Invalid user choice: Z');
    });
  });
});

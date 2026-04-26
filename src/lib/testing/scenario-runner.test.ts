import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScenarioRunner } from './scenario-runner';
import type { ScenarioConfig, ScenarioResult } from './scenario-runner';

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
    createSession = vi.fn().mockResolvedValue('test-session-id');
    submitVote = vi.fn().mockResolvedValue({ leafIndex: 0, merklePath: [], commitment: '0xabc' });
    generateBotVotes = vi.fn().mockResolvedValue(true);
    finalizeWithScenarios = vi.fn().mockImplementation((_sessionId: string, scenarioId: ScenarioResult['scenario']) => {
      const isTampered = scenarioId !== 'S0';
      return Promise.resolve({
        data: {
          result: {
            verifiedTally: [10, 15, 20, 14, 5],
            totalVotes: 64,
            bulletinRoot: '0xroot',
          },
          proof: {
            tamperDetected: isTampered,
            receipt: '{"mock": true}',
            imageId: 'test-image',
          },
          debug: {
            verifiedTally: [10, 15, 20, 14, 5],
            missingSlots: isTampered ? 1 : 0,
            invalidPresentedSlots: 0,
            validVotes: isTampered ? 63 : 64,
            excludedSlots: isTampered ? 1 : 0,
          },
        },
      });
    });
  }

  return { CLITestHelpers: MockCLITestHelpers, resolveFinalizationCountDiagnostics };
});

describe('ScenarioRunner', () => {
  let runner: ScenarioRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new ScenarioRunner();
    delete process.env.RISC0_DEV_MODE;
  });

  describe('runScenario', () => {
    it('should run S0 (normal case) successfully', async () => {
      const config: ScenarioConfig = {
        scenario: 'S0',
        userChoice: 'A',
        useRealZkVM: false,
      };

      const result = await runner.runScenario(config);

      expect(result.scenario).toBe('S0');
      expect(result.passed).toBe(true);
      expect(result.tamperDetected).toBe(false);
      expect(result.errors).toHaveLength(0);
    });

    it('should unset RISC0_DEV_MODE in real mode', async () => {
      process.env.RISC0_DEV_MODE = '1';

      const config: ScenarioConfig = {
        scenario: 'S0',
        userChoice: 'A',
        useRealZkVM: true,
      };

      await runner.runScenario(config);

      expect(process.env.RISC0_DEV_MODE).toBeUndefined();
    });

    it('should detect tampering in S1 (ignore user vote)', async () => {
      const config: ScenarioConfig = {
        scenario: 'S1',
        userChoice: 'B',
        useRealZkVM: false,
      };

      const result = await runner.runScenario(config);

      expect(result.scenario).toBe('S1');
      expect(result.passed).toBe(true);
      expect(result.tamperDetected).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect tampering in S2 (recount user vote)', async () => {
      const config: ScenarioConfig = {
        scenario: 'S2',
        userChoice: 'C',
        useRealZkVM: false,
      };

      const result = await runner.runScenario(config);

      expect(result.scenario).toBe('S2');
      expect(result.passed).toBe(true);
      expect(result.tamperDetected).toBe(true);
    });

    it('should detect tampering in S3 (ignore a bot vote)', async () => {
      const config: ScenarioConfig = {
        scenario: 'S3',
        userChoice: 'D',
        useRealZkVM: false,
      };

      const result = await runner.runScenario(config);

      expect(result.scenario).toBe('S3');
      expect(result.passed).toBe(true);
      expect(result.tamperDetected).toBe(true);
    });

    it('should detect tampering in S4 (recount a bot vote)', async () => {
      const config: ScenarioConfig = {
        scenario: 'S4',
        userChoice: 'E',
        useRealZkVM: false,
      };

      const result = await runner.runScenario(config);

      expect(result.scenario).toBe('S4');
      expect(result.passed).toBe(true);
      expect(result.tamperDetected).toBe(true);
    });

    it('should detect tampering in S5 (random errors)', async () => {
      const config: ScenarioConfig = {
        scenario: 'S5',
        userChoice: 'A',
        useRealZkVM: false,
      };

      const result = await runner.runScenario(config);

      expect(result.scenario).toBe('S5');
      expect(result.passed).toBe(true);
      expect(result.tamperDetected).toBe(true);
    });
  });

  describe('runAllScenarios', () => {
    it('should run all scenarios and return results', async () => {
      const results = await runner.runAllScenarios({
        userChoice: 'A',
        useRealZkVM: false,
      });

      expect(results).toHaveLength(6); // S0-S5
      expect(results[0].scenario).toBe('S0');
      expect(results[0].tamperDetected).toBe(false);

      // S1-S5 should all detect tampering
      for (let i = 1; i < 6; i++) {
        expect(results[i].tamperDetected).toBe(true);
      }
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
      const errorRunner = new ScenarioRunner('http://localhost:3000', errorHelpers);

      const results = await errorRunner.runAllScenarios({
        userChoice: 'A',
        useRealZkVM: false,
      });

      expect(results).toHaveLength(6);
      results.forEach((result) => {
        expect(result.passed).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Connection failed');
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
      expect(detailedReport).toContain('✅ S0: PASS');
      expect(detailedReport).toContain('✅ S1: PASS');
      expect(detailedReport).toContain('❌ S2: FAIL');
      expect(detailedReport).toContain('missingSlots=1');
      expect(detailedReport).toContain('validVotes=63');
      expect(detailedReport).toContain('Connection timeout');

      // Test simple report
      const simpleReport = runner.generateReport(results, 'simple');
      expect(simpleReport).toContain('Test Summary');
      expect(simpleReport).toContain('Total: 3');
      expect(simpleReport).toContain('Passed: 2');
      expect(simpleReport).toContain('Failed: 1');
      expect(simpleReport).toContain('S0: ✅ PASS');
      expect(simpleReport).toContain('S1: ✅ PASS');
      expect(simpleReport).toContain('S2: ❌ FAIL');
      expect(simpleReport).toContain('Connection timeout');
    });
  });

  describe('configuration validation', () => {
    it('should validate scenario names', () => {
      const config: ScenarioConfig = {
        scenario: 'S99', // Invalid scenario
        userChoice: 'A',
        useRealZkVM: false,
      };

      expect(() => runner.validateConfig(config)).toThrow('Invalid scenario: S99');
    });

    it('should validate user choice', () => {
      const config: ScenarioConfig = {
        scenario: 'S0',
        userChoice: 'Z', // Invalid choice
        useRealZkVM: false,
      };

      expect(() => runner.validateConfig(config)).toThrow('Invalid user choice: Z');
    });
  });
});

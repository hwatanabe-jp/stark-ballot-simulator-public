/**
 * Scenario Runner for automated tamper testing
 * Executes S0-S5 scenarios systematically
 */

import { CLITestHelpers, resolveFinalizationCountDiagnostics } from './cli-test-helpers';
import type { VoteChoice } from '@/shared/constants';

export type TamperScenario = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

const VALID_SCENARIOS: TamperScenario[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];
const VALID_CHOICES: VoteChoice[] = ['A', 'B', 'C', 'D', 'E'];

function assertValidScenario(value: string): asserts value is TamperScenario {
  if (!VALID_SCENARIOS.some((scenario) => scenario === value)) {
    throw new Error(`Invalid scenario: ${value}`);
  }
}

function assertValidVoteChoice(value: string): asserts value is VoteChoice {
  if (!VALID_CHOICES.some((choice) => choice === value)) {
    throw new Error(`Invalid user choice: ${value}`);
  }
}

export interface ScenarioConfig {
  scenario: string;
  userChoice: string;
  useRealZkVM: boolean;
}

export interface ScenarioResult {
  scenario: TamperScenario;
  passed: boolean;
  tamperDetected: boolean;
  duration: number;
  errors: string[];
  details?: {
    verifiedTally?: number[];
    missingSlots?: number;
    invalidPresentedSlots?: number;
    validVotes?: number;
    excludedSlots?: number;
    sessionId?: string;
    voteCommitment?: string;
    bulletinRoot?: string;
  };
  metrics?: {
    sessionCreationTime?: number;
    votingTime?: number;
    finalizationTime?: number;
  };
}

type ScenarioHelpers = Pick<
  CLITestHelpers,
  'createSession' | 'submitVote' | 'generateBotVotes' | 'finalizeWithScenarios'
>;

export class ScenarioRunner {
  private helpers: ScenarioHelpers;

  constructor(baseUrl = 'http://localhost:3000', helpers?: ScenarioHelpers) {
    this.helpers = helpers ?? new CLITestHelpers(baseUrl);
  }

  /**
   * Validate configuration
   */
  validateConfig(
    config: ScenarioConfig,
  ): asserts config is ScenarioConfig & { scenario: TamperScenario; userChoice: VoteChoice } {
    assertValidScenario(config.scenario);
    assertValidVoteChoice(config.userChoice);
  }

  /**
   * Run a single scenario with enhanced metrics
   */
  async runScenario(config: ScenarioConfig): Promise<ScenarioResult> {
    this.validateConfig(config);
    const scenario = config.scenario;
    const userChoice = config.userChoice;

    const startTime = Date.now();
    const errors: string[] = [];
    const metrics: ScenarioResult['metrics'] = {};

    try {
      // Configure zkVM mode
      this.configureZkVMMode(config.useRealZkVM);

      // Create a session
      const sessionStartTime = Date.now();
      const sessionId = await this.helpers.createSession();
      metrics.sessionCreationTime = Date.now() - sessionStartTime;

      // Cast votes
      const votingStartTime = Date.now();
      const voteResult = await this.helpers.submitVote(sessionId, userChoice);
      await this.helpers.generateBotVotes(sessionId);
      metrics.votingTime = Date.now() - votingStartTime;

      // Finalize with the requested tamper scenario
      const finalizationStartTime = Date.now();
      const finalizeResult = await this.helpers.finalizeWithScenarios(sessionId, scenario);
      metrics.finalizationTime = Date.now() - finalizationStartTime;

      // Extract results
      const result = finalizeResult.data.result;
      const proof = finalizeResult.data.proof;
      const debug = finalizeResult.data.debug;
      const { missingSlots, invalidPresentedSlots, validVotes, excludedSlots } = resolveFinalizationCountDiagnostics(
        finalizeResult.data,
      );

      // Verify tamper detection accuracy
      const expectedTamper = scenario !== 'S0';
      if (!proof || typeof proof.tamperDetected !== 'boolean') {
        throw new Error('Finalization proof missing tamperDetected flag');
      }
      const actualTamper = proof.tamperDetected;
      const verificationPassed = actualTamper === expectedTamper;

      // Log discrepancy if verification failed
      if (!verificationPassed) {
        errors.push(`Tamper detection mismatch: expected ${expectedTamper}, got ${actualTamper}`);
      }

      return {
        scenario,
        passed: verificationPassed,
        tamperDetected: actualTamper,
        duration: Date.now() - startTime,
        errors,
        details: {
          verifiedTally: debug?.verifiedTally ?? (result?.counts ? Object.values(result.counts) : undefined),
          missingSlots,
          invalidPresentedSlots,
          validVotes,
          excludedSlots,
          sessionId,
          voteCommitment: voteResult.commitment,
          bulletinRoot: result?.bulletinRoot,
        },
        metrics,
      };
    } catch (error) {
      const errorMessage = this.formatError(error);
      errors.push(errorMessage);

      return {
        scenario,
        passed: false,
        tamperDetected: false,
        duration: Date.now() - startTime,
        errors,
        metrics,
      };
    }
  }

  /**
   * Configure zkVM execution mode
   */
  private configureZkVMMode(useRealZkVM: boolean): void {
    if (!useRealZkVM) {
      process.env.USE_MOCK_ZKVM = 'true';
      process.env.RISC0_DEV_MODE = '1';
    } else {
      process.env.USE_MOCK_ZKVM = 'false';
      // Force production-mode proofs by clearing any leftover dev-mode flags
      delete process.env.RISC0_DEV_MODE;
    }
  }

  /**
   * Format error messages consistently
   */
  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }

  /**
   * Run all scenarios S0-S5
   */
  async runAllScenarios(options: Omit<ScenarioConfig, 'scenario'>): Promise<ScenarioResult[]> {
    const scenarios: TamperScenario[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];
    const results: ScenarioResult[] = [];

    for (const scenario of scenarios) {
      const config: ScenarioConfig = {
        ...options,
        scenario,
      };

      const result = await this.runScenario(config);
      results.push(result);
    }

    return results;
  }

  /**
   * Generate an enhanced summary report with metrics
   */
  generateReport(results: ScenarioResult[], format: 'simple' | 'detailed' = 'detailed'): string {
    if (format === 'simple') {
      return this.generateSimpleReport(results);
    }

    const totalTests = results.length;
    const passedTests = results.filter((r) => r.passed).length;
    const failedTests = totalTests - passedTests;
    const successRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0';

    // Calculate average times
    const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / totalTests;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

    let report = '╔══════════════════════════════════════════╗\n';
    report += '║         Test Summary Report              ║\n';
    report += '╚══════════════════════════════════════════╝\n\n';

    report += '📊 Overall Statistics:\n';
    report += `  • Total Tests: ${totalTests}\n`;
    report += `  • Passed: ${passedTests} (${successRate}%)\n`;
    report += `  • Failed: ${failedTests}\n`;
    report += `  • Total Duration: ${(totalDuration / 1000).toFixed(2)}s\n`;
    report += `  • Average Duration: ${(avgDuration / 1000).toFixed(2)}s\n`;

    report += '\n📋 Detailed Results:\n';
    report += '─────────────────────────────────────\n';

    for (const result of results) {
      const status = result.passed ? '✅' : '❌';
      const tamperIcon = result.tamperDetected ? '🚨' : '✓';

      report += `\n${status} ${result.scenario}: `;
      report += result.passed ? 'PASS' : 'FAIL';
      report += ` ${tamperIcon} (${result.duration}ms)\n`;

      // Include metrics if available
      if (result.metrics) {
        report += `   ⏱ Performance:\n`;
        if (result.metrics.sessionCreationTime !== undefined) {
          report += `     • Session: ${result.metrics.sessionCreationTime}ms\n`;
        }
        if (result.metrics.votingTime !== undefined) {
          report += `     • Voting: ${result.metrics.votingTime}ms\n`;
        }
        if (result.metrics.finalizationTime !== undefined) {
          report += `     • Finalization: ${result.metrics.finalizationTime}ms\n`;
        }
      }

      // Include errors
      if (result.errors.length > 0) {
        report += `   ⚠️ Errors:\n`;
        for (const error of result.errors) {
          report += `     • ${error}\n`;
        }
      }

      // Include tally details
      if (result.details) {
        if (result.details.verifiedTally) {
          report += `   📊 Tally:\n`;
          report += `     • Verified: [${result.details.verifiedTally.join(', ')}]\n`;
        }

        if (
          typeof result.details.missingSlots === 'number' ||
          typeof result.details.invalidPresentedSlots === 'number' ||
          typeof result.details.validVotes === 'number' ||
          typeof result.details.excludedSlots === 'number'
        ) {
          report += `   📈 Counts: missingSlots=${result.details.missingSlots ?? 'n/a'}, invalidPresentedSlots=${
            result.details.invalidPresentedSlots ?? 'n/a'
          }, validVotes=${result.details.validVotes ?? 'n/a'}, excludedSlots=${
            result.details.excludedSlots ?? 'n/a'
          }\n`;
        }
      }
    }

    report += '\n─────────────────────────────────────\n';
    report += this.generateScenarioLegend();

    return report;
  }

  /**
   * Generate a simple report format
   */
  private generateSimpleReport(results: ScenarioResult[]): string {
    const totalTests = results.length;
    const passedTests = results.filter((r) => r.passed).length;
    const failedTests = totalTests - passedTests;

    let report = '=== Test Summary ===\n';
    report += `Total: ${totalTests}\n`;
    report += `Passed: ${passedTests}\n`;
    report += `Failed: ${failedTests}\n`;
    report += '\n--- Results ---\n';

    for (const result of results) {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      const tamper = result.tamperDetected ? '(tamper detected)' : '(no tamper)';
      report += `${result.scenario}: ${status} ${tamper}\n`;

      if (result.errors.length > 0) {
        for (const error of result.errors) {
          report += `    - ${error}\n`;
        }
      }
    }

    return report;
  }

  /**
   * Generate scenario legend
   */
  private generateScenarioLegend(): string {
    return `
📖 Scenario Legend:
  • S0: Normal case (no tampering)
  • S1: Ignore user vote
  • S2: Tamper claimed tally for your vote
  • S3: Ignore a bot vote
  • S4: Tamper claimed tally for a bot vote
  • S5: Random errors
`;
  }
}

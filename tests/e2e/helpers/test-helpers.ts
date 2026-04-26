import type {
  VerificationResult,
  TamperScenario,
  CheckStatus,
  VerificationCheckId,
  VerificationStepId,
} from '../pages';

export interface TestScenario {
  name: string;
  scenarioId: TamperScenario;
  userChoice: 'A' | 'B' | 'C' | 'D' | 'E';
  expectedCheckStatuses: Partial<Record<VerificationCheckId, CheckStatus>>;
  expectedStepStatuses?: Partial<Record<VerificationStepId, CheckStatus>>;
  smoke?: boolean;
}

export const TEST_SCENARIOS: TestScenario[] = [
  {
    name: 'S0: Normal case (no tampering)',
    scenarioId: 'S0',
    userChoice: 'A',
    expectedCheckStatuses: {
      counted_tally_consistent: 'success',
      counted_missing_indices_zero: 'success',
      counted_expected_vs_tree_size: 'success',
      counted_election_manifest_consistent: 'success',
      counted_close_statement_consistent: 'success',
      stark_receipt_verify: 'success',
    },
    expectedStepStatuses: {
      counted_as_recorded: 'success',
      stark_verification: 'success',
    },
    smoke: true,
  },
  {
    name: 'S1: Ignore user vote',
    scenarioId: 'S1',
    userChoice: 'A',
    expectedCheckStatuses: {
      counted_missing_indices_zero: 'failed',
    },
  },
  {
    name: 'S2: Tamper claimed tally for your vote',
    scenarioId: 'S2',
    userChoice: 'A',
    expectedCheckStatuses: {
      counted_tally_consistent: 'failed',
      counted_missing_indices_zero: 'success',
      counted_expected_vs_tree_size: 'success',
      counted_election_manifest_consistent: 'success',
      counted_close_statement_consistent: 'success',
      stark_receipt_verify: 'success',
    },
    expectedStepStatuses: {
      counted_as_recorded: 'failed',
      stark_verification: 'success',
    },
    smoke: true,
  },
  {
    name: 'S3: Ignore a bot vote',
    scenarioId: 'S3',
    userChoice: 'A',
    expectedCheckStatuses: {
      counted_missing_indices_zero: 'failed',
    },
  },
  {
    name: 'S4: Tamper claimed tally for a bot vote',
    scenarioId: 'S4',
    userChoice: 'A',
    expectedCheckStatuses: {
      counted_missing_indices_zero: 'success',
    },
  },
  {
    name: 'S5: Random errors',
    scenarioId: 'S5',
    userChoice: 'A',
    expectedCheckStatuses: {
      counted_missing_indices_zero: 'failed',
    },
  },
];

export function validateVerificationResult(
  result: VerificationResult,
  scenario: TestScenario,
): { passed: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!result.summaryVisible) {
    errors.push('Verification summary was not visible');
  }

  for (const [checkId, expectedStatus] of Object.entries(scenario.expectedCheckStatuses) as Array<
    [VerificationCheckId, CheckStatus]
  >) {
    const actualStatus = result.checkStatuses[checkId];
    if (!actualStatus) {
      errors.push(`Check status was unavailable for ${checkId}`);
      continue;
    }
    if (actualStatus !== expectedStatus) {
      errors.push(`Expected ${checkId} to be ${expectedStatus}, got ${actualStatus}`);
    }
  }

  for (const [stepId, expectedStatus] of Object.entries(scenario.expectedStepStatuses ?? {}) as Array<
    [VerificationStepId, CheckStatus]
  >) {
    const actualStatus = result.stepStatuses[stepId];
    if (!actualStatus) {
      errors.push(`Step status was unavailable for ${stepId}`);
      continue;
    }
    if (actualStatus !== expectedStatus) {
      errors.push(`Expected ${stepId} to be ${expectedStatus}, got ${actualStatus}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
  };
}

export async function measurePerformance<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ result: T; duration: number }> {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;

  console.log(`[Performance] ${name}: ${(duration / 1000).toFixed(2)}s`);

  return { result, duration };
}

export function generateTestReport(
  results: Array<{
    scenario: string;
    passed: boolean;
    duration: number;
    errors?: string[];
  }>,
): string {
  const totalTests = results.length;
  const passedTests = results.filter((r) => r.passed).length;
  const failedTests = totalTests - passedTests;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  let report = `
========================================
STARK Ballot Simulator E2E Test Report
========================================

Summary:
- Total Tests: ${totalTests}
- Passed: ${passedTests}
- Failed: ${failedTests}
- Duration: ${(totalDuration / 1000).toFixed(2)}s

Test Results:
`;

  for (const result of results) {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    report += `\n${status} | ${result.scenario} (${(result.duration / 1000).toFixed(2)}s)`;

    if (result.errors && result.errors.length > 0) {
      report += '\n  Errors:';
      for (const error of result.errors) {
        report += `\n    - ${error}`;
      }
    }
  }

  report += '\n\n========================================';

  return report;
}

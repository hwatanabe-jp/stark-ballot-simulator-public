import { describe, expect, it } from 'vitest';
import { CLITestHelpers, type TestResult, type FinalizationStatusSample } from '../cli-test-helpers';

function buildResult(overrides: Partial<TestResult['details']> = {}): TestResult {
  const history: FinalizationStatusSample[] = [
    {
      state: {
        status: 'pending',
        executionId: '01HZ3JQ4ABXYZ7890DEF123456',
        queuedAt: 1_730_000_000_000,
      },
      receivedAt: 1_730_000_000_100,
      stepFunctions: null,
    },
    {
      state: {
        status: 'running',
        executionId: '01HZ3JQ4ABXYZ7890DEF123456',
        queuedAt: 1_730_000_000_000,
        startedAt: 1_730_000_000_500,
      },
      receivedAt: 1_730_000_000_600,
      stepFunctions: null,
    },
    {
      state: {
        status: 'succeeded',
        executionId: '01HZ3JQ4ABXYZ7890DEF123456',
        queuedAt: 1_730_000_000_000,
        startedAt: 1_730_000_000_500,
        completedAt: 1_730_000_001_000,
      },
      receivedAt: 1_730_000_001_100,
      stepFunctions: {
        executionArn:
          'arn:aws:states:ap-northeast-1:123456789012:execution:ProverDispatcher:01HZ3JQ4ABXYZ7890DEF123456',
        status: 'SUCCEEDED',
        startTime: 1_730_000_000_500,
        stopTime: 1_730_000_001_000,
        error: null,
        cause: null,
      },
    },
  ];

  return {
    name: 'Scenario S0',
    passed: true,
    duration: 1_200,
    details: {
      tamperDetected: false,
      finalizationMode: 'async',
      finalizationExecutionId: '01HZ3JQ4ABXYZ7890DEF123456',
      finalizationHistory: history,
      finalizationStepFunctions: history[2].stepFunctions,
      ...overrides,
    },
  };
}

describe('CLITestHelpers.generateReport', () => {
  const helpers = new CLITestHelpers('http://localhost:3000');

  it('renders finalization diagnostics in table report', async () => {
    const report = await helpers.generateReport([buildResult()], 'table');
    expect(report).toContain('Finalization mode: ASYNC');
    expect(report).toContain('executionId=01HZ3JQ4ABXYZ7890DEF123456');
    expect(report).toContain('Step Functions: status=SUCCEEDED');
  });

  it('renders finalization diagnostics in markdown report', async () => {
    const report = await helpers.generateReport([buildResult()], 'markdown');
    expect(report).toContain('Finalization mode: ASYNC');
    expect(report).toContain('Finalization state: SUCCEEDED');
    expect(report).toContain('Step Functions: status=SUCCEEDED');
  });

  it('renders canonical count diagnostics in markdown report', async () => {
    const report = await helpers.generateReport(
      [
        buildResult({
          missingSlots: 1,
          invalidPresentedSlots: 2,
          validVotes: 61,
          excludedSlots: 3,
        }),
      ],
      'markdown',
    );

    expect(report).toContain('missingSlots=1');
    expect(report).toContain('invalidPresentedSlots=2');
    expect(report).toContain('validVotes=61');
    expect(report).toContain('excludedSlots=3');
  });
});

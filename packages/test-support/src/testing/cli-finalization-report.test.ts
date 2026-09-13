import { describe, expect, it } from 'vitest';
import { CLITestHelpers, type TestResult, type FinalizationStatusSample } from './cli-test-helpers';

function strictDefined<T>(value: T, label = 'value'): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function buildResult(overrides: Partial<TestResult['details']> = {}): TestResult {
  const history: FinalizationStatusSample[] = [
    {
      state: {
        status: 'pending',
        finalizationId: '01HZ3JQ4ABXYZ7890DEF123456',
        queuedAtMs: 1_730_000_000_000,
      },
      receivedAt: 1_730_000_000_100,
      runtimeDiagnostics: null,
    },
    {
      state: {
        status: 'running',
        finalizationId: '01HZ3JQ4ABXYZ7890DEF123456',
        queuedAtMs: 1_730_000_000_000,
        startedAtMs: 1_730_000_000_500,
      },
      receivedAt: 1_730_000_000_600,
      runtimeDiagnostics: null,
    },
    {
      state: {
        status: 'succeeded',
        finalizationId: '01HZ3JQ4ABXYZ7890DEF123456',
        queuedAtMs: 1_730_000_000_000,
        startedAtMs: 1_730_000_000_500,
        completedAtMs: 1_730_000_001_000,
      },
      receivedAt: 1_730_000_001_100,
      runtimeDiagnostics: {
        asyncMode: 'enabled',
        orchestrator: {
          status: 'SUCCEEDED',
          startTimeMs: 1_730_000_000_500,
          stopTimeMs: 1_730_000_001_000,
        },
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
      finalizationId: '01HZ3JQ4ABXYZ7890DEF123456',
      finalizationHistory: history,
      finalizationRuntimeDiagnostics: strictDefined(strictDefined(history[2]).runtimeDiagnostics),
      ...overrides,
    },
  };
}

describe('CLITestHelpers.generateReport', () => {
  const helpers = new CLITestHelpers('http://localhost:3000');

  it('renders finalization diagnostics in table report', async () => {
    const report = await helpers.generateReport([buildResult()], 'table');
    expect(report).toContain('Finalization mode: ASYNC');
    expect(report).toContain('finalizationId=01HZ3JQ4ABXYZ7890DEF123456');
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

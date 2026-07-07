import type { FinalizationScenarioContext } from '@stark-ballot/domain/types/server';
import type { FinalizationExecutionId } from '@stark-ballot/application/finalize/finalization-types';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';

export type FinalizationScenarioCode = `S${0 | 1 | 2 | 3 | 4 | 5}`;

export type FinalizationWorkItem = {
  sessionId: string;
  contractGeneration: string;
  executionId: FinalizationExecutionId;
  queuedAt: number;
  expectedImageId: string;
  zkvmInput?: ZkVMInput;
  zkvmInputCommitment?: string;
  electionConfig?: ElectionConfig;
  scenarios: FinalizationScenarioCode[];
  simulateTampering: boolean;
  scenarioContext?: FinalizationScenarioContext;
};

export function createFinalizationWorkItem(input: FinalizationWorkItem): FinalizationWorkItem {
  return {
    ...input,
    scenarios: [...input.scenarios],
  };
}

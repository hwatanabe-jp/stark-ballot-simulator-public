import type {
  FinalizationId,
  FinalizationScenarioContext,
} from '@stark-ballot/application/finalize/finalization-types';
import type { ElectionConfig } from '@stark-ballot/zkvm-contract/zkvm/election-config';
import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';

export type FinalizationScenarioCode = `S${0 | 1 | 2 | 3 | 4 | 5}`;

type FinalizationWorkItemCommon = {
  sessionId: string;
  finalizationId: FinalizationId;
  queuedAtMs: number;
  expectedImageId: string;
  scenarios: FinalizationScenarioCode[];
  simulateTampering: boolean;
  scenarioContext: FinalizationScenarioContext;
};

export type FinalizationWorkItem =
  | (FinalizationWorkItemCommon & {
      inputSource: 'inline';
      zkvmInput: ZkVMInput;
      zkvmInputCommitment?: string;
      electionConfig: ElectionConfig;
    })
  | (FinalizationWorkItemCommon & {
      inputSource: 's3';
    });

export function createFinalizationWorkItem(input: FinalizationWorkItem): FinalizationWorkItem {
  return {
    ...input,
    scenarios: [...input.scenarios],
  };
}

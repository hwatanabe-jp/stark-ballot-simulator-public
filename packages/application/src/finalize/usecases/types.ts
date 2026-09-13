import type { ApplicationExpectedError } from '@stark-ballot/application';
import type {
  FinalizationState,
  FinalizeAcceptedPayload,
  FinalizeSyncPayload,
} from '@stark-ballot/application/finalize/finalization-types';
import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import type { ScenarioResult } from '@stark-ballot/domain/scenarios/processor';
import type { ScenarioTamperMode } from '@stark-ballot/domain/types/scenario';

export type { Result } from '@stark-ballot/application';

export type { FinalizeAcceptedPayload, FinalizeSyncPayload };

export type FinalizeSessionError =
  | ({ kind: 'api' } & ApplicationExpectedError)
  | {
      kind: 'invalid_image_id';
      expected: string;
      actual: string | null;
    };

export type FinalizeSessionOutcome =
  | {
      kind: 'accepted';
      payload: FinalizeAcceptedPayload;
      state: FinalizationState;
    }
  | {
      kind: 'sync';
      payload: FinalizeSyncPayload;
    };

export type FinalizeScenarioContext = {
  scenarios: string[];
  scenariosApplied: string[];
  tamperMode: ScenarioTamperMode;
  claimedCounts: Record<VoteChoice, number>;
  claimedTotalVotes: number;
  summary: {
    ignoredCount: number;
    recountedCount: number;
    userRecountChoice: VoteChoice | null;
  };
  scenarioResult: ScenarioResult | null;
  affectedBotIds?: number[];
};

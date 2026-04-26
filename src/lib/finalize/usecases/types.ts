import type { ErrorCode, ErrorDetails } from '@/lib/errors/apiErrors';
import type { FinalizationState } from '@/types/server';
import type { VoteChoice } from '@/shared/constants';
import type { ScenarioResult } from '@/lib/scenarios/processor';
import type { ScenarioTamperMode } from '@/types/scenario';
import type { FinalizeAcceptedResponse, FinalizeSyncResponse } from '@/lib/validation/apiSchemas';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type FinalizeSessionError =
  | {
      kind: 'api';
      code: ErrorCode;
      details?: ErrorDetails;
    }
  | {
      kind: 'invalid_image_id';
      expected: string;
      actual: string | null;
    };

export type FinalizeAcceptedPayload = Omit<FinalizeAcceptedResponse, 'queue'>;
export type FinalizeSyncPayload = FinalizeSyncResponse['data'];

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

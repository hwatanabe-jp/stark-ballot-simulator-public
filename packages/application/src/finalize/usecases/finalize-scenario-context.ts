import type { FinalizationScenarioContext } from '@stark-ballot/application/finalize/finalization-types';
import type { FinalizeScenarioContext } from './types';

export function toFinalizationScenarioContext(scenario: FinalizeScenarioContext): FinalizationScenarioContext {
  return {
    scenarios: scenario.scenariosApplied,
    tamperMode: scenario.tamperMode,
    claimedCounts: scenario.claimedCounts,
    claimedTotalVotes: scenario.claimedTotalVotes,
    summary: {
      ignoredCount: scenario.summary.ignoredCount,
      recountedCount: scenario.summary.recountedCount,
      userRecountChoice: scenario.summary.userRecountChoice,
      ...(scenario.affectedBotIds ? { affectedBotIds: scenario.affectedBotIds } : {}),
    },
  };
}

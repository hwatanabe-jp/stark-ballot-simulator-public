export const ScenarioIds = ['S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type ScenarioId = (typeof ScenarioIds)[number];

/**
 * Defines mutual exclusion rules for scenarios
 */
const EXCLUSION_RULES: Record<ScenarioId, ScenarioId[]> = {
  S1: ['S2'],
  S2: ['S1'],
  S3: ['S4'],
  S4: ['S3'],
  S5: [],
};

/**
 * Enforces mutual exclusion rules when toggling a scenario
 * Returns a new Set with the updated selection
 */
export function toggleScenario(scenarioId: ScenarioId, currentSelection: Set<ScenarioId>): Set<ScenarioId> {
  const newSelection = new Set(currentSelection);

  if (newSelection.has(scenarioId)) {
    // Remove the scenario if it's already selected
    newSelection.delete(scenarioId);
  } else {
    // Add the scenario
    newSelection.add(scenarioId);
  }

  return newSelection;
}

/**
 * Returns a list of scenarios that are in conflict within the provided selection.
 * The result contains every scenario that shares a mutual exclusion pair.
 */
export function getScenarioConflicts(selectedScenarios: Set<ScenarioId>): ScenarioId[] {
  const conflicts = new Set<ScenarioId>();
  selectedScenarios.forEach((scenarioId) => {
    const exclusions = EXCLUSION_RULES[scenarioId];
    exclusions.forEach((excludedId) => {
      if (selectedScenarios.has(excludedId)) {
        conflicts.add(scenarioId);
        conflicts.add(excludedId);
      }
    });
  });
  return Array.from(conflicts);
}

/**
 * Determines whether any conflicts exist within the selection.
 */
export function hasScenarioConflicts(selectedScenarios: Set<ScenarioId>): boolean {
  return getScenarioConflicts(selectedScenarios).length > 0;
}

/**
 * True if the provided scenario is part of a conflicting pair inside the selection.
 */
export function isScenarioInConflict(scenarioId: ScenarioId, selectedScenarios: Set<ScenarioId>): boolean {
  if (!selectedScenarios.has(scenarioId)) {
    return false;
  }
  const conflicts = getScenarioConflicts(selectedScenarios);
  return conflicts.includes(scenarioId);
}

/**
 * Validates if a combination of scenarios is valid
 */
export function isValidScenarioCombination(scenarios: ScenarioId[]): boolean {
  const scenarioSet = new Set(scenarios);

  for (const scenario of scenarios) {
    const exclusions = EXCLUSION_RULES[scenario];
    for (const excluded of exclusions) {
      if (scenarioSet.has(excluded)) {
        return false;
      }
    }
  }

  return true;
}

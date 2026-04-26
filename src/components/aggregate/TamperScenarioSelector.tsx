'use client';

import { useTranslation } from '@/lib/hooks';
import { RadioGroup } from '@/components/ui/RadioGroup';

/**
 * Scenario ID type
 */
export type ScenarioId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

interface TamperScenario {
  id: ScenarioId;
}

const SCENARIOS: TamperScenario[] = [
  { id: 'S0' },
  { id: 'S1' },
  { id: 'S2' },
  { id: 'S3' },
  { id: 'S4' },
  { id: 'S5' },
];

const SCENARIO_TEXT_KEYS: Record<
  ScenarioId,
  {
    label: 'scenarios.s0' | 'scenarios.s1' | 'scenarios.s2' | 'scenarios.s3' | 'scenarios.s4' | 'scenarios.s5';
    description:
      | 'scenarios.s0Description'
      | 'scenarios.s1Description'
      | 'scenarios.s2Description'
      | 'scenarios.s3Description'
      | 'scenarios.s4Description'
      | 'scenarios.s5Description';
  }
> = {
  S0: { label: 'scenarios.s0', description: 'scenarios.s0Description' },
  S1: { label: 'scenarios.s1', description: 'scenarios.s1Description' },
  S2: { label: 'scenarios.s2', description: 'scenarios.s2Description' },
  S3: { label: 'scenarios.s3', description: 'scenarios.s3Description' },
  S4: { label: 'scenarios.s4', description: 'scenarios.s4Description' },
  S5: { label: 'scenarios.s5', description: 'scenarios.s5Description' },
};

interface TamperScenarioSelectorProps {
  /** Currently selected scenario ID */
  value: ScenarioId | null;
  /** Callback when selection changes */
  onChange: (id: ScenarioId) => void;
  /** Whether the selector is disabled */
  disabled?: boolean;
}

/**
 * Tamper Scenario Selector
 *
 * Single-select UI for choosing tampering scenarios (S0-S5)
 * with Japanese labels. S2 and S4 are selectable as educational
 * scenarios that tamper the claimed tally while proofs remain correct.
 *
 * Design spec:
 * - RadioGroup style (single selection)
 * - No default selection (user must choose)
 * - Scenario IDs (S0-S5) hidden from user (internal API mapping)
 */
export function TamperScenarioSelector({
  value,
  onChange,
  disabled = false,
}: TamperScenarioSelectorProps): React.ReactElement {
  const { t } = useTranslation();

  const options = SCENARIOS.map((scenario) => ({
    value: scenario.id,
    label: t(SCENARIO_TEXT_KEYS[scenario.id].label),
    description: t(SCENARIO_TEXT_KEYS[scenario.id].description),
    testId: `scenario-radio-${scenario.id}`,
  }));

  return (
    <RadioGroup
      name="tamper-scenario"
      label={t('pages.aggregate.scenarios.title')}
      options={options}
      value={value ?? ''}
      onChange={(next) => onChange(next as ScenarioId)}
      disabled={disabled}
    />
  );
}

'use client';

import { InfographicProblemSolution } from './InfographicProblemSolution';
import { InfographicSteps } from './InfographicSteps';
import { InfographicGuarantees } from './InfographicGuarantees';

export function Infographic(): React.ReactElement {
  return (
    <div className="space-y-6">
      <InfographicProblemSolution style={{ animationDelay: '100ms' }} />
      <hr className="border-ink-100" />
      <InfographicSteps style={{ animationDelay: '200ms' }} />
      <hr className="border-ink-100" />
      <InfographicGuarantees style={{ animationDelay: '300ms' }} />
    </div>
  );
}

'use client';

import { InfographicSteps } from './InfographicSteps';
import { InfographicGuarantees } from './InfographicGuarantees';

export function Infographic(): React.ReactElement {
  return (
    <div className="home-details">
      <InfographicSteps />
      <InfographicGuarantees />
    </div>
  );
}

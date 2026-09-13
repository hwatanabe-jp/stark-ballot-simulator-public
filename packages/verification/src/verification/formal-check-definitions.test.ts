import { describe, expect, it } from 'vitest';
import { VERIFICATION_CHECK_DEFINITIONS, isVerificationCheckRequired } from '@stark-ballot/verification/checks';
import { parseCurrentFormalVectorEnvelope } from '@stark-ballot/zkvm-contract/zkvm/formal-vectors';
import checkDefinitionsJson from '../../../../docs/formal/generated-vectors/check-definitions.json';

const formalDefinitions = parseCurrentFormalVectorEnvelope(checkDefinitionsJson, 'check-definitions').payload;

describe('formal verification check definition drift guard', () => {
  it('keeps Lean summary-model check metadata aligned with TypeScript definitions', () => {
    const implementationDefinitions = VERIFICATION_CHECK_DEFINITIONS.map((definition) => ({
      id: definition.id,
      category: definition.category,
      role: definition.role,
      criticality: definition.criticality,
      requiredWhenSthSourcesConfigured: isVerificationCheckRequired(definition, { sthSourcesConfigured: true }),
      requiredWhenSthSourcesNotConfigured: isVerificationCheckRequired(definition, { sthSourcesConfigured: false }),
    }));

    expect(implementationDefinitions).toEqual(formalDefinitions);
  });
});

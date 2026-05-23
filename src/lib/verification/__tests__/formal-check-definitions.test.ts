import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  isVerificationCheckRequired,
  type VerificationCheckCriticality,
  type VerificationCheckId,
  type VerificationCheckRole,
} from '@/lib/verification/verification-checks';
import type { VerificationStepId } from '@/lib/knowledge';
import checkDefinitionsJson from '../../../../docs/current/formal/generated-vectors/check-definitions.json';

interface FormalCheckDefinition {
  id: VerificationCheckId;
  category: VerificationStepId;
  role: VerificationCheckRole;
  criticality: VerificationCheckCriticality;
  requiredWhenSthSourcesConfigured: boolean;
  requiredWhenSthSourcesNotConfigured: boolean;
}

const formalDefinitions = checkDefinitionsJson as FormalCheckDefinition[];

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

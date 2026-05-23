import { describe, expect, it } from 'vitest';
import type { VerificationStepStatus } from '@/lib/knowledge';
import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@/lib/verification/verification-checks';
import {
  deriveVerificationSummary,
  type VerificationSummaryContext,
  type VerificationSummaryStatus,
  type VerificationSummaryTone,
} from '@/lib/verification/verification-summary';
import summaryCasesJson from '../../../../docs/current/formal/generated-vectors/verification-summary-cases.json';

interface FormalSummaryCase {
  name: string;
  context: VerificationSummaryContext;
  checkStatuses: Partial<Record<VerificationCheckId, VerificationStepStatus>>;
  omitChecks: VerificationCheckId[];
  extraKnownChecks: Array<{
    id: VerificationCheckId;
    status: VerificationStepStatus;
  }>;
  extraUnknownChecks: Array<{
    id: string;
    status: VerificationStepStatus;
  }>;
  expectedStatus: VerificationSummaryStatus;
  expectedTone: VerificationSummaryTone;
}

const summaryCases = summaryCasesJson as FormalSummaryCase[];

function buildChecks(testCase: FormalSummaryCase): VerificationCheck[] {
  const omitted = new Set<VerificationCheckId>(testCase.omitChecks);
  const checks: VerificationCheck[] = VERIFICATION_CHECK_DEFINITIONS.filter(
    (definition) => !omitted.has(definition.id),
  ).map((definition) => ({
    id: definition.id,
    status: testCase.checkStatuses[definition.id] ?? 'success',
    evidence: definition.evidence,
    inputs: definition.inputs,
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  }));

  for (const extraCheck of testCase.extraKnownChecks) {
    const definition = VERIFICATION_CHECK_DEFINITIONS.find((candidate) => candidate.id === extraCheck.id);
    if (!definition) {
      throw new Error(`Unknown formal vector check id: ${extraCheck.id}`);
    }
    checks.push({
      id: definition.id,
      status: extraCheck.status,
      evidence: definition.evidence,
      inputs: definition.inputs,
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    });
  }

  for (const unknownCheck of testCase.extraUnknownChecks) {
    checks.push({
      id: unknownCheck.id as unknown as VerificationCheckId,
      status: unknownCheck.status,
      evidence: 'demo',
      inputs: [],
    });
  }

  return checks;
}

describe('formal verification summary vectors', () => {
  it.each(summaryCases)('$name', (testCase) => {
    const summary = deriveVerificationSummary(buildChecks(testCase), testCase.context);

    expect(summary?.status).toBe(testCase.expectedStatus);
    expect(summary?.tone).toBe(testCase.expectedTone);
  });
});

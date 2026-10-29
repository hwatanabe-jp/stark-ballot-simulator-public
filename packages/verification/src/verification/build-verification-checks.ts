import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckDefinition,
  type VerificationCheckId,
} from '@stark-ballot/verification/checks';
import { evaluateChecks, type EvaluateChecksOptions } from '@stark-ballot/verification/check-evaluator';
import type { CheckResult, VerificationEvaluationInput } from '@stark-ballot/verification/engine-types';

type CastSource = 'server' | 'client';

const CHECK_IDS_ALL = Array.from(
  new Set(
    VERIFICATION_CHECK_DEFINITIONS.flatMap((definition) =>
      definition.derivedFrom ? [definition.id, definition.derivedFrom] : [definition.id],
    ),
  ),
);

const CHECK_IDS_WITHOUT_CAST = Array.from(
  new Set(
    VERIFICATION_CHECK_DEFINITIONS.filter((definition) => definition.category !== 'cast_as_intended').flatMap(
      (definition) => (definition.derivedFrom ? [definition.id, definition.derivedFrom] : [definition.id]),
    ),
  ),
);

export type BuildVerificationChecksInput = VerificationEvaluationInput & Readonly<{ castSource?: CastSource }>;

/**
 * Build detailed checks for a verification resource.
 */
export async function evaluateVerificationCheckResults(
  input: BuildVerificationChecksInput,
  options?: EvaluateChecksOptions,
): Promise<Map<VerificationCheckId, CheckResult>> {
  const castSource = input.castSource ?? 'client';
  const checkIds = castSource === 'client' ? CHECK_IDS_WITHOUT_CAST : CHECK_IDS_ALL;
  return evaluateChecks(input, checkIds, options);
}

export function buildVerificationChecksFromResults(
  input: BuildVerificationChecksInput,
  checks: Map<VerificationCheckId, CheckResult>,
): VerificationCheck[] {
  const castSource = input.castSource ?? 'client';
  const usesDevModeEvidence =
    input.verifierOutcome?.status === 'dev_mode' || input.verifierOutcome?.report?.dev_mode_receipt === true;

  return VERIFICATION_CHECK_DEFINITIONS.map((definition) =>
    projectVerificationCheck(definition, checks, castSource, usesDevModeEvidence),
  );
}

function projectVerificationCheck(
  definition: VerificationCheckDefinition,
  checks: ReadonlyMap<VerificationCheckId, CheckResult>,
  castSource: CastSource,
  usesDevModeEvidence: boolean,
): VerificationCheck {
  const evidence = usesDevModeEvidence && definition.evidence === 'zk' ? 'demo' : definition.evidence;

  if (castSource === 'client' && definition.category === 'cast_as_intended') {
    return {
      id: definition.id,
      status: 'not_run',
      evidence,
      inputs: [...definition.inputs],
    };
  }

  return projectEvaluatedVerificationCheck(definition, checks, evidence);
}

function projectEvaluatedVerificationCheck(
  definition: VerificationCheckDefinition,
  checks: ReadonlyMap<VerificationCheckId, CheckResult>,
  evidence: VerificationCheck['evidence'],
): VerificationCheck {
  const derivedResult = definition.derivedFrom ? checks.get(definition.derivedFrom) : undefined;
  const result = derivedResult ?? checks.get(definition.id);
  const noteKey = resolveCheckNote(checks.get(definition.id));
  const status = result?.status ?? 'not_run';
  const baseCheck = {
    id: definition.id,
    evidence,
    inputs: [...definition.inputs],
    ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
  };
  if (noteKey && (status === 'not_run' || status === 'failed')) {
    return { ...baseCheck, status, noteKey };
  }
  return { ...baseCheck, status };
}

function resolveCheckNote(result: CheckResult | undefined): VerificationCheck['noteKey'] {
  return result?.status === 'not_run' || result?.status === 'failed' ? result.noteKey : undefined;
}

/**
 * Build detailed checks for a verification resource.
 */
export async function buildVerificationChecks(input: BuildVerificationChecksInput): Promise<VerificationCheck[]> {
  const checks = await evaluateVerificationCheckResults(input);
  return buildVerificationChecksFromResults(input, checks);
}

import {
  VERIFICATION_CHECK_DEFINITIONS,
  type VerificationCheck,
  type VerificationCheckId,
} from '@/lib/verification/verification-checks';
import { evaluateChecks, type EvaluateChecksOptions } from '@/lib/verification/engine/evaluate-checks';
import type {
  CheckResult,
  VerificationStatus,
  BulletinConsistencyProvider,
  VerificationContext,
} from '@/lib/verification/engine/types';
import type { BitmapProofSource } from '@/types/server';

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

export interface BuildVerificationChecksInput extends VerificationContext {
  verificationStatus?: VerificationStatus;
  verificationReportStatus?: VerificationStatus;
  verificationReport?: {
    expected_image_id?: string;
    receipt_image_id?: string | null;
  };
  allowDevModeVerification?: boolean;
  bitmapProofSource?: BitmapProofSource;
  bulletin?: BulletinConsistencyProvider;
  castSource?: CastSource;
}

/**
 * Build detailed verification checks for /api/verify responses.
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

  return VERIFICATION_CHECK_DEFINITIONS.map((definition) => {
    if (castSource === 'client' && definition.category === 'cast_as_intended') {
      return {
        id: definition.id,
        status: 'not_run',
        evidence: definition.evidence,
        inputs: definition.inputs,
      };
    }

    const derivedResult = definition.derivedFrom ? checks.get(definition.derivedFrom) : undefined;
    const result = derivedResult ?? checks.get(definition.id);
    const noteKey = checks.get(definition.id)?.noteKey;
    return {
      id: definition.id,
      status: result?.status ?? 'not_run',
      evidence: definition.evidence,
      inputs: definition.inputs,
      ...(noteKey ? { noteKey } : {}),
      ...(definition.derivedFrom ? { derivedFrom: definition.derivedFrom } : {}),
    };
  });
}

/**
 * Build detailed verification checks for /api/verify responses.
 */
export async function buildVerificationChecks(input: BuildVerificationChecksInput): Promise<VerificationCheck[]> {
  const checks = await evaluateVerificationCheckResults(input);
  return buildVerificationChecksFromResults(input, checks);
}

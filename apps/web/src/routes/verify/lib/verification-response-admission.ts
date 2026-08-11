import { verificationResourceSchema, type VerificationResource } from '@stark-ballot/api-contract/schemas/verification';

function corruptVerificationResource(finalizationId: string, message: string): VerificationResource {
  return {
    availability: 'corrupt',
    finalizationId,
    reason: 'invalid_artifact',
    message,
  };
}

export function admitVerificationResourceSnapshot(
  input: unknown,
  expectedFinalizationId: string,
): VerificationResource {
  const parsed = verificationResourceSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? 'schema validation failed';
    return corruptVerificationResource(expectedFinalizationId, `Invalid verification snapshot: ${issue}`);
  }
  if (parsed.data.finalizationId !== expectedFinalizationId) {
    return corruptVerificationResource(expectedFinalizationId, 'Verification snapshot finalization identity mismatch');
  }
  return parsed.data;
}

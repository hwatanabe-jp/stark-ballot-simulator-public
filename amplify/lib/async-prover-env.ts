export type RequiredAsyncProverArns = {
  queueArn: string;
  stateMachineArn: string;
};

type RequiredAsyncProverEnvKey = 'PROVER_STATE_MACHINE_ARN' | 'PROVER_WORK_QUEUE_ARN';

function normalizeRequiredEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the async prover ARNs from explicit environment variables.
 *
 * The Amplify backend must fail closed here so deployments never fall back to
 * legacy generic resource names during environment drift.
 */
export function resolveRequiredAsyncProverArns(
  env: Pick<NodeJS.ProcessEnv, RequiredAsyncProverEnvKey> = process.env,
): RequiredAsyncProverArns {
  const stateMachineArn = normalizeRequiredEnvValue(env.PROVER_STATE_MACHINE_ARN);
  const queueArn = normalizeRequiredEnvValue(env.PROVER_WORK_QUEUE_ARN);

  const missingKeys = (
    [
      !stateMachineArn ? 'PROVER_STATE_MACHINE_ARN' : null,
      !queueArn ? 'PROVER_WORK_QUEUE_ARN' : null,
    ] satisfies Array<RequiredAsyncProverEnvKey | null>
  ).filter((key): key is RequiredAsyncProverEnvKey => key !== null);

  if (missingKeys.length > 0) {
    throw new Error(`Missing required async prover environment variables: ${missingKeys.join(', ')}`);
  }

  return {
    stateMachineArn,
    queueArn,
  };
}

import { DescribeExecutionCommand, SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import type { ResolvedRuntimeProfile } from '@stark-ballot/runtime-config/env/runtimeProfile';

let sfnClient: SFNClient | null = null;

function getStepFunctionsClient(profile: ResolvedRuntimeProfile): SFNClient {
  if (profile.external.kind !== 'aws') {
    throw new Error('Step Functions requires a target AWS runtime profile');
  }
  if (!sfnClient) {
    sfnClient = new SFNClient({ region: profile.external.region });
  }
  return sfnClient;
}

export function _setStepFunctionsClient(client: SFNClient | null): void {
  sfnClient = client;
}

export type StepFunctionsExecutionDetails = {
  status: string | null;
  startTimeMs: number | null;
  stopTimeMs: number | null;
};

export async function describeFinalizationExecution(
  profile: ResolvedRuntimeProfile,
  executionArn: string,
): Promise<StepFunctionsExecutionDetails> {
  const response = await getStepFunctionsClient(profile).send(new DescribeExecutionCommand({ executionArn }));
  return {
    status: response.status ?? null,
    startTimeMs: response.startDate ? response.startDate.getTime() : null,
    stopTimeMs: response.stopDate ? response.stopDate.getTime() : null,
  };
}

export async function stopFinalizationExecution(
  profile: ResolvedRuntimeProfile,
  executionArn: string,
  reason: string,
): Promise<void> {
  await getStepFunctionsClient(profile).send(
    new StopExecutionCommand({
      executionArn,
      cause: reason,
    }),
  );
}

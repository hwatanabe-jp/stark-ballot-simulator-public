import { DescribeExecutionCommand, SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';

let sfnClient: SFNClient | null = null;

function getStepFunctionsClient(): SFNClient {
  if (!sfnClient) {
    sfnClient = new SFNClient({});
  }
  return sfnClient;
}

export function _setStepFunctionsClient(client: SFNClient | null): void {
  sfnClient = client;
}

export type StepFunctionsExecutionDetails = {
  status: string | null;
  startTime: number | null;
  stopTime: number | null;
};

export async function describeFinalizationExecution(executionArn: string): Promise<StepFunctionsExecutionDetails> {
  const response = await getStepFunctionsClient().send(new DescribeExecutionCommand({ executionArn }));
  return {
    status: response.status ?? null,
    startTime: response.startDate ? response.startDate.getTime() : null,
    stopTime: response.stopDate ? response.stopDate.getTime() : null,
  };
}

export async function stopFinalizationExecution(executionArn: string, reason: string): Promise<void> {
  await getStepFunctionsClient().send(
    new StopExecutionCommand({
      executionArn,
      cause: reason,
    }),
  );
}

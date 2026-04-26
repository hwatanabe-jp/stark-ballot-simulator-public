import { Buffer } from 'buffer';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { VerifierServiceRunnerPayload, VerifierServiceRunnerResponse } from './verifier-service-runner-types';

let cachedLambdaClient: LambdaClient | null = null;

function getLambdaClient(): LambdaClient {
  if (!cachedLambdaClient) {
    cachedLambdaClient = new LambdaClient({});
  }
  return cachedLambdaClient;
}

export function _setLambdaClient(client: LambdaClient | null): void {
  cachedLambdaClient = client;
}

function resolveVerifierRunnerFunctionName(): string {
  const explicit = process.env.VERIFIER_SERVICE_RUNNER_FUNCTION_NAME ?? process.env.VERIFIER_SERVICE_RUNNER_ARN ?? '';
  if (explicit.trim().length > 0) {
    return explicit.trim();
  }
  throw new Error('VERIFIER_SERVICE_RUNNER_FUNCTION_NAME is required to invoke verifier-service-runner');
}

function decodePayload(payload?: Uint8Array): string {
  if (!payload) {
    return '';
  }
  return Buffer.from(payload).toString('utf-8');
}

export async function invokeVerifierServiceRunner(
  payload: VerifierServiceRunnerPayload,
): Promise<VerifierServiceRunnerResponse> {
  const client = getLambdaClient();
  const functionName = resolveVerifierRunnerFunctionName();
  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  });

  const response = await client.send(command);
  const decoded = decodePayload(response.Payload);

  if (response.FunctionError) {
    throw new Error(
      `verifier-service-runner returned FunctionError (${response.FunctionError}): ${decoded || 'no payload'}`,
    );
  }

  if (!decoded) {
    throw new Error('verifier-service-runner returned empty payload');
  }

  return JSON.parse(decoded) as VerifierServiceRunnerResponse;
}

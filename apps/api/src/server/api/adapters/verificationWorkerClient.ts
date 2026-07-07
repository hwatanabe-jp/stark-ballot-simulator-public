import { Buffer } from 'node:buffer';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type {
  VerificationWorkerPayload,
  VerificationWorkerResponse,
} from '@stark-ballot/aws-adapters/lambda/verification-worker-contract';
import { parseVerificationWorkerResponse } from '@stark-ballot/aws-adapters/lambda/verification-worker-contract';
import { logger } from '@stark-ballot/diagnostics/logger';

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

function resolveVerificationWorkerFunctionName(): string {
  const explicit = process.env['VERIFICATION_WORKER_FUNCTION_NAME'] ?? process.env['VERIFICATION_WORKER_ARN'] ?? '';
  if (explicit.trim().length > 0) {
    return explicit.trim();
  }
  throw new Error('VERIFICATION_WORKER_FUNCTION_NAME is required to invoke verification-worker');
}

function decodePayload(payload?: Uint8Array): string {
  if (!payload) {
    return '';
  }
  return Buffer.from(payload).toString('utf-8');
}

export async function invokeVerificationWorker(
  payload: VerificationWorkerPayload,
): Promise<VerificationWorkerResponse> {
  const client = getLambdaClient();
  const functionName = resolveVerificationWorkerFunctionName();
  const command = new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  });

  const response = await client.send(command);
  const decoded = decodePayload(response.Payload);

  if (response.FunctionError) {
    logger.error('[VerificationWorkerClient] verification-worker returned FunctionError', {
      functionName,
      functionError: response.FunctionError,
      payload: decoded || undefined,
    });
    throw new Error('verification-worker invocation failed');
  }

  if (!decoded) {
    throw new Error('verification-worker returned empty payload');
  }

  return parseVerificationWorkerResponse(JSON.parse(decoded));
}

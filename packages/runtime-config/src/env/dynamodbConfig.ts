import { isIP } from 'node:net';
import { resolveRuntimeEnvMode } from '@stark-ballot/runtime-config/env/runtimeMode';

export function resolveDynamoDbRegion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const region = env['AWS_REGION']?.trim() || env['AWS_DEFAULT_REGION']?.trim();
  return region && region.length > 0 ? region : undefined;
}

export function requireDynamoDbRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region = resolveDynamoDbRegion(env);
  if (!region) {
    throw new Error('AWS_REGION or AWS_DEFAULT_REGION must be set for DynamoDB runtime access.');
  }
  return region;
}

export function resolveDynamoDbEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const endpoint = env['DYNAMODB_ENDPOINT']?.trim();
  return endpoint && endpoint.length > 0 ? endpoint : undefined;
}

function parseDynamoDbEndpoint(endpoint: string): URL {
  try {
    const parsed = new URL(endpoint);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
      throw new Error('invalid endpoint');
    }
    return parsed;
  } catch {
    throw new Error('DYNAMODB_ENDPOINT must be a valid URL.');
  }
}

function isLocalDynamoDbEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '::1') {
    return true;
  }
  if (isIP(host) === 4) {
    return host.split('.')[0] === '127';
  }
  return false;
}

export function assertDynamoDbEndpointAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const endpoint = resolveDynamoDbEndpoint(env);
  if (!endpoint) {
    return;
  }
  const parsed = parseDynamoDbEndpoint(endpoint);
  if (!isLocalDynamoDbEndpointHost(parsed.hostname)) {
    throw new Error('DYNAMODB_ENDPOINT must use a local loopback host for local endpoint exceptions.');
  }
  if (env['NODE_ENV'] === 'test') {
    return;
  }
  if (env['DYNAMODB_ENDPOINT_ALLOW_LOCAL'] === 'true' && resolveRuntimeEnvMode(env) === 'non-production') {
    return;
  }
  throw new Error('DYNAMODB_ENDPOINT is local/test-only and requires an explicit local endpoint exception.');
}

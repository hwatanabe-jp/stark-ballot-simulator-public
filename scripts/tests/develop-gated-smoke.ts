#!/usr/bin/env tsx
import { pathToFileURL } from 'node:url';
import { ErrorCode } from '@stark-ballot/api-contract/errors/apiErrors';
import { CLITestHelpers } from '@stark-ballot/test-support/testing/cli-test-helpers';
import { SESSION_CAPABILITY_HEADER, SESSION_ID_HEADER } from '@stark-ballot/domain/session/capability';
import { isRecord, getStringProperty } from '@stark-ballot/domain/utils/guards';
import { CLIVotingTest, type CLITestConfig } from './cli-e2e-voting-flow';

const OPERATOR_AUTH_HEADER_NAME_ENV = 'STARK_BALLOT_OPERATOR_AUTH_HEADER';
const OPERATOR_AUTH_HEADER_VALUE_ENV = 'STARK_BALLOT_OPERATOR_AUTH_VALUE';

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set.`);
  }
  return value;
}

export function resolveBaseUrl(): string {
  const value = process.env['STARK_BALLOT_DEVELOP_BASE_URL'] ?? process.env['STARK_BALLOT_CLI_BASE_URL'];
  if (!value?.trim()) {
    throw new Error('STARK_BALLOT_DEVELOP_BASE_URL or STARK_BALLOT_CLI_BASE_URL must be set.');
  }
  const parsed = new URL(value);
  if (process.env['STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE'] !== '1' && isLocalHostname(parsed.hostname)) {
    throw new Error('develop gated smoke refuses localhost unless STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE=1.');
  }
  return parsed.origin;
}

function isLocalHostname(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
}

export function operatorHeaders(): Record<string, string> {
  const name = readRequiredEnv(OPERATOR_AUTH_HEADER_NAME_ENV);
  const value = readRequiredEnv(OPERATOR_AUTH_HEADER_VALUE_ENV);
  return { [name]: value };
}

async function parseErrorCode(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  if (!isRecord(payload)) {
    return null;
  }
  return getStringProperty(payload, 'error') ?? null;
}

function isCloudFrontGateDenial(response: Response): boolean {
  if (response.status !== 401 && response.status !== 403) {
    return false;
  }

  const server = response.headers.get('server')?.toLowerCase() ?? '';
  const via = response.headers.get('via')?.toLowerCase() ?? '';
  const xCache = response.headers.get('x-cache')?.toLowerCase() ?? '';
  const poweredBy = response.headers.get('x-amz-cf-pop')?.toLowerCase() ?? '';
  return (
    server.includes('cloudfront') || via.includes('cloudfront') || xCache.includes('cloudfront') || poweredBy.length > 0
  );
}

export async function expectCloudFrontGateRejected(label: string, url: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(url, { redirect: 'manual', ...init });
  if (!isCloudFrontGateDenial(response)) {
    throw new Error(
      `${label} returned ${response.status}; expected a CloudFront signed-cookie gate denial with CloudFront response headers.`,
    );
  }
  console.log(`[develop-gated-smoke] ${label}: CloudFront gate rejected with ${response.status}`);
}

export async function expectJsonErrorCodeRejected(
  label: string,
  url: string,
  expectedErrorCode: ErrorCode,
  init: RequestInit = {},
): Promise<void> {
  const response = await fetch(url, { redirect: 'manual', ...init });
  const actualErrorCode = await parseErrorCode(response);
  if ((response.status >= 200 && response.status < 300) || actualErrorCode !== expectedErrorCode) {
    throw new Error(
      `${label} returned ${response.status} with error ${actualErrorCode ?? '<none>'}; expected JSON error ${expectedErrorCode}.`,
    );
  }
  console.log(`[develop-gated-smoke] ${label}: rejected with ${expectedErrorCode}`);
}

export async function runNegativeGateChecks(baseUrl: string): Promise<void> {
  await expectCloudFrontGateRejected('unauthenticated GET /', `${baseUrl}/`);
  await expectCloudFrontGateRejected('unauthenticated POST /api/session', `${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await expectCloudFrontGateRejected('unauthenticated GET /api/verify', `${baseUrl}/api/verify`);
}

export async function runWrongCapabilityCheck(baseUrl: string, headers: Record<string, string>): Promise<void> {
  const helper = new CLITestHelpers(baseUrl, headers);
  const sessionId = await helper.createSession();
  await expectJsonErrorCodeRejected(
    'wrong capability GET /api/progress',
    `${baseUrl}/api/progress`,
    ErrorCode.SESSION_CAPABILITY_INVALID,
    {
      method: 'GET',
      headers: {
        ...headers,
        [SESSION_ID_HEADER]: sessionId,
        [SESSION_CAPABILITY_HEADER]: 'wrong-capability-token',
      },
    },
  );
}

function maySkipDirectOriginCheck(baseUrl: string): boolean {
  return process.env['STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE'] === '1' && isLocalHostname(new URL(baseUrl).hostname);
}

export async function runDirectOriginCheck(headers: Record<string, string>, baseUrl: string): Promise<void> {
  const directOrigin = process.env['STARK_BALLOT_DIRECT_API_ORIGIN']?.trim();
  if (!directOrigin) {
    if (maySkipDirectOriginCheck(baseUrl)) {
      console.log(
        '[develop-gated-smoke] STARK_BALLOT_DIRECT_API_ORIGIN unset; skipping direct-origin rejection probe in explicit local non-acceptance mode.',
      );
      return;
    }
    throw new Error(
      'STARK_BALLOT_DIRECT_API_ORIGIN must be set for develop gated smoke acceptance. Set STARK_BALLOT_ALLOW_LOCAL_GATED_SMOKE=1 only for local non-acceptance runs.',
    );
  }
  const origin = new URL(directOrigin).origin;
  await expectJsonErrorCodeRejected(
    'direct-origin POST /api/session',
    `${origin}/api/session`,
    ErrorCode.SAME_ORIGIN_REQUIRED,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
}

export function createPositiveOwnerFlowConfig(): CLITestConfig {
  return {
    scenarios: [],
    useRealZkVM: true,
    realMode: 'prod',
    verbose: false,
    outputFormat: 'table',
    allScenarios: false,
    scenario: 'S0',
    userChoice: 'A',
    skipBuild: true,
  };
}

async function runPositiveOwnerFlow(baseUrl: string): Promise<void> {
  process.env['STARK_BALLOT_CLI_BASE_URL'] = baseUrl;
  process.env['STARK_BALLOT_CLI_SKIP_BUILD'] = 'true';

  const config = createPositiveOwnerFlowConfig();
  const test = new CLIVotingTest(config);
  await test.setup();
  const result = await test.run();
  await test.teardown();
  if (!result.passed) {
    throw new Error('operator-gated S0 owner flow failed.');
  }
}

export async function main(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const headers = operatorHeaders();
  await runNegativeGateChecks(baseUrl);
  await runWrongCapabilityCheck(baseUrl, headers);
  await runDirectOriginCheck(headers, baseUrl);
  await runPositiveOwnerFlow(baseUrl);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

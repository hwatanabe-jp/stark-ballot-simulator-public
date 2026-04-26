import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

/** Compatible with @smithy/types AwsCredentialIdentity */
export type AwsCredentialIdentity = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
};

export type AwsCredentialIdentityProvider = () => Promise<AwsCredentialIdentity>;

export interface AppSyncSignerOptions {
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  region: string;
  service?: string;
}

export interface SignedAppSyncFetchInput {
  endpoint: string | URL;
  body: string;
  signer: SignatureV4;
  method?: string;
  headers?: Record<string, string>;
  fetcher?: typeof fetch;
}

export function createAppSyncSigner(options: AppSyncSignerOptions): SignatureV4 {
  return new SignatureV4({
    credentials: options.credentials,
    region: options.region,
    service: options.service ?? 'appsync',
    sha256: Sha256,
  });
}

export async function signedAppSyncFetch(input: SignedAppSyncFetchInput): Promise<Response> {
  const endpointUrl = typeof input.endpoint === 'string' ? new URL(input.endpoint) : input.endpoint;
  const method = input.method ?? 'POST';
  const request = new HttpRequest({
    protocol: endpointUrl.protocol,
    hostname: endpointUrl.hostname,
    port: endpointUrl.port ? Number(endpointUrl.port) : undefined,
    method,
    path: endpointUrl.pathname,
    query: buildQueryDictionary(endpointUrl.searchParams),
    headers: {
      host: endpointUrl.host,
      'content-type': 'application/json',
      ...input.headers,
    },
    body: input.body,
  });

  const signedRequest = await input.signer.sign(request);
  const headers = normalizeSignedHeaders(signedRequest.headers);
  ensureContentType(headers, input.headers);

  const fetcher = input.fetcher ?? fetch;

  return fetcher(endpointUrl.toString(), {
    method: signedRequest.method,
    headers,
    body: input.body,
  });
}

function buildQueryDictionary(searchParams: URLSearchParams): Record<string, string | string[]> | undefined {
  if (searchParams.size === 0) {
    return undefined;
  }

  const query: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    if (key in query) {
      const existing = query[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    } else {
      query[key] = value;
    }
  }

  return query;
}

function normalizeSignedHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue;
    }
    if (key.toLowerCase() === 'host') {
      // Fetch API adds the Host header automatically; keeping the signed value would duplicate it and break the request.
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

function ensureContentType(headers: Record<string, string>, source?: Record<string, string>): void {
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
  if (hasContentType) {
    return;
  }

  const fallback = findContentType(source) ?? 'application/json';
  headers['content-type'] = fallback;
}

function findContentType(source?: Record<string, string>): string | undefined {
  if (!source) {
    return undefined;
  }

  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === 'content-type') {
      return value;
    }
  }

  return undefined;
}

import { API_ROUTES, buildApiRouteUrl } from '@stark-ballot/api-contract/routes';
import { SthResponseSchema } from '@stark-ballot/api-contract/schemas/bulletin';
import { isValidHexString } from '@stark-ballot/crypto-primitives';
import type { EvidenceAcquisition } from '@stark-ballot/verification/engine-types';
import {
  verifySthConsensus,
  type AdmittedSthRecord,
  type SthVerificationInput,
  type SthVerificationResult,
} from '@stark-ballot/verification/sth-verifier';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

type FetchLike = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

export const SESSION_STH_SOURCE_TEMPLATE = `/api${API_ROUTES.sessionBulletinSth.path}`;

export interface SameOriginSthRequest {
  sourceTemplate: string;
  resolvedPath: string;
  auditorId?: string;
}

export type SameOriginSthProvider = (request: SameOriginSthRequest) => unknown;

export interface AcquireSthEvidenceOptions {
  sources: readonly string[];
  sessionId: string;
  sameOriginProvider?: SameOriginSthProvider;
  fetchImpl?: FetchLike;
}

export interface ResolveSthVerificationOptions extends AcquireSthEvidenceOptions {
  journal: SthVerificationInput;
  minMatchingSources?: number;
}

const EXTERNAL_STH_KEYS = new Set(['sthDigest', 'bulletinRoot', 'treeSize', 'timestamp', 'logId']);
const AUDITOR_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function admitCanonicalSthRecord(
  source: string,
  data: unknown,
  options: { requireAllFields: boolean },
): AdmittedSthRecord | null {
  if (!isRecord(data) || Object.keys(data).some((key) => !EXTERNAL_STH_KEYS.has(key))) {
    return null;
  }

  const sthDigest = data['sthDigest'];
  if (typeof sthDigest !== 'string' || !isValidHexString(sthDigest, 32)) {
    return null;
  }

  const bulletinRoot = data['bulletinRoot'];
  const treeSize = data['treeSize'];
  const timestamp = data['timestamp'];
  const logId = data['logId'];
  if (
    (options.requireAllFields || hasOwn(data, 'bulletinRoot')) &&
    (typeof bulletinRoot !== 'string' || !isValidHexString(bulletinRoot, 32))
  ) {
    return null;
  }
  if ((options.requireAllFields || hasOwn(data, 'treeSize')) && !isNonNegativeInteger(treeSize)) {
    return null;
  }
  if ((options.requireAllFields || hasOwn(data, 'timestamp')) && !isNonNegativeInteger(timestamp)) {
    return null;
  }
  if ((options.requireAllFields || hasOwn(data, 'logId')) && !isNonEmptyString(logId)) {
    return null;
  }

  return {
    source,
    sthDigest,
    ...omitUndefinedProperties({
      bulletinRoot: typeof bulletinRoot === 'string' ? bulletinRoot : undefined,
      treeSize: isNonNegativeInteger(treeSize) ? treeSize : undefined,
      timestamp: isNonNegativeInteger(timestamp) ? timestamp : undefined,
      logId: isNonEmptyString(logId) ? logId : undefined,
    }),
  };
}

/**
 * Admit the documented flat response returned by an external HTTPS auditor.
 * Same-origin API envelopes and legacy field aliases are deliberately not
 * accepted at this boundary.
 */
export function admitExternalSthProviderResponse(source: string, data: unknown): AdmittedSthRecord | null {
  return admitCanonicalSthRecord(source, data, { requireAllFields: false });
}

function admitSameOriginSthProjection(source: string, data: unknown): AdmittedSthRecord | null {
  const parsed = SthResponseSchema.shape.data.safeParse(data);
  if (!parsed.success) {
    return null;
  }
  return admitCanonicalSthRecord(source, parsed.data.sth, { requireAllFields: true });
}

type SameOriginSource = {
  auditorId?: string;
  resolvedPath: string;
};

function resolveSameOriginSourceTemplate(source: string, sessionId: string): SameOriginSource | null {
  if (!source.startsWith('/') || source.startsWith('//')) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(source, 'https://same-origin.invalid');
  } catch {
    return null;
  }
  if (parsed.pathname !== SESSION_STH_SOURCE_TEMPLATE || parsed.hash) {
    return null;
  }

  const queryKeys = [...parsed.searchParams.keys()];
  if (queryKeys.some((key) => key !== 'auditorId') || queryKeys.length > 1) {
    return null;
  }
  const auditorId = parsed.searchParams.get('auditorId') ?? undefined;
  if (auditorId !== undefined && !AUDITOR_ID_PATTERN.test(auditorId)) {
    return null;
  }

  const query = auditorId === undefined ? {} : { auditorId };
  return {
    ...omitUndefinedProperties({ auditorId }),
    resolvedPath: buildApiRouteUrl(API_ROUTES.sessionBulletinSth, {
      params: { sessionId },
      query,
    }),
  };
}

function resolveExternalSourceUrl(source: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    return null;
  }
  return parsed;
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike | null {
  return fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
}

async function acquireSameOriginSthEvidence(
  sourceTemplate: string,
  resolved: SameOriginSource,
  provider: SameOriginSthProvider | undefined,
): Promise<EvidenceAcquisition<AdmittedSthRecord>> {
  if (!provider) {
    return {
      kind: 'unavailable',
      message: `Same-origin STH source unavailable: ${sourceTemplate}`,
    };
  }

  let data: unknown;
  try {
    data = await provider({
      sourceTemplate,
      resolvedPath: resolved.resolvedPath,
      ...omitUndefinedProperties({ auditorId: resolved.auditorId }),
    });
  } catch (error) {
    return {
      kind: 'transport_failed',
      message: `Error acquiring STH from ${sourceTemplate}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (data === undefined || data === null) {
    return {
      kind: 'unavailable',
      message: `Same-origin STH source unavailable: ${sourceTemplate}`,
    };
  }

  const record = admitSameOriginSthProjection(resolved.resolvedPath, data);
  return record
    ? { kind: 'admitted', value: record }
    : {
        kind: 'malformed',
        message: `Malformed STH response from ${sourceTemplate}`,
      };
}

async function acquireExternalSthEvidence(
  source: string,
  sourceUrl: URL,
  fetchImpl: FetchLike | null,
): Promise<EvidenceAcquisition<AdmittedSthRecord>> {
  if (!fetchImpl) {
    return {
      kind: 'transport_failed',
      message: `Fetch implementation unavailable for STH source ${source}`,
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(sourceUrl.toString());
  } catch (error) {
    return {
      kind: 'transport_failed',
      message: `Error fetching STH from ${source}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    return {
      kind: 'transport_failed',
      message: `Failed to fetch STH from ${source}: ${response.status} ${response.statusText}`.trim(),
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    return {
      kind: 'malformed',
      message: `Malformed STH response from ${source}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const record = admitExternalSthProviderResponse(source, data);
  return record
    ? { kind: 'admitted', value: record }
    : {
        kind: 'malformed',
        message: `Malformed STH response from ${source}`,
      };
}

export async function acquireSthEvidenceFromProviders(
  options: AcquireSthEvidenceOptions,
): Promise<Array<EvidenceAcquisition<AdmittedSthRecord>>> {
  const sources = options.sources.map((source) => source.trim()).filter(Boolean);
  const fetchImpl = resolveFetch(options.fetchImpl);

  return Promise.all(
    sources.map(async (source) => {
      const sameOrigin = resolveSameOriginSourceTemplate(source, options.sessionId);
      if (sameOrigin) {
        return acquireSameOriginSthEvidence(source, sameOrigin, options.sameOriginProvider);
      }
      if (source.startsWith('/')) {
        return {
          kind: 'malformed' as const,
          message: `Malformed same-origin STH source: ${source}`,
        };
      }

      const externalUrl = resolveExternalSourceUrl(source);
      if (!externalUrl) {
        return {
          kind: 'malformed' as const,
          message: `Malformed external STH source: ${source}`,
        };
      }
      return acquireExternalSthEvidence(source, externalUrl, fetchImpl);
    }),
  );
}

export async function resolveSthVerificationFromProviders(
  options: ResolveSthVerificationOptions,
): Promise<SthVerificationResult> {
  const sources = options.sources.map((source) => source.trim()).filter(Boolean);
  if (sources.length === 0) {
    return {
      verified: false,
      consensus: false,
      sourcesChecked: 0,
      matchingSources: 0,
      errors: ['No STH sources configured'],
    };
  }

  const evidence = await acquireSthEvidenceFromProviders({
    sources,
    sessionId: options.sessionId,
    ...omitUndefinedProperties({
      sameOriginProvider: options.sameOriginProvider,
      fetchImpl: options.fetchImpl,
    }),
  });
  const records: AdmittedSthRecord[] = [];
  const errors: string[] = [];
  for (const item of evidence) {
    if (item.kind === 'admitted') {
      records.push(item.value);
    } else {
      errors.push(item.message ?? `STH evidence ${item.kind}`);
    }
  }

  const result = verifySthConsensus(options.journal, records, {
    ...omitUndefinedProperties({ minMatchingSources: options.minMatchingSources }),
    errors,
    sourcesChecked: sources.length,
  });
  if (errors.length === 0) {
    return result;
  }
  return {
    ...result,
    verified: false,
    consensus: false,
  };
}

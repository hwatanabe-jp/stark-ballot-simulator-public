import {
  verifySthConsensus,
  type AdmittedSthRecord,
  type SthVerificationInput,
  type SthVerificationResult,
} from '@stark-ballot/verification/sth-verifier';
import { isValidHexString } from '@stark-ballot/domain/utils/hex';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ResolveSthVerificationOptions {
  sources: readonly string[];
  journal: SthVerificationInput;
  minMatchingSources?: number;
  sameOriginOrigin?: string;
  sameOriginHeaders?: Record<string, string>;
  sameOriginProvider?: (source: string) => unknown;
  fetchImpl?: FetchLike;
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  const resolved = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
  if (!resolved) {
    throw new Error('Fetch implementation unavailable for STH verification');
  }
  return resolved;
}

function resolveSameOriginOrigin(explicit?: string): string | null {
  if (!explicit) {
    return null;
  }
  try {
    return new URL(explicit).origin;
  } catch {
    return null;
  }
}

function resolveSourceUrl(source: string, baseUrl?: string): string {
  if (!baseUrl) {
    return source;
  }
  try {
    return new URL(source, baseUrl).toString();
  } catch {
    return source;
  }
}

function isSameOriginResolvedUrl(resolvedUrl: string, sameOriginOrigin: string | null): boolean {
  if (!sameOriginOrigin) {
    return false;
  }
  try {
    return new URL(resolvedUrl).origin === sameOriginOrigin;
  } catch {
    return false;
  }
}

function getRecordField(record: Record<string, unknown>, camelKey: string, snakeKey?: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, camelKey)) {
    return record[camelKey];
  }
  if (snakeKey && Object.prototype.hasOwnProperty.call(record, snakeKey)) {
    return record[snakeKey];
  }
  return undefined;
}

function hasRecordField(record: Record<string, unknown>, camelKey: string, snakeKey?: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(record, camelKey) ||
    Boolean(snakeKey && Object.prototype.hasOwnProperty.call(record, snakeKey))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function admitSthProviderResponse(source: string, data: unknown): AdmittedSthRecord | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const outer = data as Record<string, unknown>;
  const rawRecord =
    outer['sth'] && typeof outer['sth'] === 'object' && !Array.isArray(outer['sth']) ? outer['sth'] : outer;
  const record = rawRecord as Record<string, unknown>;
  const rawDigest = getRecordField(record, 'sthDigest') ?? getRecordField(record, 'digest');
  if (typeof rawDigest !== 'string' || !isValidHexString(rawDigest, 32)) {
    return null;
  }

  const treeSize = getRecordField(record, 'treeSize');
  const timestamp = getRecordField(record, 'timestamp');
  const bulletinRoot = getRecordField(record, 'bulletinRoot') ?? getRecordField(record, 'root');
  const logId = getRecordField(record, 'logId', 'log_id');
  if (
    (hasRecordField(record, 'treeSize') && !isNonNegativeInteger(treeSize)) ||
    (hasRecordField(record, 'bulletinRoot', 'root') &&
      (typeof bulletinRoot !== 'string' || !isValidHexString(bulletinRoot, 32))) ||
    (hasRecordField(record, 'timestamp') && !isNonNegativeInteger(timestamp)) ||
    (hasRecordField(record, 'logId', 'log_id') && !isNonEmptyString(logId))
  ) {
    return null;
  }
  const admittedTreeSize = isNonNegativeInteger(treeSize) ? treeSize : undefined;
  const admittedBulletinRoot =
    typeof bulletinRoot === 'string' && isValidHexString(bulletinRoot, 32) ? bulletinRoot : undefined;
  const admittedTimestamp = isNonNegativeInteger(timestamp) ? timestamp : undefined;
  const admittedLogId = isNonEmptyString(logId) ? logId : undefined;

  return {
    source,
    sthDigest: rawDigest,
    ...(admittedTreeSize !== undefined ? { treeSize: admittedTreeSize } : {}),
    ...(admittedBulletinRoot !== undefined ? { bulletinRoot: admittedBulletinRoot } : {}),
    ...(admittedTimestamp !== undefined ? { timestamp: admittedTimestamp } : {}),
    ...(admittedLogId !== undefined ? { logId: admittedLogId } : {}),
  };
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

  let resolvedFetch: FetchLike;
  try {
    resolvedFetch = resolveFetch(options.fetchImpl);
  } catch (error) {
    return {
      verified: false,
      consensus: false,
      sourcesChecked: sources.length,
      matchingSources: 0,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const sameOriginOrigin = resolveSameOriginOrigin(options.sameOriginOrigin);
  const errors: string[] = [];
  const records: AdmittedSthRecord[] = [];

  await Promise.all(
    sources.map(async (source) => {
      try {
        const resolvedUrl = resolveSourceUrl(source, options.sameOriginOrigin);
        const isSameOrigin = isSameOriginResolvedUrl(resolvedUrl, sameOriginOrigin);
        if (isSameOrigin && options.sameOriginProvider) {
          const sameOriginData = await options.sameOriginProvider(source);
          if (sameOriginData !== undefined) {
            const record = admitSthProviderResponse(source, sameOriginData);
            if (!record) {
              errors.push(`Malformed STH response from ${source}`);
              return;
            }
            records.push(record);
            return;
          }
        }

        const headers = isSameOrigin ? options.sameOriginHeaders : undefined;
        const response = await resolvedFetch(
          resolvedUrl,
          headers && Object.keys(headers).length > 0 ? { headers } : undefined,
        );
        if (!response.ok) {
          errors.push(`Failed to fetch STH from ${source}: ${response.status} ${response.statusText}`.trim());
          return;
        }
        const json: unknown = await response.json();
        const record = admitSthProviderResponse(source, json);
        if (!record) {
          errors.push(`Malformed STH response from ${source}`);
          return;
        }
        records.push(record);
      } catch (error) {
        errors.push(`Error fetching STH from ${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  return verifySthConsensus(options.journal, records, {
    ...omitUndefinedProperties({ minMatchingSources: options.minMatchingSources }),
    errors,
    sourcesChecked: sources.length,
  });
}

import type { ZkVMJournal } from '@/lib/zkvm/types';
import { normalizeHexString } from '@/lib/utils/hex';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SthVerificationOptions {
  /**
   * Explicit list of sources to query. If omitted, environment/global configuration is used.
   */
  sources?: string[];
  /**
   * Custom fetch implementation (for tests).
   */
  fetchImpl?: FetchLike;
  /**
   * Minimum number of matching sources required for verification (defaults to 2).
   */
  minMatchingSources?: number;
  /**
   * Session ID to include in X-Session-ID header for API authentication.
   * Required for mock STH API endpoints that need session context.
   */
  sessionId?: string;
  /**
   * Additional headers to include in fetch requests.
   * Applied to every configured source.
   */
  headers?: Record<string, string>;
  /**
   * Headers that must only be forwarded to same-origin sources such as `/api/sth`.
   */
  sameOriginHeaders?: Record<string, string>;
  /**
   * Explicit origin used to determine whether an absolute source is same-origin.
   */
  sameOriginOrigin?: string;
}

export interface SthVerificationResult {
  verified: boolean;
  consensus: boolean;
  sourcesChecked: number;
  matchingSources: number;
  errors: string[];
}

function parseMinMatches(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return null;
}

interface ParsedSthRecord {
  sthDigest: string;
  treeSize?: number;
  bulletinRoot?: string;
  timestamp?: number;
  logId?: string;
}

function resolveSameOriginOrigin(explicit?: string): string | null {
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      return null;
    }
  }

  if (typeof window !== 'undefined' && window.location.origin) {
    return window.location.origin;
  }

  return null;
}

function isSameOriginSource(source: string, sameOriginOrigin: string | null): boolean {
  if (!source) {
    return false;
  }

  if (source.startsWith('/')) {
    return true;
  }

  if (!sameOriginOrigin) {
    return false;
  }

  try {
    return new URL(source).origin === sameOriginOrigin;
  } catch {
    return false;
  }
}

/**
 * Resolve configured STH sources from explicit options, global overrides, or environment variables.
 */
export function resolveConfiguredSthSources(explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) {
    return explicit.map((source) => source.trim()).filter(Boolean);
  }

  if (typeof globalThis !== 'undefined') {
    const override = (globalThis as unknown as { __STH_SOURCES?: unknown }).__STH_SOURCES;
    if (Array.isArray(override)) {
      return override.map((source) => String(source).trim()).filter(Boolean);
    }
  }

  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STH_SOURCES) {
    return process.env.NEXT_PUBLIC_STH_SOURCES.split(',')
      .map((source) => source.trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * Resolve configured minimum number of matching STH sources.
 */
export function resolveConfiguredSthMinMatches(): number {
  if (typeof globalThis !== 'undefined') {
    const override = (globalThis as unknown as { __STH_MIN_MATCHES?: unknown }).__STH_MIN_MATCHES;
    const parsed = parseMinMatches(override);
    if (parsed !== null) {
      return parsed;
    }
  }

  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STH_MIN_MATCHES) {
    const parsed = parseMinMatches(process.env.NEXT_PUBLIC_STH_MIN_MATCHES);
    if (parsed !== null) {
      return parsed;
    }
  }

  return 2;
}

/**
 * Parse a third-party STH response into a normalized structure.
 */
function parseSthResponse(data: unknown): ParsedSthRecord | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const record = (data as Record<string, unknown>).sth ?? data;

  const rawDigest =
    typeof (record as Record<string, unknown>).sthDigest === 'string'
      ? (record as Record<string, unknown>).sthDigest
      : typeof (record as Record<string, unknown>).digest === 'string'
        ? (record as Record<string, unknown>).digest
        : undefined;
  const sthDigest = typeof rawDigest === 'string' ? rawDigest : undefined;

  if (!sthDigest || normalizeHexString(sthDigest) === '') {
    return null;
  }

  const treeSizeValue = (record as Record<string, unknown>).treeSize;
  const timestampValue = (record as Record<string, unknown>).timestamp;
  const bulletinRootValue =
    (record as Record<string, unknown>).bulletinRoot ?? (record as Record<string, unknown>).root;
  const logIdValue = (record as Record<string, unknown>).logId ?? (record as Record<string, unknown>).log_id;

  return {
    sthDigest,
    treeSize: typeof treeSizeValue === 'number' ? treeSizeValue : undefined,
    bulletinRoot: typeof bulletinRootValue === 'string' ? bulletinRootValue : undefined,
    timestamp: typeof timestampValue === 'number' ? timestampValue : undefined,
    logId: typeof logIdValue === 'string' ? logIdValue : undefined,
  };
}

/**
 * Perform third-party STH verification to guard against split-view attacks.
 *
 * The verifier fetches STH snapshots from independent sources and requires
 * consensus on the digest (and other fields when provided).
 */
export type SthVerificationInput = Pick<ZkVMJournal, 'sthDigest' | 'bulletinRoot' | 'treeSize'>;

export async function verifySthThirdParty(
  journal: SthVerificationInput,
  options: SthVerificationOptions = {},
): Promise<SthVerificationResult> {
  const errors: string[] = [];
  const sources = resolveConfiguredSthSources(options.sources);
  const resolvedFetch = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);

  if (!resolvedFetch) {
    return {
      verified: false,
      consensus: false,
      sourcesChecked: 0,
      matchingSources: 0,
      errors: ['Fetch implementation unavailable for STH verification'],
    };
  }

  if (!journal.sthDigest || normalizeHexString(journal.sthDigest) === '') {
    return {
      verified: false,
      consensus: false,
      sourcesChecked: 0,
      matchingSources: 0,
      errors: ['Journal is missing sthDigest field'],
    };
  }

  if (sources.length === 0) {
    return {
      verified: false,
      consensus: false,
      sourcesChecked: 0,
      matchingSources: 0,
      errors: ['No STH sources configured (NEXT_PUBLIC_STH_SOURCES)'],
    };
  }

  const expectedDigest = normalizeHexString(journal.sthDigest);
  const expectedRoot = normalizeHexString(journal.bulletinRoot);
  const expectedTreeSize = journal.treeSize;
  const sameOriginOrigin = resolveSameOriginOrigin(options.sameOriginOrigin);
  const derivedSameOriginHeaders: Record<string, string> = {
    ...(options.sameOriginHeaders ?? {}),
  };
  if (options.sessionId && !derivedSameOriginHeaders['X-Session-ID']) {
    derivedSameOriginHeaders['X-Session-ID'] = options.sessionId;
  }

  let matchingSources = 0;
  let comparableSources = 0;

  const responses = await Promise.all(
    sources.map(async (source) => {
      try {
        const headers: Record<string, string> = {
          ...(options.headers ?? {}),
        };
        if (isSameOriginSource(source, sameOriginOrigin)) {
          Object.assign(headers, derivedSameOriginHeaders);
        }

        // Only pass headers object if it's non-empty
        const response = await resolvedFetch(source, Object.keys(headers).length > 0 ? { headers } : undefined);
        if (!response.ok) {
          errors.push(`Failed to fetch STH from ${source}: ${response.status} ${response.statusText}`.trim());
          return null;
        }
        const json: unknown = await response.json();
        return { source, record: parseSthResponse(json) };
      } catch (error) {
        errors.push(`Error fetching STH from ${source}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }),
  );

  for (const result of responses) {
    if (!result || !result.record) {
      continue;
    }

    comparableSources += 1;
    const record = result.record;
    const normalizedDigest = normalizeHexString(record.sthDigest);
    const normalizedRoot = record.bulletinRoot ? normalizeHexString(record.bulletinRoot) : undefined;

    const digestMatches = normalizedDigest === expectedDigest;
    const rootMatches = normalizedRoot ? normalizedRoot === expectedRoot : true;
    const treeSizeMatches = typeof record.treeSize === 'number' ? record.treeSize === expectedTreeSize : true;

    if (digestMatches && rootMatches && treeSizeMatches) {
      matchingSources += 1;
    } else {
      const mismatchReasons: string[] = [];
      if (!digestMatches) {
        mismatchReasons.push('digest mismatch');
      }
      if (!rootMatches) {
        mismatchReasons.push('root mismatch');
      }
      if (!treeSizeMatches) {
        mismatchReasons.push('tree size mismatch');
      }
      errors.push(
        `STH mismatch from ${result.source || 'unknown source'} (${mismatchReasons.join(', ') || 'unknown reason'})`,
      );
    }
  }

  const minMatches = options.minMatchingSources ?? 2;
  const consensus = comparableSources > 0 && matchingSources === comparableSources;
  const verified = matchingSources >= minMatches && consensus;

  if (!verified && matchingSources < minMatches) {
    errors.push(`Insufficient matching STH sources (expected at least ${minMatches}, got ${matchingSources}).`);
  }

  return {
    verified,
    consensus,
    sourcesChecked: sources.length,
    matchingSources,
    errors,
  };
}

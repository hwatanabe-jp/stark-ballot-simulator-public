import { DuplicateDetector } from './duplicate-detector';

export type DuplicateDetectorCacheOptions = {
  ttlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
};

type DetectorEntry = {
  detector: DuplicateDetector;
  lastSeen: number;
};

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function resolvePositiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/**
 * In-memory cache for per-session DuplicateDetector instances with TTL-based eviction.
 */
export class DuplicateDetectorCache {
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, DetectorEntry>();
  private lastCleanup = 0;

  /**
   * Create a cache that evicts detectors after TTL.
   */
  constructor(options: DuplicateDetectorCacheOptions = {}) {
    const ttlMs = resolvePositiveMs(options.ttlMs, DEFAULT_TTL_MS);
    const cleanupIntervalMs = resolvePositiveMs(options.cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS);

    this.ttlMs = ttlMs;
    this.cleanupIntervalMs = Math.min(cleanupIntervalMs, ttlMs);
    this.now = options.now ?? Date.now;
  }

  /**
   * Get or create a detector for the given session.
   */
  getOrCreate(sessionId: string): DuplicateDetector {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('Session ID is required to create a duplicate detector.');
    }

    const now = this.now();
    this.cleanupIfNeeded(now);

    const existing = this.entries.get(sessionId);
    if (existing) {
      if (now - existing.lastSeen > this.ttlMs) {
        this.entries.delete(sessionId);
      } else {
        existing.lastSeen = now;
        return existing.detector;
      }
    }

    const detector = new DuplicateDetector();
    this.entries.set(sessionId, { detector, lastSeen: now });
    return detector;
  }

  private cleanupIfNeeded(now: number): void {
    if (now - this.lastCleanup < this.cleanupIntervalMs) {
      return;
    }

    for (const [sessionId, entry] of this.entries) {
      if (now - entry.lastSeen > this.ttlMs) {
        this.entries.delete(sessionId);
      }
    }

    this.lastCleanup = now;
  }
}

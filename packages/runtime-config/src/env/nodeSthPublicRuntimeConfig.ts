const STH_SOURCES_KEYS = ['VITE_STH_SOURCES'] as const;
const STH_MIN_MATCHES_KEYS = ['VITE_STH_MIN_MATCHES'] as const;

type SthSourceEnvKey = (typeof STH_SOURCES_KEYS)[number];
type SthMinMatchesEnvKey = (typeof STH_MIN_MATCHES_KEYS)[number];
type SthPublicEnvKey = SthSourceEnvKey | SthMinMatchesEnvKey;

export interface NodeSthPublicRuntimeConfig {
  sources: string[];
  minMatchingSources: number;
}

function readFirstConfiguredEnv(keys: readonly SthPublicEnvKey[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function parseSources(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean);
}

function parseMinMatches(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function resolveNodeConfiguredSthSources(): string[] {
  return parseSources(readFirstConfiguredEnv(STH_SOURCES_KEYS));
}

export function resolveNodeConfiguredSthMinMatches(): number {
  return parseMinMatches(readFirstConfiguredEnv(STH_MIN_MATCHES_KEYS)) ?? 2;
}

/**
 * Resolves public STH config for Node/static-Hono request handling.
 */
export function resolveNodeSthPublicRuntimeConfig(): NodeSthPublicRuntimeConfig {
  return {
    sources: resolveNodeConfiguredSthSources(),
    minMatchingSources: resolveNodeConfiguredSthMinMatches(),
  };
}

type BrowserPublicEnvReader = (key: 'VITE_STH_SOURCES') => string | undefined;

export function resolveConfiguredSthSources(readEnv: BrowserPublicEnvReader): string[] {
  const configuredSources = readEnv('VITE_STH_SOURCES');
  if (!configuredSources) {
    return [];
  }

  return configuredSources
    .split(',')
    .map((source) => source.trim())
    .filter(Boolean);
}

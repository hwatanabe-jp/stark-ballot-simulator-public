import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserConfig, UserConfigExport } from 'vite';
import webViteConfig from './vite.config.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const mockFetcherPath = path.resolve(repositoryRoot, 'apps/web/src/mock-api/fetcher.ts');
const globalStylesPath = path.resolve(repositoryRoot, 'apps/web/src/styles/globals.css');

interface NamedPlugin {
  readonly generateBundle?: unknown;
  readonly name: string;
}

async function resolveUserConfig(config: UserConfigExport, mode: string): Promise<UserConfig> {
  if (typeof config === 'function') {
    return config({ command: 'build', isPreview: false, isSsrBuild: false, mode });
  }
  return config;
}

function collectNamedPlugins(value: unknown): NamedPlugin[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectNamedPlugins);
  }
  if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
    return [value as NamedPlugin];
  }
  return [];
}

function invokeGenerateBundleHook(plugin: NamedPlugin, moduleIds: readonly string[]): unknown {
  const bundle = {
    'assets/index.js': {
      type: 'chunk',
      moduleIds,
    },
  };
  if (typeof plugin.generateBundle === 'function') {
    return (plugin.generateBundle as (options: unknown, bundle: unknown) => unknown)({}, bundle);
  }
  if (
    plugin.generateBundle &&
    typeof plugin.generateBundle === 'object' &&
    'handler' in plugin.generateBundle &&
    typeof plugin.generateBundle.handler === 'function'
  ) {
    return (plugin.generateBundle.handler as (options: unknown, bundle: unknown) => unknown)({}, bundle);
  }
  throw new Error(`${plugin.name} must expose a generateBundle hook`);
}

function requirePlugin(config: UserConfig, name: string): NamedPlugin {
  const plugin = collectNamedPlugins(config.plugins).find((candidate) => candidate.name === name);
  if (!plugin) {
    throw new Error(`Vite config must include ${name}`);
  }
  return plugin;
}

describe('web target module graph policy', () => {
  it('rejects browser mock API module IDs from the completed target bundle and permits local mock builds', async () => {
    const targetConfig = await resolveUserConfig(webViteConfig, 'target');
    const localMockConfig = await resolveUserConfig(webViteConfig, 'local-mock');
    const targetPolicy = requirePlugin(targetConfig, 'browser-mock-api-module-boundary');
    const localMockPolicy = requirePlugin(localMockConfig, 'browser-mock-api-module-boundary');

    expect(targetPolicy).toBeDefined();
    expect(localMockPolicy).toBeDefined();
    expect(() => invokeGenerateBundleHook(targetPolicy, [mockFetcherPath])).toThrow(
      'Target build must not include browser mock API module',
    );
    expect(invokeGenerateBundleHook(localMockPolicy, [mockFetcherPath])).toBeUndefined();
  });

  it('bounds Tailwind source detection to browser source files and the app shell', () => {
    const globalStyles = readFileSync(globalStylesPath, 'utf8');

    expect(globalStyles).toContain("@import 'tailwindcss' source(none);");
    expect(globalStyles).toContain("@source '../';");
    expect(globalStyles).toContain("@source '../../../../index.html';");
    expect(globalStyles).not.toContain("@import 'tailwindcss';");
  });
});

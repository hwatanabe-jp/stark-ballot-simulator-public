import { describe, it, expect } from 'vitest';
import path from 'path';
import { promises as fs } from 'fs';
import { createHonoApp } from './hono';
import { getApiRouteDefinitions } from './registry';

const apiRoot = path.join(process.cwd(), 'src/app/api');

async function listRouteFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRouteFiles(fullPath)));
    } else if (entry.isFile() && entry.name === 'route.ts') {
      files.push(fullPath);
    }
  }

  return files;
}

function parseMethods(source: string): string[] {
  const methods = new Set<string>();
  const regex = /export const (GET|POST|PUT|PATCH|DELETE|OPTIONS)\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    methods.add(match[1]);
  }
  return Array.from(methods);
}

function toRoutePath(filePath: string): string | null {
  const relative = path.relative(apiRoot, path.dirname(filePath));
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    return '/';
  }
  if (segments[0] === 'hono') {
    return null;
  }
  if (segments.some((segment) => segment.includes('...'))) {
    return null;
  }

  const mapped = segments.map((segment) => {
    if (segment.startsWith('[') && segment.endsWith(']')) {
      return `:${segment.slice(1, -1)}`;
    }
    return segment;
  });

  return `/${mapped.join('/')}`;
}

describe('api route registry parity', () => {
  it('keeps Next route files aligned with registry', async () => {
    const files = await listRouteFiles(apiRoot);
    const nextKeys = new Set<string>();

    for (const file of files) {
      const routePath = toRoutePath(file);
      if (!routePath) {
        continue;
      }
      const source = await fs.readFile(file, 'utf-8');
      const methods = parseMethods(source);
      for (const method of methods) {
        nextKeys.add(`${method} ${routePath}`);
      }
    }

    const registryKeys = new Set(getApiRouteDefinitions('full').map((route) => `${route.method} ${route.path}`));

    expect(nextKeys).toEqual(registryKeys);
  });

  it('registers all registry routes in Hono', () => {
    const basePath = '/api';
    const app = createHonoApp({ mode: 'full', basePath });
    const honoRoutes = (app as unknown as { routes: { method: string; path: string }[] }).routes;
    const registered = new Set(honoRoutes.map((route) => `${route.method} ${route.path}`));
    const normalizedBasePath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;

    for (const route of getApiRouteDefinitions('full')) {
      expect(registered.has(`${route.method} ${normalizedBasePath}${route.path}`)).toBe(true);
    }
  });

  it('does not register mutation routes in readonly mode', () => {
    const basePath = '/api';
    const app = createHonoApp({ mode: 'readonly', basePath });
    const honoRoutes = (app as unknown as { routes: { method: string; path: string }[] }).routes;
    const registered = new Set(honoRoutes.map((route) => `${route.method} ${route.path}`));
    const normalizedBasePath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;

    for (const route of getApiRouteDefinitions('readonly')) {
      expect(registered.has(`${route.method} ${normalizedBasePath}${route.path}`)).toBe(true);
    }

    for (const route of getApiRouteDefinitions('full')) {
      if (route.kind === 'mutation') {
        expect(registered.has(`${route.method} ${normalizedBasePath}${route.path}`)).toBe(false);
      }
    }
  });

  it('keeps API routes registered in lambda mode', () => {
    const lambdaRoutes = getApiRouteDefinitions('lambda');
    const lambdaKeys = new Set(lambdaRoutes.map((route) => `${route.method} ${route.path}`));

    expect(lambdaKeys.has('POST /session')).toBe(true);
    expect(lambdaKeys.has('GET /verification/bundles/:sessionId/:executionId')).toBe(true);
    expect(lambdaKeys.has('POST /finalize/callback')).toBe(false);
  });
});

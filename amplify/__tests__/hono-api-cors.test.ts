/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backendSource = readFileSync(new URL('../backend.ts', import.meta.url), 'utf8');

function getCorsArrayProperty(propertyName: string): string {
  const corsStart = backendSource.indexOf('corsPreflight: {');
  expect(corsStart).toBeGreaterThanOrEqual(0);
  const corsEnd = backendSource.indexOf('  },', corsStart);
  expect(corsEnd).toBeGreaterThan(corsStart);

  const corsBlock = backendSource.slice(corsStart, corsEnd);
  const escapedPropertyName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escapedPropertyName}:\\s*\\[([\\s\\S]*?)\\]`).exec(corsBlock);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Hono API Gateway CORS config', () => {
  it('allows authenticated ranged bundle request headers', () => {
    const allowHeaders = getCorsArrayProperty('allowHeaders');

    expect(allowHeaders).toContain("'Content-Type'");
    expect(allowHeaders).toContain("'X-Session-ID'");
    expect(allowHeaders).toContain("'X-Session-Capability'");
    expect(allowHeaders).toContain("'Range'");
  });

  it('exposes ranged bundle response headers to browser JavaScript', () => {
    const exposeHeaders = getCorsArrayProperty('exposeHeaders');

    expect(exposeHeaders).toContain("'Content-Range'");
    expect(exposeHeaders).toContain("'Accept-Ranges'");
    expect(exposeHeaders).toContain("'X-Stark-Bundle-Range-Chunk-Size'");
  });
});

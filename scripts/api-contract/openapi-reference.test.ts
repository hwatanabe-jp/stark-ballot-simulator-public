import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkOpenApiReference, generateOpenApiReference, parseOpenApiReferenceCommand } from './openapi-reference';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryOutputPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stark-openapi-test-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'openapi.json');
}

describe('OpenAPI reference entrypoint', () => {
  it('accepts only explicit generate and check commands', () => {
    expect(parseOpenApiReferenceCommand(['generate'])).toBe('generate');
    expect(parseOpenApiReferenceCommand(['check'])).toBe('check');
    expect(() => parseOpenApiReferenceCommand([])).toThrow('Usage: openapi-reference.ts <generate|check>');
    expect(() => parseOpenApiReferenceCommand(['check', '--out', 'elsewhere'])).toThrow(
      'Usage: openapi-reference.ts <generate|check>',
    );
  });

  it('writes a validator-accepted deterministic document', async () => {
    const outputPath = await temporaryOutputPath();

    await generateOpenApiReference(outputPath);

    const generated = await readFile(outputPath, 'utf8');
    expect(JSON.parse(generated)).toHaveProperty('openapi', '3.1.0');
    await expect(checkOpenApiReference(outputPath)).resolves.toBeUndefined();
  });

  it('fails when tracked bytes are stale', async () => {
    const outputPath = await temporaryOutputPath();
    await writeFile(outputPath, '{}\n', 'utf8');

    await expect(checkOpenApiReference(outputPath)).rejects.toThrow(
      'Generated OpenAPI reference is stale; run pnpm api-contract:openapi:generate',
    );
  });
});

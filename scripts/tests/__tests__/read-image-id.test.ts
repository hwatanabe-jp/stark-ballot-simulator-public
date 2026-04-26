/**
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT_PATH = path.resolve(process.cwd(), 'verifier-service/scripts/read-image-id.mjs');

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'read-image-id-'));
}

function writeJson(dir: string, fileName: string, payload: unknown): string {
  const targetPath = path.join(dir, fileName);
  writeFileSync(targetPath, JSON.stringify(payload, null, 2));
  return targetPath;
}

function runScript(args: string[], env: Partial<NodeJS.ProcessEnv> = {}): string {
  return execFileSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  }).trim();
}

describe('read-image-id.mjs', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('reads imageId from direct payloads', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'receipt.json', {
      imageId: '0xabc123',
    });

    expect(runScript([jsonPath])).toBe('0xabc123');
  });

  it('reads image_id from direct payloads', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'receipt.json', {
      image_id: '0xdef456',
    });

    expect(runScript([jsonPath])).toBe('0xdef456');
  });

  it('reads the default mapping ImageID when explicitly requested', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', {
      current: '10',
      mappings: {
        '10': {
          expectedImageID: '0xdefault',
          expectedImageID_x86_64: '0xx8664',
        },
      },
    });

    expect(runScript([jsonPath, '--variant', 'default'])).toBe('0xdefault');
  });

  it('reads the x86_64 mapping ImageID when explicitly requested', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', {
      current: '10',
      mappings: {
        '10': {
          expectedImageID: '0xdefault',
          expectedImageID_x86_64: '0xx8664',
        },
      },
    });

    expect(runScript([jsonPath, '--variant', 'x86_64'])).toBe('0xx8664');
  });

  it('uses the default mapping ImageID when no variant is provided', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', {
      current: '10',
      mappings: {
        '10': {
          expectedImageID: '0xdefault',
          expectedImageID_x86_64: '0xx8664',
        },
      },
    });

    expect(runScript([jsonPath])).toBe('0xdefault');
  });

  it('uses EXPECTED_IMAGE_ID_VARIANT when no --variant flag is provided', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', {
      current: '10',
      mappings: {
        '10': {
          expectedImageID: '0xdefault',
          expectedImageID_x86_64: '0xx8664',
        },
      },
    });

    expect(runScript([jsonPath], { EXPECTED_IMAGE_ID_VARIANT: 'x86_64' })).toBe('0xx8664');
  });

  it('fails clearly when x86_64 is requested but the mapping does not provide it', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', {
      current: '10',
      mappings: {
        '10': {
          expectedImageID: '0xdefault',
        },
      },
    });

    const result = spawnSync('node', [SCRIPT_PATH, jsonPath, '--variant', 'x86_64'], {
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Expected ImageID variant x86_64 is not available for method version 10');
  });
});

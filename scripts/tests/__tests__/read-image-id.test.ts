/**
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT_PATH = path.resolve(process.cwd(), 'verifier-service/scripts/read-image-id.mjs');
const DEFAULT_IMAGE_ID = `0x${'1'.repeat(64)}`;
const X86_IMAGE_ID = `0x${'2'.repeat(64)}`;

function mappingPayload(x86State: 'confirmed' | 'unconfirmed' = 'confirmed'): unknown {
  const provenance = {
    evidenceType: 'accepted-prover-release',
    sourceSha: '3'.repeat(40),
    proverImageDigest: `sha256:${'4'.repeat(64)}`,
    candidateMetadataSha256: '5'.repeat(64),
    releaseRecordSha256: '6'.repeat(64),
    toolchainArtifactRecordSha256: '7'.repeat(64),
  };
  return {
    mappingType: 'image-id-mapping',
    current: '10',
    mappings: {
      '10': {
        methodVersion: 10,
        variants: {
          default: {
            state: 'confirmed',
            imageId: DEFAULT_IMAGE_ID,
            provenance,
          },
          x86_64:
            x86State === 'confirmed'
              ? {
                  state: 'confirmed',
                  imageId: X86_IMAGE_ID,
                  provenance,
                }
              : {
                  state: 'unconfirmed',
                  requiredEvidence: 'accepted-prover-release',
                },
        },
        description: 'test fixture',
        features: [],
      },
    },
    deprecated: [],
    metadata: {
      lastUpdated: '2026-07-26T00:00:00Z',
      purpose: 'test fixture',
      notes: 'test fixture',
    },
  };
}

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
    const jsonPath = writeJson(dir, 'mapping.json', mappingPayload());

    expect(runScript([jsonPath, '--variant', 'default'])).toBe(DEFAULT_IMAGE_ID);
  });

  it('reads the x86_64 mapping ImageID when explicitly requested', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', mappingPayload());

    expect(runScript([jsonPath, '--variant', 'x86_64'])).toBe(X86_IMAGE_ID);
  });

  it('uses the default mapping ImageID when no variant is provided', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', mappingPayload());

    expect(runScript([jsonPath], { EXPECTED_IMAGE_ID_VARIANT: '' })).toBe(DEFAULT_IMAGE_ID);
  });

  it('uses EXPECTED_IMAGE_ID_VARIANT when no --variant flag is provided', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', mappingPayload());

    expect(runScript([jsonPath], { EXPECTED_IMAGE_ID_VARIANT: 'x86_64' })).toBe(X86_IMAGE_ID);
  });

  it('fails clearly when x86_64 is requested but the mapping does not provide it', () => {
    const dir = createTempDir();
    tempDirs.push(dir);
    const jsonPath = writeJson(dir, 'mapping.json', mappingPayload('unconfirmed'));

    const result = spawnSync('node', [SCRIPT_PATH, jsonPath, '--variant', 'x86_64'], {
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Expected ImageID variant x86_64 is unconfirmed for method version 10');
  });
});

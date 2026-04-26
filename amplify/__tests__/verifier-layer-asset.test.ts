/**
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertVerifierLayerBinaryExists, resolveVerifierLayerAssetPaths } from '../lib/verifier-layer-asset';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-layer-asset-'));
  tempDirs.push(dir);
  return dir;
}

describe('resolveVerifierLayerAssetPaths', () => {
  it('resolves the generated layer asset and binary paths from the repo root', () => {
    const rootDir = '/repo-root';

    expect(resolveVerifierLayerAssetPaths(rootDir)).toEqual({
      assetPath: path.resolve(rootDir, 'verifier-service', 'lambda-layer'),
      binaryPath: path.resolve(rootDir, 'verifier-service', 'lambda-layer', 'bin', 'verifier-service'),
    });
  });
});

describe('assertVerifierLayerBinaryExists', () => {
  it('returns the resolved asset paths when the generated binary exists', () => {
    const rootDir = createTempRepoRoot();
    const assetPaths = resolveVerifierLayerAssetPaths(rootDir);

    fs.mkdirSync(path.dirname(assetPaths.binaryPath), { recursive: true });
    fs.writeFileSync(assetPaths.binaryPath, 'stub');

    expect(assertVerifierLayerBinaryExists(rootDir)).toEqual(assetPaths);
  });

  it('throws a clear error when the generated binary is missing', () => {
    const rootDir = createTempRepoRoot();
    const assetPaths = resolveVerifierLayerAssetPaths(rootDir);

    expect(() => assertVerifierLayerBinaryExists(rootDir)).toThrow(
      `Missing generated verifier layer binary at ${assetPaths.binaryPath}`,
    );
  });
});

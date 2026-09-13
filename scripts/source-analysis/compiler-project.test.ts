import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCompilerProject } from './compiler-project';

describe('compiler project ownership', () => {
  it('resolves inherited options and file membership relative to the owning project', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'compiler-project-'));
    try {
      mkdirSync(path.join(root, 'source'));
      writeFileSync(path.join(root, 'base.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
      writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ extends: './base.json', include: ['source/*.ts'], exclude: ['source/excluded.ts'] }),
      );
      writeFileSync(path.join(root, 'source/included.ts'), 'export {};');
      writeFileSync(path.join(root, 'source/excluded.ts'), 'export {};');
      const project = loadCompilerProject(path.join(root, 'tsconfig.json'));
      expect(project.options).toMatchObject({ strict: true, noEmit: true });
      expect(project.fileNames).toEqual([path.join(root, 'source/included.ts')]);
      writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({ extends: './missing.json', files: ['source/included.ts'] }),
      );
      expect(() => loadCompilerProject(path.join(root, 'tsconfig.json'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

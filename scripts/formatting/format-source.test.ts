import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSource } from './format-source';

const root = process.cwd();
const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('oxfmt/package.json')), 'bin/oxfmt');

describe('repository formatting policy', () => {
  it('uses the same JSON output for generated artifacts and the CLI', async () => {
    const filePath = path.join(root, 'generated.json');
    const source = '{"values":[1,2,3],"name":"example"}';
    const result = spawnSync(process.execPath, [cli, '--stdin-filepath', filePath], {
      cwd: root,
      input: source,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(await formatSource(filePath, source)).toBe(result.stdout);
  });
  it('sorts manifest fields and dependencies while retaining conditional export precedence', async () => {
    const source = {
      devDependencies: { z: '1', a: '2' },
      exports: { '.': { node: './node.js', browser: './browser.js', default: './default.js' } },
      version: '1.0.0',
      name: 'example',
    };
    const formatted = await formatSource('package.json', JSON.stringify(source));
    expect(JSON.parse(formatted)).toEqual(source);
    expect(formatted.indexOf('"name"')).toBeLessThan(formatted.indexOf('"devDependencies"'));
    expect(formatted.indexOf('"a"')).toBeLessThan(formatted.indexOf('"z"'));
    expect(formatted.indexOf('"node"')).toBeLessThan(formatted.indexOf('"browser"'));
    expect(await formatSource('package.json', formatted)).toBe(formatted);
  });
  it('sorts Tailwind classes using the application theme', async () => {
    const formatted = await formatSource(
      path.join(root, 'apps/web/src/example.tsx'),
      'export const View = () => <div className="text-ink-900 p-4 flex" />;',
    );
    expect(formatted).toContain('className="flex p-4 text-ink-900"');
  });
  it('preserves import evaluation order and rejects invalid source', async () => {
    const formatted = await formatSource('example.ts', 'import "./second"; import "./first"; export const value=1;');
    expect(formatted.indexOf('./second')).toBeLessThan(formatted.indexOf('./first'));
    await expect(formatSource('invalid.ts', 'const broken = {')).rejects.toThrow('Cannot format');
  });
});

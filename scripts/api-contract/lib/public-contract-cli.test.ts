import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPublicContractCliPlan,
  parsePublicContractCli,
  PUBLIC_CONTRACT_USAGE,
  renderPublicContractDriftFailure,
} from './public-contract-cli';

describe('public contract baseline CLI policy', () => {
  it('parses capture arguments and requires explicit source-ref output', () => {
    const options = parsePublicContractCli([
      'capture',
      '--',
      '--source-ref',
      'develop',
      '--out',
      '.tmp/review.json',
      '--require-clean-current',
    ]);

    expect(buildPublicContractCliPlan(options, false)).toEqual({
      command: 'capture',
      outPath: '.tmp/review.json',
      requireCleanCurrent: true,
      sourceRef: 'develop',
    });
    expect(() =>
      buildPublicContractCliPlan(parsePublicContractCli(['capture', '--source-ref', 'develop']), false),
    ).toThrow('Source-ref capture requires an explicit --out path');
  });

  it('builds compare defaults without hiding whether current evidence must be captured', () => {
    expect(buildPublicContractCliPlan(parsePublicContractCli(['compare']), false)).toEqual({
      baselinePath: 'scripts/api-contract/baselines/reviewed-public-contract.json',
      captureCurrent: true,
      command: 'compare',
      currentPath: '.tmp/api-contract/current-public-contract.json',
    });
    expect(
      buildPublicContractCliPlan(
        parsePublicContractCli([
          'compare',
          '--baseline',
          'baseline.json',
          '--current',
          'current.json',
          '--classification',
          'classification.json',
        ]),
        true,
      ),
    ).toEqual({
      baselinePath: 'baseline.json',
      captureCurrent: false,
      classificationPath: 'classification.json',
      command: 'compare',
      currentPath: 'current.json',
    });
  });

  it.each([
    [[], PUBLIC_CONTRACT_USAGE],
    [['unknown'], PUBLIC_CONTRACT_USAGE],
    [['capture', '--out'], 'Invalid argument near --out'],
    [['compare', '--unknown', 'value'], 'Unknown option: --unknown'],
  ])('rejects invalid arguments %j with stable diagnostics', (arguments_, message) => {
    expect(() => parsePublicContractCli(arguments_)).toThrow(message);
  });

  it('renders bounded drift diagnostics in deterministic order', () => {
    expect(
      renderPublicContractDriftFailure(
        Array.from({ length: 27 }, (_, index) => ({ path: `routes.${String(index)}`, before: null, after: true })),
      ),
    ).toEqual([
      'Public contract drift is not classified (27 paths):',
      ...Array.from({ length: 25 }, (_, index) => `- routes.${String(index)}`),
    ]);
  });

  it('preserves the direct no-argument entrypoint status and exact usage diagnostic', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/api-contract/public-contract-baseline.ts'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${PUBLIC_CONTRACT_USAGE}\n`);
  });
});

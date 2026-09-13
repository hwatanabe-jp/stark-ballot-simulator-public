import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCurrentBitmapGoldenVectors } from '@stark-ballot/zkvm-contract/zkvm/bitmap-golden-vectors';
import { describe, expect, it } from 'vitest';
import { buildBitmapGoldenVectors } from './bitmap-golden-vectors';

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '../../zkvm/contract-core/testdata/bitmap-ts-golden-vectors.json',
);

describe('bitmap TS-to-Rust golden vectors', () => {
  it('keeps the checked-in fixture deterministic and exactly admitted', () => {
    const fixtureValue: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const fixture = parseCurrentBitmapGoldenVectors(fixtureValue);

    expect(fixture).toEqual(buildBitmapGoldenVectors());
  });
});

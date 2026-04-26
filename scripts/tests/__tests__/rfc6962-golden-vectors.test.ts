import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRfc6962GoldenVectors, RFC6962_GOLDEN_VECTOR_SIZES } from '../rfc6962-golden-vectors';

const FIXTURE_PATH = path.resolve(__dirname, '../../../zkvm/contract-core/testdata/rfc6962-ts-golden-vectors.json');

describe('RFC6962 TS golden vectors', () => {
  it('keeps the checked-in TS-to-Rust inclusion proof fixture deterministic', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
    const generated = buildRfc6962GoldenVectors();

    expect(fixture).toEqual(generated);
  });

  it('covers every leaf for reviewer-visible odd tree sizes', () => {
    const vectors = buildRfc6962GoldenVectors();
    const coveredSizes = vectors.cases.map((entry) => entry.treeSize);

    expect(coveredSizes).toEqual([...RFC6962_GOLDEN_VECTOR_SIZES]);
    expect(coveredSizes).toEqual(expect.arrayContaining([3, 5, 7, 9]));

    for (const entry of vectors.cases) {
      expect(entry.proofs.map((proof) => proof.leafIndex)).toEqual(
        Array.from({ length: entry.treeSize }, (_, index) => index),
      );
    }
  });
});

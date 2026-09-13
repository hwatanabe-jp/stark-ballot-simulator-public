import fixtureJson from '../../../../zkvm/contract-core/testdata/bitmap-ts-golden-vectors.json';
import { describe, expect, it } from 'vitest';
import { CURRENT_BITMAP_GOLDEN_VECTOR_TYPE, parseCurrentBitmapGoldenVectors } from './bitmap-golden-vectors';

describe('current bitmap golden-vector admission', () => {
  it('admits every reviewed key, including case names and probes', () => {
    const admitted = parseCurrentBitmapGoldenVectors(fixtureJson);

    expect(admitted.envelopeType).toBe(CURRENT_BITMAP_GOLDEN_VECTOR_TYPE);
    expect(admitted.generatedBy).toBe('scripts/tests/generate-bitmap-golden-vectors.ts');
    expect(admitted.cases.map(({ name }) => name)).toHaveLength(8);
    expect(admitted.cases.every(({ probes }) => probes.length > 0)).toBe(true);
  });

  it('rejects unknown keys at every envelope level', () => {
    const firstCase = fixtureJson.cases[0];
    const firstProof = firstCase?.proofs[0];
    const caseWithAuditNode = fixtureJson.cases.find(({ proofs }) =>
      proofs.some(({ auditPath }) => auditPath.length > 0),
    );
    const proofWithAuditNode = caseWithAuditNode?.proofs.find(({ auditPath }) => auditPath.length > 0);
    const firstAuditNode = proofWithAuditNode?.auditPath[0];
    if (
      firstCase === undefined ||
      firstProof === undefined ||
      caseWithAuditNode === undefined ||
      proofWithAuditNode === undefined ||
      firstAuditNode === undefined
    ) {
      throw new Error('Bitmap golden fixture must retain a case, proof, and audit node');
    }

    expect(() => parseCurrentBitmapGoldenVectors({ ...fixtureJson, retired: true })).toThrow(/exact keys/u);
    expect(() =>
      parseCurrentBitmapGoldenVectors({
        ...fixtureJson,
        cases: [{ ...firstCase, retired: true }, ...fixtureJson.cases.slice(1)],
      }),
    ).toThrow(/exact keys/u);
    expect(() =>
      parseCurrentBitmapGoldenVectors({
        ...fixtureJson,
        cases: [
          {
            ...firstCase,
            proofs: [{ ...firstProof, retired: true }, ...firstCase.proofs.slice(1)],
          },
          ...fixtureJson.cases.slice(1),
        ],
      }),
    ).toThrow(/exact keys/u);
    expect(() =>
      parseCurrentBitmapGoldenVectors({
        ...fixtureJson,
        cases: [
          {
            ...caseWithAuditNode,
            proofs: [
              {
                ...proofWithAuditNode,
                auditPath: [{ ...firstAuditNode, retired: true }, ...proofWithAuditNode.auditPath.slice(1)],
              },
              ...caseWithAuditNode.proofs.slice(1),
            ],
          },
          ...fixtureJson.cases.filter(({ name }) => name !== caseWithAuditNode.name),
        ],
      }),
    ).toThrow(/exact keys/u);
  });

  it('rejects a case that drops the producer-owned probes', () => {
    const firstCase = fixtureJson.cases[0];
    if (firstCase === undefined) {
      throw new Error('Bitmap golden fixture must retain a case');
    }
    const withoutProbes = {
      name: firstCase.name,
      bitLength: firstCase.bitLength,
      trueIndices: firstCase.trueIndices,
      root: firstCase.root,
      proofs: firstCase.proofs,
    };

    expect(() =>
      parseCurrentBitmapGoldenVectors({
        ...fixtureJson,
        cases: [withoutProbes, ...fixtureJson.cases.slice(1)],
      }),
    ).toThrow(/exact keys/u);
  });
});

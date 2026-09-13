import {
  CURRENT_BITMAP_GOLDEN_VECTOR_GENERATOR,
  CURRENT_BITMAP_GOLDEN_VECTOR_TYPE,
  type BitmapGoldenCase,
  type CurrentBitmapGoldenVectors,
} from '@stark-ballot/zkvm-contract/zkvm/bitmap-golden-vectors';
import { computeIncludedBitmapRoot } from '@stark-ballot/zkvm-contract/zkvm/bitmap';
import { generateBitmapMerkleProof } from '@stark-ballot/verification/merkle/bitmap-merkle-tree';

interface BitmapGoldenSeed {
  readonly name: string;
  readonly bitLength: number;
  readonly trueIndices: readonly number[];
  readonly probes: readonly number[];
}

const BITMAP_GOLDEN_SEEDS: readonly BitmapGoldenSeed[] = [
  { name: 'one-bit', bitLength: 1, trueIndices: [0], probes: [0] },
  {
    name: 'two-hundred-fifty-five-bits-sparse',
    bitLength: 255,
    trueIndices: [0, 254],
    probes: [0, 254],
  },
  {
    name: 'two-hundred-fifty-six-bits-all-one-chunk',
    bitLength: 256,
    trueIndices: Array.from({ length: 256 }, (_, index) => index),
    probes: [0, 127, 255],
  },
  {
    name: 'two-hundred-fifty-seven-bits',
    bitLength: 257,
    trueIndices: [0, 255, 256],
    probes: [0, 255, 256],
  },
  {
    name: 'five-hundred-eleven-bits-two-partial-leaves',
    bitLength: 511,
    trueIndices: [0, 255, 256, 510],
    probes: [0, 255, 256, 510],
  },
  {
    name: 'five-hundred-twelve-bits-two-full-leaves',
    bitLength: 512,
    trueIndices: [255, 256, 511],
    probes: [0, 255, 256, 511],
  },
  {
    name: 'five-hundred-thirteen-bits-three-leaf-promoted',
    bitLength: 513,
    trueIndices: [0, 256, 512],
    probes: [0, 255, 256, 512],
  },
  {
    name: 'one-thousand-twenty-five-bits-five-leaf-promoted',
    bitLength: 1_025,
    trueIndices: [0, 512, 1_024],
    probes: [0, 255, 256, 512, 1_024],
  },
];

function buildCase(seed: BitmapGoldenSeed): BitmapGoldenCase {
  const trueIndices = new Set(seed.trueIndices);
  const bitmap = Array.from({ length: seed.bitLength }, (_, index) => trueIndices.has(index));
  return {
    name: seed.name,
    bitLength: seed.bitLength,
    trueIndices: [...seed.trueIndices],
    probes: [...seed.probes],
    root: computeIncludedBitmapRoot(bitmap),
    proofs: seed.probes.map((bitIndex) => generateBitmapMerkleProof(bitmap, bitIndex)),
  };
}

export function buildBitmapGoldenVectors(): CurrentBitmapGoldenVectors {
  return {
    envelopeType: CURRENT_BITMAP_GOLDEN_VECTOR_TYPE,
    generatedBy: CURRENT_BITMAP_GOLDEN_VECTOR_GENERATOR,
    cases: BITMAP_GOLDEN_SEEDS.map((seed) => buildCase(seed)),
  };
}

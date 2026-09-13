import { isRecord } from './guards';

export const CURRENT_BITMAP_GOLDEN_VECTOR_TYPE = 'stark-ballot.bitmap-proof-parity.current' as const;
export const CURRENT_BITMAP_GOLDEN_VECTOR_GENERATOR = 'scripts/tests/generate-bitmap-golden-vectors.ts' as const;

export interface BitmapGoldenAuditNode {
  readonly hash: string;
  readonly position: 'left' | 'right';
}

export interface BitmapGoldenProof {
  readonly leafChunk: string;
  readonly auditPath: readonly BitmapGoldenAuditNode[];
  readonly leafIndex: number;
  readonly bitIndex: number;
}

export interface BitmapGoldenCase {
  readonly name: string;
  readonly bitLength: number;
  readonly trueIndices: readonly number[];
  readonly probes: readonly number[];
  readonly root: string;
  readonly proofs: readonly BitmapGoldenProof[];
}

export interface CurrentBitmapGoldenVectors {
  readonly envelopeType: typeof CURRENT_BITMAP_GOLDEN_VECTOR_TYPE;
  readonly generatedBy: typeof CURRENT_BITMAP_GOLDEN_VECTOR_GENERATOR;
  readonly cases: readonly BitmapGoldenCase[];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} must contain the exact keys for the current bitmap golden-vector envelope`);
  }
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireIndexArray(value: unknown, bitLength: number, label: string): number[] {
  const indices = requireArray(value, label).map((entry, index) => requireInteger(entry, `${label}[${index}]`));
  if (indices.some((index) => index >= bitLength)) {
    throw new Error(`${label} entries must be within bitLength`);
  }
  if (new Set(indices).size !== indices.length) {
    throw new Error(`${label} entries must be unique`);
  }
  return indices;
}

function requireHex(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) {
    throw new Error(`${label} must be an exact lowercase 32-byte hex value`);
  }
  return value;
}

function parseAuditNode(value: unknown, label: string): BitmapGoldenAuditNode {
  const node = requireRecord(value, label);
  requireExactKeys(node, ['hash', 'position'], label);
  const position = node['position'];
  if (position !== 'left' && position !== 'right') {
    throw new Error(`${label}.position must be left or right`);
  }
  return {
    hash: requireHex(requireString(node, 'hash', label), /^[0-9a-f]{64}$/u, `${label}.hash`),
    position,
  };
}

function parseProof(value: unknown, bitLength: number, label: string): BitmapGoldenProof {
  const proof = requireRecord(value, label);
  requireExactKeys(proof, ['leafChunk', 'auditPath', 'leafIndex', 'bitIndex'], label);
  const leafIndex = requireInteger(proof['leafIndex'], `${label}.leafIndex`);
  const bitIndex = requireInteger(proof['bitIndex'], `${label}.bitIndex`);
  if (bitIndex >= bitLength || leafIndex !== Math.floor(bitIndex / 256)) {
    throw new Error(`${label} indices do not match the bitmap position`);
  }
  return {
    leafChunk: requireHex(requireString(proof, 'leafChunk', label), /^[0-9a-f]{64}$/u, `${label}.leafChunk`),
    auditPath: requireArray(proof['auditPath'], `${label}.auditPath`).map((entry, index) =>
      parseAuditNode(entry, `${label}.auditPath[${index}]`),
    ),
    leafIndex,
    bitIndex,
  };
}

function parseCase(value: unknown, label: string): BitmapGoldenCase {
  const testCase = requireRecord(value, label);
  requireExactKeys(testCase, ['name', 'bitLength', 'trueIndices', 'probes', 'root', 'proofs'], label);
  const bitLength = requireInteger(testCase['bitLength'], `${label}.bitLength`);
  if (bitLength === 0) {
    throw new Error(`${label}.bitLength must be positive`);
  }
  const probes = requireIndexArray(testCase['probes'], bitLength, `${label}.probes`);
  const proofs = requireArray(testCase['proofs'], `${label}.proofs`).map((entry, index) =>
    parseProof(entry, bitLength, `${label}.proofs[${index}]`),
  );
  if (proofs.length !== probes.length || proofs.some((proof, index) => proof.bitIndex !== probes[index])) {
    throw new Error(`${label}.proofs must correspond exactly to probes`);
  }
  return {
    name: requireString(testCase, 'name', label),
    bitLength,
    trueIndices: requireIndexArray(testCase['trueIndices'], bitLength, `${label}.trueIndices`),
    probes,
    root: requireHex(requireString(testCase, 'root', label), /^0x[0-9a-f]{64}$/u, `${label}.root`),
    proofs,
  };
}

export function parseCurrentBitmapGoldenVectors(value: unknown): CurrentBitmapGoldenVectors {
  const envelope = requireRecord(value, 'bitmap golden-vector envelope');
  requireExactKeys(envelope, ['envelopeType', 'generatedBy', 'cases'], 'bitmap golden-vector envelope');
  if (envelope['envelopeType'] !== CURRENT_BITMAP_GOLDEN_VECTOR_TYPE) {
    throw new Error('bitmap golden-vector envelope has an unsupported envelopeType');
  }
  if (envelope['generatedBy'] !== CURRENT_BITMAP_GOLDEN_VECTOR_GENERATOR) {
    throw new Error('bitmap golden-vector envelope has an unsupported generatedBy owner');
  }
  const cases = requireArray(envelope['cases'], 'bitmap golden-vector envelope.cases').map((entry, index) =>
    parseCase(entry, `bitmap golden-vector envelope.cases[${index}]`),
  );
  if (cases.length === 0 || new Set(cases.map(({ name }) => name)).size !== cases.length) {
    throw new Error('bitmap golden-vector envelope must contain uniquely named cases');
  }
  return {
    envelopeType: envelope['envelopeType'],
    generatedBy: envelope['generatedBy'],
    cases,
  };
}

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import checkedDescriptorJson from '../../../../zkvm/contract-core/src/current-zkvm-semantic-contract.json';
import { CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS } from './semantic-contract.generated';

export { CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS } from './semantic-contract.generated';

const SEMANTIC_FIELD_TYPES = new Set([
  'boolean[]',
  'bytes[16]',
  'bytes[32]',
  'bytes[32][]',
  'electionConfig?',
  'hex[32]',
  'hex[32][]',
  'literal',
  'opaque-risc0-serde',
  'publicInputVote[]',
  'string',
  'string[]',
  'u8',
  'u32',
  'u32[tallyWidth]',
  'u64',
  'uuid',
  'vote[]',
]);

export interface ZkvmSemanticField {
  readonly name: string;
  readonly type: string;
}

interface ParsedZkvmSemanticContract {
  readonly descriptorType: string;
  readonly method: {
    readonly methodVersion: number;
    readonly inputCommitmentFormatVersion: number;
  };
  readonly domainTags: {
    readonly voteCommitment: string;
    readonly inputCommitment: string;
  };
  readonly workBounds: {
    readonly treeSizeMin: number;
    readonly treeSizeMax: number;
    readonly totalExpectedMax: number;
    readonly voteCountMax: number;
    readonly merklePathNodesPerRecordMax: number;
    readonly totalMerklePathNodesMax: number;
    readonly serializedInputBytesMax: number;
  };
  readonly hostInputJson: {
    readonly fields: readonly ZkvmSemanticField[];
    readonly voteFields: readonly ZkvmSemanticField[];
    readonly electionConfigFields: readonly ZkvmSemanticField[];
  };
  readonly logicalJournal: {
    readonly fields: readonly ZkvmSemanticField[];
    readonly tallyWidth: number;
  };
  readonly hostJsonProjection: {
    readonly fields: readonly ZkvmSemanticField[];
    readonly outputFileSuffix: string;
  };
  readonly artifacts: {
    readonly receipt: {
      readonly hostFileSuffix: string;
      readonly canonicalFileName: string;
      readonly fields: readonly ZkvmSemanticField[];
      readonly receiptPayload: string;
    };
    readonly publicInput: {
      readonly canonicalFileName: string;
      readonly schema: string;
      readonly version: string;
      readonly fields: readonly ZkvmSemanticField[];
      readonly voteFields: readonly ZkvmSemanticField[];
    };
    readonly includedBitmap: {
      readonly hostFileSuffix: string;
      readonly canonicalFileName: string;
      readonly schema: string;
      readonly version: string;
      readonly fields: readonly ZkvmSemanticField[];
    };
    readonly seenBitmap: {
      readonly hostFileSuffix: string;
      readonly canonicalFileName: string;
      readonly schema: string;
      readonly version: string;
      readonly fields: readonly ZkvmSemanticField[];
    };
  };
  readonly semanticSha256: string;
}

type LiteralBindings = typeof CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS;

export type CurrentZkvmSemanticContract = ParsedZkvmSemanticContract & {
  readonly descriptorType: LiteralBindings['descriptorType'];
  readonly method: {
    readonly methodVersion: LiteralBindings['methodVersion'];
    readonly inputCommitmentFormatVersion: LiteralBindings['inputCommitmentFormatVersion'];
  };
  readonly domainTags: LiteralBindings['domainTags'];
  readonly workBounds: LiteralBindings['workBounds'];
  readonly logicalJournal: ParsedZkvmSemanticContract['logicalJournal'] & {
    readonly tallyWidth: LiteralBindings['tallyWidth'];
  };
  readonly hostJsonProjection: ParsedZkvmSemanticContract['hostJsonProjection'] & {
    readonly outputFileSuffix: '-output.json';
  };
  readonly artifacts: ParsedZkvmSemanticContract['artifacts'] & {
    readonly receipt: ParsedZkvmSemanticContract['artifacts']['receipt'] & LiteralBindings['artifacts']['receipt'];
    readonly publicInput: ParsedZkvmSemanticContract['artifacts']['publicInput'] &
      LiteralBindings['artifacts']['publicInput'];
    readonly includedBitmap: ParsedZkvmSemanticContract['artifacts']['includedBitmap'] &
      LiteralBindings['artifacts']['includedBitmap'];
    readonly seenBitmap: ParsedZkvmSemanticContract['artifacts']['seenBitmap'] &
      LiteralBindings['artifacts']['seenBitmap'];
  };
  readonly semanticSha256: LiteralBindings['semanticSha256'];
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain the exact keys for the current semantic contract`);
  }
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requireSafeInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}.${key} must be a non-negative safe integer`);
  }
  return value;
}

function parseFields(value: unknown, label: string): readonly ZkvmSemanticField[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty field array`);
  }
  const names = new Set<string>();
  return value.map((entry, index) => {
    const field = requireRecord(entry, `${label}[${index}]`);
    requireExactKeys(field, ['name', 'type'], `${label}[${index}]`);
    const name = requireString(field, 'name', `${label}[${index}]`);
    const type = requireString(field, 'type', `${label}[${index}]`);
    if (!SEMANTIC_FIELD_TYPES.has(type)) {
      throw new Error(`${label}[${index}].type is unsupported`);
    }
    if (names.has(name)) {
      throw new Error(`${label} contains duplicate field ${name}`);
    }
    names.add(name);
    return { name, type };
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('zkVM semantic contract canonical JSON admits only safe integers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = requireRecord(value, 'zkVM semantic contract canonical value');
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function semanticSha256(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
}

function parseBitmapArtifact(value: unknown, label: string): ParsedZkvmSemanticContract['artifacts']['includedBitmap'] {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['hostFileSuffix', 'canonicalFileName', 'schema', 'version', 'fields'], label);
  return {
    hostFileSuffix: requireString(record, 'hostFileSuffix', label),
    canonicalFileName: requireString(record, 'canonicalFileName', label),
    schema: requireString(record, 'schema', label),
    version: requireString(record, 'version', label),
    fields: parseFields(record['fields'], `${label}.fields`),
  };
}

function parsePublicInputArtifact(
  value: unknown,
  label: string,
): ParsedZkvmSemanticContract['artifacts']['publicInput'] {
  const record = requireRecord(value, label);
  requireExactKeys(record, ['canonicalFileName', 'schema', 'version', 'fields', 'voteFields'], label);
  return {
    canonicalFileName: requireString(record, 'canonicalFileName', label),
    schema: requireString(record, 'schema', label),
    version: requireString(record, 'version', label),
    fields: parseFields(record['fields'], `${label}.fields`),
    voteFields: parseFields(record['voteFields'], `${label}.voteFields`),
  };
}

function parseSemanticContract(value: unknown): ParsedZkvmSemanticContract {
  const record = requireRecord(value, 'zkVM semantic contract');
  requireExactKeys(
    record,
    [
      'descriptorType',
      'method',
      'domainTags',
      'workBounds',
      'hostInputJson',
      'logicalJournal',
      'hostJsonProjection',
      'artifacts',
      'semanticSha256',
    ],
    'zkVM semantic contract',
  );

  const method = requireRecord(record['method'], 'zkVM semantic contract.method');
  requireExactKeys(method, ['methodVersion', 'inputCommitmentFormatVersion'], 'zkVM semantic contract.method');
  const domainTags = requireRecord(record['domainTags'], 'zkVM semantic contract.domainTags');
  requireExactKeys(domainTags, ['voteCommitment', 'inputCommitment'], 'zkVM semantic contract.domainTags');
  const workBounds = requireRecord(record['workBounds'], 'zkVM semantic contract.workBounds');
  requireExactKeys(
    workBounds,
    [
      'treeSizeMin',
      'treeSizeMax',
      'totalExpectedMax',
      'voteCountMax',
      'merklePathNodesPerRecordMax',
      'totalMerklePathNodesMax',
      'serializedInputBytesMax',
    ],
    'zkVM semantic contract.workBounds',
  );
  const hostInputJson = requireRecord(record['hostInputJson'], 'zkVM semantic contract.hostInputJson');
  requireExactKeys(
    hostInputJson,
    ['fields', 'voteFields', 'electionConfigFields'],
    'zkVM semantic contract.hostInputJson',
  );
  const logicalJournal = requireRecord(record['logicalJournal'], 'zkVM semantic contract.logicalJournal');
  requireExactKeys(logicalJournal, ['fields', 'tallyWidth'], 'zkVM semantic contract.logicalJournal');
  const hostJsonProjection = requireRecord(record['hostJsonProjection'], 'zkVM semantic contract.hostJsonProjection');
  requireExactKeys(hostJsonProjection, ['fields', 'outputFileSuffix'], 'zkVM semantic contract.hostJsonProjection');
  const artifacts = requireRecord(record['artifacts'], 'zkVM semantic contract.artifacts');
  requireExactKeys(
    artifacts,
    ['receipt', 'publicInput', 'includedBitmap', 'seenBitmap'],
    'zkVM semantic contract.artifacts',
  );
  const receipt = requireRecord(artifacts['receipt'], 'zkVM semantic contract.artifacts.receipt');
  requireExactKeys(
    receipt,
    ['hostFileSuffix', 'canonicalFileName', 'fields', 'receiptPayload'],
    'zkVM semantic contract.artifacts.receipt',
  );

  return {
    descriptorType: requireString(record, 'descriptorType', 'zkVM semantic contract'),
    method: {
      methodVersion: requireSafeInteger(method, 'methodVersion', 'zkVM semantic contract.method'),
      inputCommitmentFormatVersion: requireSafeInteger(
        method,
        'inputCommitmentFormatVersion',
        'zkVM semantic contract.method',
      ),
    },
    domainTags: {
      voteCommitment: requireString(domainTags, 'voteCommitment', 'zkVM semantic contract.domainTags'),
      inputCommitment: requireString(domainTags, 'inputCommitment', 'zkVM semantic contract.domainTags'),
    },
    workBounds: {
      treeSizeMin: requireSafeInteger(workBounds, 'treeSizeMin', 'zkVM semantic contract.workBounds'),
      treeSizeMax: requireSafeInteger(workBounds, 'treeSizeMax', 'zkVM semantic contract.workBounds'),
      totalExpectedMax: requireSafeInteger(workBounds, 'totalExpectedMax', 'zkVM semantic contract.workBounds'),
      voteCountMax: requireSafeInteger(workBounds, 'voteCountMax', 'zkVM semantic contract.workBounds'),
      merklePathNodesPerRecordMax: requireSafeInteger(
        workBounds,
        'merklePathNodesPerRecordMax',
        'zkVM semantic contract.workBounds',
      ),
      totalMerklePathNodesMax: requireSafeInteger(
        workBounds,
        'totalMerklePathNodesMax',
        'zkVM semantic contract.workBounds',
      ),
      serializedInputBytesMax: requireSafeInteger(
        workBounds,
        'serializedInputBytesMax',
        'zkVM semantic contract.workBounds',
      ),
    },
    hostInputJson: {
      fields: parseFields(hostInputJson['fields'], 'zkVM semantic contract.hostInputJson.fields'),
      voteFields: parseFields(hostInputJson['voteFields'], 'zkVM semantic contract.hostInputJson.voteFields'),
      electionConfigFields: parseFields(
        hostInputJson['electionConfigFields'],
        'zkVM semantic contract.hostInputJson.electionConfigFields',
      ),
    },
    logicalJournal: {
      fields: parseFields(logicalJournal['fields'], 'zkVM semantic contract.logicalJournal.fields'),
      tallyWidth: requireSafeInteger(logicalJournal, 'tallyWidth', 'zkVM semantic contract.logicalJournal'),
    },
    hostJsonProjection: {
      fields: parseFields(hostJsonProjection['fields'], 'zkVM semantic contract.hostJsonProjection.fields'),
      outputFileSuffix: requireString(
        hostJsonProjection,
        'outputFileSuffix',
        'zkVM semantic contract.hostJsonProjection',
      ),
    },
    artifacts: {
      receipt: {
        hostFileSuffix: requireString(receipt, 'hostFileSuffix', 'zkVM semantic contract.artifacts.receipt'),
        canonicalFileName: requireString(receipt, 'canonicalFileName', 'zkVM semantic contract.artifacts.receipt'),
        fields: parseFields(receipt['fields'], 'zkVM semantic contract.artifacts.receipt.fields'),
        receiptPayload: requireString(receipt, 'receiptPayload', 'zkVM semantic contract.artifacts.receipt'),
      },
      publicInput: parsePublicInputArtifact(artifacts['publicInput'], 'zkVM semantic contract.artifacts.publicInput'),
      includedBitmap: parseBitmapArtifact(
        artifacts['includedBitmap'],
        'zkVM semantic contract.artifacts.includedBitmap',
      ),
      seenBitmap: parseBitmapArtifact(artifacts['seenBitmap'], 'zkVM semantic contract.artifacts.seenBitmap'),
    },
    semanticSha256: requireString(record, 'semanticSha256', 'zkVM semantic contract'),
  };
}

function semanticPayload(contract: ParsedZkvmSemanticContract): Omit<ParsedZkvmSemanticContract, 'semanticSha256'> {
  return {
    descriptorType: contract.descriptorType,
    method: contract.method,
    domainTags: contract.domainTags,
    workBounds: contract.workBounds,
    hostInputJson: contract.hostInputJson,
    logicalJournal: contract.logicalJournal,
    hostJsonProjection: contract.hostJsonProjection,
    artifacts: contract.artifacts,
  };
}

function hasCurrentLiteralBindings(contract: ParsedZkvmSemanticContract): contract is CurrentZkvmSemanticContract {
  const bindings = CURRENT_ZKVM_SEMANTIC_LITERAL_BINDINGS;
  return (
    contract.descriptorType === bindings.descriptorType &&
    contract.method.methodVersion === bindings.methodVersion &&
    contract.method.inputCommitmentFormatVersion === bindings.inputCommitmentFormatVersion &&
    contract.logicalJournal.tallyWidth === bindings.tallyWidth &&
    contract.hostJsonProjection.fields.length === bindings.hostJsonProjectionFieldNames.length &&
    contract.hostJsonProjection.fields.every(
      (field, index) => field.name === bindings.hostJsonProjectionFieldNames[index],
    ) &&
    contract.semanticSha256 === bindings.semanticSha256 &&
    contract.domainTags.voteCommitment === bindings.domainTags.voteCommitment &&
    contract.domainTags.inputCommitment === bindings.domainTags.inputCommitment &&
    Object.entries(bindings.workBounds).every(
      ([key, value]) => contract.workBounds[key as keyof typeof bindings.workBounds] === value,
    ) &&
    contract.hostJsonProjection.outputFileSuffix === '-output.json' &&
    contract.artifacts.receipt.hostFileSuffix === bindings.artifacts.receipt.hostFileSuffix &&
    contract.artifacts.receipt.canonicalFileName === bindings.artifacts.receipt.canonicalFileName &&
    contract.artifacts.receipt.receiptPayload === bindings.artifacts.receipt.receiptPayload &&
    contract.artifacts.publicInput.canonicalFileName === bindings.artifacts.publicInput.canonicalFileName &&
    contract.artifacts.publicInput.schema === bindings.artifacts.publicInput.schema &&
    contract.artifacts.publicInput.version === bindings.artifacts.publicInput.version &&
    contract.artifacts.includedBitmap.hostFileSuffix === bindings.artifacts.includedBitmap.hostFileSuffix &&
    contract.artifacts.includedBitmap.canonicalFileName === bindings.artifacts.includedBitmap.canonicalFileName &&
    contract.artifacts.includedBitmap.schema === bindings.artifacts.includedBitmap.schema &&
    contract.artifacts.includedBitmap.version === bindings.artifacts.includedBitmap.version &&
    contract.artifacts.seenBitmap.hostFileSuffix === bindings.artifacts.seenBitmap.hostFileSuffix &&
    contract.artifacts.seenBitmap.canonicalFileName === bindings.artifacts.seenBitmap.canonicalFileName &&
    contract.artifacts.seenBitmap.schema === bindings.artifacts.seenBitmap.schema &&
    contract.artifacts.seenBitmap.version === bindings.artifacts.seenBitmap.version
  );
}

export function parseCurrentZkvmSemanticContract(value: unknown): CurrentZkvmSemanticContract {
  const contract = parseSemanticContract(value);
  if (!/^[0-9a-f]{64}$/u.test(contract.semanticSha256)) {
    throw new Error('zkVM semantic contract semanticSha256 must be lowercase SHA-256');
  }
  if (semanticSha256(semanticPayload(contract)) !== contract.semanticSha256) {
    throw new Error('zkVM semantic contract semanticSha256 does not match canonical content');
  }
  if (!hasCurrentLiteralBindings(contract)) {
    throw new Error('zkVM semantic contract does not match the reviewed current literal bindings');
  }
  return contract;
}

export const CURRENT_ZKVM_SEMANTIC_CONTRACT = parseCurrentZkvmSemanticContract(checkedDescriptorJson);
export const CURRENT_ZKVM_SEMANTIC_INTERFACE_SHA256 = CURRENT_ZKVM_SEMANTIC_CONTRACT.semanticSha256;
export const PUBLIC_INPUT_CANONICAL_FILE_NAME = CURRENT_ZKVM_SEMANTIC_CONTRACT.artifacts.publicInput.canonicalFileName;
export const PUBLIC_INPUT_ARTIFACT_SCHEMA = CURRENT_ZKVM_SEMANTIC_CONTRACT.artifacts.publicInput.schema;
export const PUBLIC_INPUT_ARTIFACT_VERSION = CURRENT_ZKVM_SEMANTIC_CONTRACT.artifacts.publicInput.version;

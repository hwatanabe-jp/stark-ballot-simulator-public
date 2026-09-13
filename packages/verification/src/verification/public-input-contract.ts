import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { computeInputCommitmentFromPublicInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  PUBLIC_INPUT_ARTIFACT_SCHEMA,
  PUBLIC_INPUT_ARTIFACT_VERSION,
} from '@stark-ballot/zkvm-contract/zkvm/semantic-contract';
import {
  getArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
  isRecord,
} from '@stark-ballot/validation/unknown-value-guards';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@stark-ballot/crypto-primitives';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';

export const PUBLIC_INPUT_SCHEMA = PUBLIC_INPUT_ARTIFACT_SCHEMA;
export const PUBLIC_INPUT_VERSION = PUBLIC_INPUT_ARTIFACT_VERSION;

export type PublicInputArtifactSource = 'bundle' | 'generated';

export interface PublicInputArtifactProvenance {
  source: PublicInputArtifactSource;
  finalizationId?: string;
  bundleKey?: string;
}

export interface PublicInputArtifactVote {
  index: number;
  commitment: string;
  merklePath: string[];
}

export interface PublicInputArtifactRecord {
  schema: typeof PUBLIC_INPUT_SCHEMA;
  version: typeof PUBLIC_INPUT_VERSION;
  electionId: string;
  electionConfigHash: string;
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;
  logId: string;
  timestamp: number;
  methodVersion: number;
  votes: PublicInputArtifactVote[];
}

export interface PublicInputArtifactFormat {
  schema?: string;
  version?: string;
}

export interface PublicInputObservedFields {
  electionId?: string;
  electionConfigHash?: string;
  votesCount: number;
  treeSize: number;
  totalExpected?: number;
  bulletinRoot: string;
  logId?: string;
  timestamp?: number;
  methodVersion?: number;
  uniqueIndices: boolean;
  uniqueCommitments: boolean;
  recomputedInputCommitment?: string;
}

export interface PublicInputAuthority {
  electionId: string;
  electionConfigHash: string;
  methodVersion: number;
  bulletinRoot: string;
  treeSize: number;
  totalExpected: number;
  votesCount: number;
  uniqueIndices: boolean;
  uniqueCommitments: boolean;
  logId: string;
  timestamp: number;
  recomputedInputCommitment: string;
}

export interface SupportedPublicInputArtifact {
  format: {
    schema: typeof PUBLIC_INPUT_SCHEMA;
    version: typeof PUBLIC_INPUT_VERSION;
  };
  provenance: PublicInputArtifactProvenance;
  typedAuthority: PublicInputAuthority;
}

export interface ParsedPublicInputArtifact {
  format: PublicInputArtifactFormat;
  provenance: Partial<PublicInputArtifactProvenance>;
  observed: PublicInputObservedFields;
  typedAuthority?: PublicInputAuthority;
  valid: boolean;
  errors: string[];
}

const EMPTY_HEX_32 = `0x${'0'.repeat(64)}`;
const PUBLIC_INPUT_KEYS = new Set([
  'schema',
  'version',
  'electionId',
  'electionConfigHash',
  'bulletinRoot',
  'treeSize',
  'totalExpected',
  'logId',
  'timestamp',
  'methodVersion',
  'votes',
]);
const PUBLIC_INPUT_VOTE_KEYS = new Set(['index', 'commitment', 'merklePath']);
const STORED_PUBLIC_INPUT_KEYS = new Set(['format', 'provenance', 'typedAuthority']);
const PUBLIC_INPUT_FORMAT_KEYS = new Set(['schema', 'version']);
const PUBLIC_INPUT_PROVENANCE_KEYS = new Set(['source', 'finalizationId', 'bundleKey']);
const PUBLIC_INPUT_AUTHORITY_KEYS = new Set([
  'electionId',
  'electionConfigHash',
  'methodVersion',
  'bulletinRoot',
  'treeSize',
  'totalExpected',
  'votesCount',
  'uniqueIndices',
  'uniqueCommitments',
  'logId',
  'timestamp',
  'recomputedInputCommitment',
]);

function unexpectedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `unexpected_key:${key}`);
}

export function buildPublicInputArtifactFromZkvmInput(
  input: ZkVMInput,
  methodVersion: number,
): PublicInputArtifactRecord {
  return {
    schema: PUBLIC_INPUT_SCHEMA,
    version: PUBLIC_INPUT_VERSION,
    electionId: input.electionId,
    electionConfigHash: input.electionConfigHash,
    bulletinRoot: input.bulletinRoot,
    treeSize: input.treeSize,
    totalExpected: input.totalExpected,
    logId: input.logId,
    timestamp: input.timestamp,
    methodVersion,
    votes: input.votes.map((vote) => ({
      index: vote.index,
      commitment: vote.commitment,
      merklePath: [...vote.merklePath],
    })),
  };
}

export function parsePublicInputArtifact(
  raw: unknown,
  options: Partial<PublicInputArtifactProvenance> = {},
): ParsedPublicInputArtifact {
  const errors: string[] = [];
  const format: PublicInputArtifactFormat = {};
  const observed: PublicInputObservedFields = {
    votesCount: 0,
    treeSize: 0,
    bulletinRoot: EMPTY_HEX_32,
    uniqueIndices: true,
    uniqueCommitments: true,
  };

  if (!isRecord(raw)) {
    return finalizeParsedPublicInput({
      format,
      provenance: options,
      observed,
      errors: ['public_input_not_record'],
    });
  }
  errors.push(...unexpectedKeys(raw, PUBLIC_INPUT_KEYS));

  const schema = getStringProperty(raw, 'schema');
  if (schema) {
    format.schema = schema;
  }
  if (schema !== PUBLIC_INPUT_SCHEMA) {
    errors.push('schema');
  }

  const version = getStringProperty(raw, 'version');
  if (version) {
    format.version = version;
  }
  if (version !== PUBLIC_INPUT_VERSION) {
    errors.push('version');
  }

  const electionId = getStringProperty(raw, 'electionId');
  if (!electionId) {
    errors.push('electionId');
  } else {
    observed.electionId = electionId;
  }

  const electionConfigHash = getStringProperty(raw, 'electionConfigHash');
  if (!electionConfigHash || !isValidHexString(electionConfigHash, 32)) {
    errors.push('electionConfigHash');
  } else {
    observed.electionConfigHash = addHexPrefix(normalizeHexString(electionConfigHash));
  }

  const bulletinRoot = getStringProperty(raw, 'bulletinRoot');
  if (!bulletinRoot || !isValidHexString(bulletinRoot, 32)) {
    errors.push('bulletinRoot');
  } else {
    observed.bulletinRoot = addHexPrefix(normalizeHexString(bulletinRoot));
  }

  const treeSize = getNumberProperty(raw, 'treeSize');
  if (typeof treeSize !== 'number' || !Number.isInteger(treeSize)) {
    errors.push('treeSize');
  } else {
    observed.treeSize = treeSize;
  }

  const totalExpected = getNumberProperty(raw, 'totalExpected');
  if (typeof totalExpected !== 'number' || !Number.isInteger(totalExpected)) {
    errors.push('totalExpected');
  } else {
    observed.totalExpected = totalExpected;
  }

  const logId = getStringProperty(raw, 'logId');
  if (!logId || !isValidHexString(logId, 32)) {
    errors.push('logId');
  } else {
    observed.logId = addHexPrefix(normalizeHexString(logId));
  }

  const timestamp = getNumberProperty(raw, 'timestamp');
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) {
    errors.push('timestamp');
  } else {
    observed.timestamp = timestamp;
  }

  const methodVersion = getNumberProperty(raw, 'methodVersion');
  if (typeof methodVersion !== 'number' || !Number.isInteger(methodVersion)) {
    errors.push('methodVersion');
  } else {
    observed.methodVersion = methodVersion;
  }

  const votes = getArrayProperty(raw, 'votes');
  if (!votes) {
    return finalizeParsedPublicInput({
      format,
      provenance: options,
      observed,
      errors: [...errors, 'votes'],
    });
  }

  observed.votesCount = votes.length;

  const parsedVotes: PublicInputArtifactVote[] = [];
  const seenIndices = new Set<number>();
  const seenCommitments = new Set<string>();

  for (const voteEntry of votes) {
    if (!isRecord(voteEntry)) {
      errors.push('vote_record');
      continue;
    }
    errors.push(...unexpectedKeys(voteEntry, PUBLIC_INPUT_VOTE_KEYS));

    const index = getNumberProperty(voteEntry, 'index');
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      errors.push('vote_index');
      continue;
    }

    const commitment = getStringProperty(voteEntry, 'commitment');
    if (!commitment || !isValidHexString(commitment, 32)) {
      errors.push('vote_commitment');
      continue;
    }

    const merklePath = getArrayProperty(voteEntry, 'merklePath');
    if (!Array.isArray(merklePath) || !merklePath.every((node) => typeof node === 'string')) {
      errors.push('vote_merkle_path');
      continue;
    }

    if (!merklePath.every((node) => isValidHexString(node, 32))) {
      errors.push('vote_merkle_path_hex');
      continue;
    }

    parsedVotes.push({
      index,
      commitment,
      merklePath,
    });

    if (seenIndices.has(index)) {
      observed.uniqueIndices = false;
    } else {
      seenIndices.add(index);
    }

    const normalizedCommitment = normalizeHexString(commitment);
    if (seenCommitments.has(normalizedCommitment)) {
      observed.uniqueCommitments = false;
    } else {
      seenCommitments.add(normalizedCommitment);
    }
  }

  if (
    errors.length === 0 &&
    parsedVotes.length === votes.length &&
    electionId &&
    observed.totalExpected !== undefined
  ) {
    try {
      observed.recomputedInputCommitment = computeInputCommitmentFromPublicInput({
        electionId,
        bulletinRoot: observed.bulletinRoot,
        treeSize: observed.treeSize,
        totalExpected: observed.totalExpected,
        votes: parsedVotes,
      });
    } catch {
      errors.push('input_commitment');
    }
  }

  const typedAuthority =
    errors.length === 0 &&
    observed.electionId &&
    observed.electionConfigHash &&
    observed.totalExpected !== undefined &&
    observed.logId &&
    observed.timestamp !== undefined &&
    observed.methodVersion !== undefined &&
    observed.recomputedInputCommitment
      ? {
          electionId: observed.electionId,
          electionConfigHash: observed.electionConfigHash,
          methodVersion: observed.methodVersion,
          bulletinRoot: observed.bulletinRoot,
          treeSize: observed.treeSize,
          totalExpected: observed.totalExpected,
          votesCount: observed.votesCount,
          uniqueIndices: observed.uniqueIndices,
          uniqueCommitments: observed.uniqueCommitments,
          logId: observed.logId,
          timestamp: observed.timestamp,
          recomputedInputCommitment: observed.recomputedInputCommitment,
        }
      : undefined;

  return finalizeParsedPublicInput({
    format,
    provenance: options,
    observed,
    ...omitUndefinedProperties({ typedAuthority: typedAuthority }),
    errors,
  });
}

function finalizeParsedPublicInput(input: Omit<ParsedPublicInputArtifact, 'valid'>): ParsedPublicInputArtifact {
  return {
    ...input,
    valid: input.errors.length === 0,
  };
}

export function toSupportedPublicInputArtifact(
  parsed: ParsedPublicInputArtifact,
): SupportedPublicInputArtifact | undefined {
  const source = parsed.provenance.source;
  if (
    !parsed.valid ||
    !parsed.typedAuthority ||
    parsed.format.schema !== PUBLIC_INPUT_SCHEMA ||
    parsed.format.version !== PUBLIC_INPUT_VERSION ||
    (source !== 'bundle' && source !== 'generated')
  ) {
    return undefined;
  }

  return {
    format: {
      schema: PUBLIC_INPUT_SCHEMA,
      version: PUBLIC_INPUT_VERSION,
    },
    provenance: { ...parsed.provenance, source },
    typedAuthority: { ...parsed.typedAuthority },
  };
}

export function buildSupportedPublicInputArtifactFromZkvmInput(
  input: ZkVMInput,
  methodVersion: number,
  options: Omit<PublicInputArtifactProvenance, 'source'> = {},
): SupportedPublicInputArtifact {
  const parsed = parsePublicInputArtifact(buildPublicInputArtifactFromZkvmInput(input, methodVersion), {
    ...options,
    source: 'generated',
  });
  const supported = toSupportedPublicInputArtifact(parsed);

  if (!supported) {
    throw new Error(`Generated public-input contract was invalid: ${parsed.errors.join(', ') || 'unknown error'}`);
  }

  return supported;
}

export function parseSupportedPublicInputArtifact(
  raw: unknown,
  options: PublicInputArtifactProvenance,
): SupportedPublicInputArtifact | undefined {
  return toSupportedPublicInputArtifact(parsePublicInputArtifact(raw, options));
}

export function parseStoredPublicInputArtifact(value: unknown): SupportedPublicInputArtifact | undefined {
  if (!isRecord(value) || Array.isArray(value) || unexpectedKeys(value, STORED_PUBLIC_INPUT_KEYS).length > 0) {
    return undefined;
  }

  const format = getRecordProperty(value, 'format');
  const provenance = getRecordProperty(value, 'provenance');
  const typedAuthority = getRecordProperty(value, 'typedAuthority');
  if (
    !format ||
    Array.isArray(format) ||
    unexpectedKeys(format, PUBLIC_INPUT_FORMAT_KEYS).length > 0 ||
    !provenance ||
    Array.isArray(provenance) ||
    unexpectedKeys(provenance, PUBLIC_INPUT_PROVENANCE_KEYS).length > 0 ||
    !typedAuthority ||
    Array.isArray(typedAuthority) ||
    unexpectedKeys(typedAuthority, PUBLIC_INPUT_AUTHORITY_KEYS).length > 0
  ) {
    return undefined;
  }

  const schema = getStringProperty(format, 'schema');
  const version = getStringProperty(format, 'version');
  if (schema !== PUBLIC_INPUT_SCHEMA || version !== PUBLIC_INPUT_VERSION) {
    return undefined;
  }

  const source = getStringProperty(provenance, 'source');
  if (source !== 'bundle' && source !== 'generated') {
    return undefined;
  }

  const electionId = getStringProperty(typedAuthority, 'electionId');
  const electionConfigHash = getStringProperty(typedAuthority, 'electionConfigHash');
  const methodVersion = getNumberProperty(typedAuthority, 'methodVersion');
  const bulletinRoot = getStringProperty(typedAuthority, 'bulletinRoot');
  const treeSize = getNumberProperty(typedAuthority, 'treeSize');
  const totalExpected = getNumberProperty(typedAuthority, 'totalExpected');
  const votesCount = getNumberProperty(typedAuthority, 'votesCount');
  const logId = getStringProperty(typedAuthority, 'logId');
  const timestamp = getNumberProperty(typedAuthority, 'timestamp');
  const recomputedInputCommitment = getStringProperty(typedAuthority, 'recomputedInputCommitment');

  if (
    !electionId ||
    !electionConfigHash ||
    !isValidHexString(electionConfigHash, 32) ||
    typeof methodVersion !== 'number' ||
    !Number.isInteger(methodVersion) ||
    !bulletinRoot ||
    !isValidHexString(bulletinRoot, 32) ||
    typeof treeSize !== 'number' ||
    !Number.isInteger(treeSize) ||
    typeof totalExpected !== 'number' ||
    !Number.isInteger(totalExpected) ||
    typeof votesCount !== 'number' ||
    !Number.isInteger(votesCount) ||
    typeof typedAuthority['uniqueIndices'] !== 'boolean' ||
    typeof typedAuthority['uniqueCommitments'] !== 'boolean' ||
    !logId ||
    !isValidHexString(logId, 32) ||
    typeof timestamp !== 'number' ||
    !Number.isInteger(timestamp) ||
    !recomputedInputCommitment ||
    !isValidHexString(recomputedInputCommitment, 32)
  ) {
    return undefined;
  }

  const finalizationId = getStringProperty(provenance, 'finalizationId');
  const bundleKey = getStringProperty(provenance, 'bundleKey');

  return {
    format: {
      schema: PUBLIC_INPUT_SCHEMA,
      version: PUBLIC_INPUT_VERSION,
    },
    provenance: {
      source,
      ...(finalizationId ? { finalizationId } : {}),
      ...(bundleKey ? { bundleKey } : {}),
    },
    typedAuthority: {
      electionId,
      electionConfigHash: addHexPrefix(normalizeHexString(electionConfigHash)),
      methodVersion,
      bulletinRoot: addHexPrefix(normalizeHexString(bulletinRoot)),
      treeSize,
      totalExpected,
      votesCount,
      uniqueIndices: typedAuthority['uniqueIndices'],
      uniqueCommitments: typedAuthority['uniqueCommitments'],
      logId: addHexPrefix(normalizeHexString(logId)),
      timestamp,
      recomputedInputCommitment: addHexPrefix(normalizeHexString(recomputedInputCommitment)),
    },
  };
}

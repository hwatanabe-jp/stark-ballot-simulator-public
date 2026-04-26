import type { ZkVMInput } from '@/lib/zkvm/types';
import { computeInputCommitmentFromPublicInput } from '@/lib/zkvm/types';
import {
  getArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringProperty,
  isRecord,
} from '@/lib/utils/guards';
import { addHexPrefix, isValidHexString, normalizeHexString } from '@/lib/utils/hex';

export const PUBLIC_INPUT_SCHEMA = 'stark-ballot.public_input';
export const PUBLIC_INPUT_VERSION = '1.1';

export type PublicInputArtifactSource = 'bundle' | 'generated';

export interface PublicInputArtifactProvenance {
  source?: PublicInputArtifactSource;
  executionId?: string;
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
  contractGeneration: string;
}

export interface PublicInputCompatibilityMarker {
  schema?: string;
  version?: string;
  contractGeneration?: string;
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

export interface PublicInputTypedAuthority {
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
  compatibilityMarker: {
    schema: typeof PUBLIC_INPUT_SCHEMA;
    version: typeof PUBLIC_INPUT_VERSION;
    contractGeneration: string;
  };
  provenance: PublicInputArtifactProvenance;
  typedAuthority: PublicInputTypedAuthority;
}

export interface ParsedPublicInputArtifact {
  compatibilityMarker: PublicInputCompatibilityMarker;
  provenance: PublicInputArtifactProvenance;
  observed: PublicInputObservedFields;
  typedAuthority?: PublicInputTypedAuthority;
  valid: boolean;
  errors: string[];
}

const EMPTY_HEX_32 = `0x${'0'.repeat(64)}`;

export function buildPublicInputArtifactFromZkvmInput(
  input: ZkVMInput,
  methodVersion: number,
  contractGeneration: string,
): PublicInputArtifactRecord {
  const normalizedContractGeneration = contractGeneration.trim();
  if (!normalizedContractGeneration) {
    throw new Error('contractGeneration is required for public-input artifacts');
  }

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
    contractGeneration: normalizedContractGeneration,
    votes: input.votes.map((vote) => ({
      index: vote.index,
      commitment: vote.commitment,
      merklePath: [...vote.merklePath],
    })),
  };
}

export function parsePublicInputArtifact(
  raw: unknown,
  options: PublicInputArtifactProvenance = {},
): ParsedPublicInputArtifact {
  const errors: string[] = [];
  const compatibilityMarker: PublicInputCompatibilityMarker = {};
  const observed: PublicInputObservedFields = {
    votesCount: 0,
    treeSize: 0,
    bulletinRoot: EMPTY_HEX_32,
    uniqueIndices: true,
    uniqueCommitments: true,
  };

  if (!isRecord(raw)) {
    return finalizeParsedPublicInput({
      compatibilityMarker,
      provenance: options,
      observed,
      errors: ['public_input_not_record'],
    });
  }

  const schema = getStringProperty(raw, 'schema');
  if (schema) {
    compatibilityMarker.schema = schema;
  }
  if (schema !== PUBLIC_INPUT_SCHEMA) {
    errors.push('schema');
  }

  const version = getStringProperty(raw, 'version');
  if (version) {
    compatibilityMarker.version = version;
  }
  if (version !== PUBLIC_INPUT_VERSION) {
    errors.push('version');
  }

  const contractGeneration = getStringProperty(raw, 'contractGeneration');
  if (!contractGeneration || contractGeneration.trim().length === 0) {
    errors.push('contractGeneration');
  } else {
    compatibilityMarker.contractGeneration = contractGeneration.trim();
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
      compatibilityMarker,
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
    compatibilityMarker,
    provenance: options,
    observed,
    typedAuthority,
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
  const contractGeneration = parsed.compatibilityMarker.contractGeneration;

  if (
    !parsed.valid ||
    !parsed.typedAuthority ||
    parsed.compatibilityMarker.schema !== PUBLIC_INPUT_SCHEMA ||
    parsed.compatibilityMarker.version !== PUBLIC_INPUT_VERSION ||
    typeof contractGeneration !== 'string' ||
    contractGeneration.length === 0
  ) {
    return undefined;
  }

  return {
    compatibilityMarker: {
      schema: PUBLIC_INPUT_SCHEMA,
      version: PUBLIC_INPUT_VERSION,
      contractGeneration,
    },
    provenance: { ...parsed.provenance },
    typedAuthority: { ...parsed.typedAuthority },
  };
}

export function buildSupportedPublicInputArtifactFromZkvmInput(
  input: ZkVMInput,
  methodVersion: number,
  contractGeneration: string,
  options: PublicInputArtifactProvenance = {},
): SupportedPublicInputArtifact {
  const parsed = parsePublicInputArtifact(
    buildPublicInputArtifactFromZkvmInput(input, methodVersion, contractGeneration),
    options,
  );
  const supported = toSupportedPublicInputArtifact(parsed);

  if (!supported) {
    throw new Error(`Generated public-input contract was invalid: ${parsed.errors.join(', ') || 'unknown error'}`);
  }

  return supported;
}

export function parseSupportedPublicInputArtifact(
  raw: unknown,
  options: PublicInputArtifactProvenance = {},
): SupportedPublicInputArtifact | undefined {
  return toSupportedPublicInputArtifact(parsePublicInputArtifact(raw, options));
}

export function parseStoredPublicInputArtifact(value: unknown): SupportedPublicInputArtifact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const compatibilityMarker = getRecordProperty(value, 'compatibilityMarker');
  const provenance = getRecordProperty(value, 'provenance');
  const typedAuthority = getRecordProperty(value, 'typedAuthority');
  if (!compatibilityMarker || !provenance || !typedAuthority) {
    return undefined;
  }

  const schema = getStringProperty(compatibilityMarker, 'schema');
  const version = getStringProperty(compatibilityMarker, 'version');
  const contractGeneration = getStringProperty(compatibilityMarker, 'contractGeneration');
  if (schema !== PUBLIC_INPUT_SCHEMA || version !== PUBLIC_INPUT_VERSION || !contractGeneration?.trim()) {
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
    typeof typedAuthority.uniqueIndices !== 'boolean' ||
    typeof typedAuthority.uniqueCommitments !== 'boolean' ||
    !logId ||
    !isValidHexString(logId, 32) ||
    typeof timestamp !== 'number' ||
    !Number.isInteger(timestamp) ||
    !recomputedInputCommitment ||
    !isValidHexString(recomputedInputCommitment, 32)
  ) {
    return undefined;
  }

  const executionId = getStringProperty(provenance, 'executionId');
  const bundleKey = getStringProperty(provenance, 'bundleKey');

  return {
    compatibilityMarker: {
      schema: PUBLIC_INPUT_SCHEMA,
      version: PUBLIC_INPUT_VERSION,
      contractGeneration: contractGeneration.trim(),
    },
    provenance: {
      source,
      ...(executionId ? { executionId } : {}),
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
      uniqueIndices: typedAuthority.uniqueIndices,
      uniqueCommitments: typedAuthority.uniqueCommitments,
      logId: addHexPrefix(normalizeHexString(logId)),
      timestamp,
      recomputedInputCommitment: addHexPrefix(normalizeHexString(recomputedInputCommitment)),
    },
  };
}

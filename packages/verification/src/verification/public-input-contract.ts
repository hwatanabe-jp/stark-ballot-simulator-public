import type { ZkVMInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import { computeInputCommitmentFromPublicInput } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  PUBLIC_INPUT_ARTIFACT_SCHEMA,
  PUBLIC_INPUT_ARTIFACT_VERSION,
} from '@stark-ballot/zkvm-contract/zkvm/semantic-contract';
import {
  getArrayProperty,
  getNumberProperty,
  getObjectProperty,
  getStringProperty,
  isNonNullObject,
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

  if (!isNonNullObject(raw)) {
    return finalizeParsedPublicInput({
      format,
      provenance: options,
      observed,
      errors: ['public_input_not_record'],
    });
  }
  errors.push(...unexpectedKeys(raw, PUBLIC_INPUT_KEYS));

  observePublicInputFormat(raw, format, errors);
  const electionId = observeElectionId(raw, observed, errors);
  observePublicInputHash(raw, 'electionConfigHash', observed, errors);
  observePublicInputHash(raw, 'bulletinRoot', observed, errors);
  observePublicInputInteger(raw, 'treeSize', observed, errors);
  observePublicInputInteger(raw, 'totalExpected', observed, errors);
  observePublicInputHash(raw, 'logId', observed, errors);
  observePublicInputInteger(raw, 'timestamp', observed, errors);
  observePublicInputInteger(raw, 'methodVersion', observed, errors);

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

  const parsedVotes = observePublicInputVotes(votes, observed, errors);

  observePublicInputCommitment(observed, errors, parsedVotes, votes.length, electionId);

  const typedAuthority = derivePublicInputAuthority(observed, errors);

  return finalizeParsedPublicInput({
    format,
    provenance: options,
    observed,
    ...omitUndefinedProperties({ typedAuthority: typedAuthority }),
    errors,
  });
}

function observePublicInputFormat(
  raw: Record<string, unknown>,
  format: PublicInputArtifactFormat,
  errors: string[],
): void {
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
}

function observeElectionId(
  raw: Record<string, unknown>,
  observed: PublicInputObservedFields,
  errors: string[],
): string | undefined {
  const electionId = getStringProperty(raw, 'electionId');
  if (!electionId) {
    errors.push('electionId');
  } else {
    observed.electionId = electionId;
  }

  return electionId;
}

function isPublicInputHash(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isValidHexString(value, 32);
}

function isPublicInputInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function observePublicInputHash(
  raw: Record<string, unknown>,
  field: 'electionConfigHash' | 'bulletinRoot' | 'logId',
  observed: PublicInputObservedFields,
  errors: string[],
): void {
  const value = getStringProperty(raw, field);
  if (!isPublicInputHash(value)) errors.push(field);
  else observed[field] = addHexPrefix(normalizeHexString(value));
}

function observePublicInputInteger(
  raw: Record<string, unknown>,
  field: 'treeSize' | 'totalExpected' | 'timestamp' | 'methodVersion',
  observed: PublicInputObservedFields,
  errors: string[],
): void {
  const value = getNumberProperty(raw, field);
  if (!isPublicInputInteger(value)) errors.push(field);
  else observed[field] = value;
}

function admitPublicInputVotePath(voteEntry: Record<string, unknown>, errors: string[]): string[] | undefined {
  const merklePath = getArrayProperty(voteEntry, 'merklePath');
  if (!Array.isArray(merklePath) || !merklePath.every((node) => typeof node === 'string')) {
    errors.push('vote_merkle_path');
    return undefined;
  }

  if (!merklePath.every((node) => isValidHexString(node, 32))) {
    errors.push('vote_merkle_path_hex');
    return undefined;
  }

  return merklePath;
}

function admitPublicInputVote(voteEntry: unknown, errors: string[]): PublicInputArtifactVote | undefined {
  if (!isNonNullObject(voteEntry)) {
    errors.push('vote_record');
    return undefined;
  }
  errors.push(...unexpectedKeys(voteEntry, PUBLIC_INPUT_VOTE_KEYS));

  const index = getNumberProperty(voteEntry, 'index');
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    errors.push('vote_index');
    return undefined;
  }

  const commitment = getStringProperty(voteEntry, 'commitment');
  if (!commitment || !isValidHexString(commitment, 32)) {
    errors.push('vote_commitment');
    return undefined;
  }

  const merklePath = admitPublicInputVotePath(voteEntry, errors);
  if (!merklePath) return undefined;

  return {
    index,
    commitment,
    merklePath,
  };
}

function observePublicInputVotes(
  votes: unknown[],
  observed: PublicInputObservedFields,
  errors: string[],
): PublicInputArtifactVote[] {
  const parsedVotes: PublicInputArtifactVote[] = [];
  const seenIndices = new Set<number>();
  const seenCommitments = new Set<string>();

  for (const voteEntry of votes) {
    const vote = admitPublicInputVote(voteEntry, errors);
    if (!vote) continue;
    parsedVotes.push(vote);
    const { index, commitment } = vote;

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

  return parsedVotes;
}

function observePublicInputCommitment(
  observed: PublicInputObservedFields,
  errors: string[],
  parsedVotes: PublicInputArtifactVote[],
  votesCount: number,
  electionId: string | undefined,
): void {
  if (errors.length === 0 && parsedVotes.length === votesCount && electionId && observed.totalExpected !== undefined) {
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
}

function derivePublicInputAuthority(
  observed: PublicInputObservedFields,
  errors: string[],
): PublicInputAuthority | undefined {
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
  return typedAuthority;
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

function admitStoredInputRecord(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> | undefined {
  return isNonNullObject(value) && !Array.isArray(value) && unexpectedKeys(value, allowedKeys).length === 0
    ? value
    : undefined;
}

export function parseStoredPublicInputArtifact(value: unknown): SupportedPublicInputArtifact | undefined {
  const record = admitStoredInputRecord(value, STORED_PUBLIC_INPUT_KEYS);
  if (!record) return undefined;
  const format = admitStoredInputRecord(getObjectProperty(record, 'format'), PUBLIC_INPUT_FORMAT_KEYS);
  const provenance = admitStoredInputRecord(getObjectProperty(record, 'provenance'), PUBLIC_INPUT_PROVENANCE_KEYS);
  const authorityRecord = admitStoredInputRecord(
    getObjectProperty(record, 'typedAuthority'),
    PUBLIC_INPUT_AUTHORITY_KEYS,
  );
  if (!format || !provenance || !authorityRecord) return undefined;
  if (!hasCurrentPublicInputFormat(format)) return undefined;
  const source = getStringProperty(provenance, 'source');
  if (source !== 'bundle' && source !== 'generated') return undefined;
  const typedAuthority = admitStoredPublicInputAuthority(authorityRecord);
  if (!typedAuthority) return undefined;
  return {
    format: { schema: PUBLIC_INPUT_SCHEMA, version: PUBLIC_INPUT_VERSION },
    provenance: projectStoredPublicInputProvenance(provenance, source),
    typedAuthority,
  };
}

function hasCurrentPublicInputFormat(format: Record<string, unknown>): boolean {
  return (
    getStringProperty(format, 'schema') === PUBLIC_INPUT_SCHEMA &&
    getStringProperty(format, 'version') === PUBLIC_INPUT_VERSION
  );
}

function projectStoredPublicInputProvenance(
  provenance: Record<string, unknown>,
  source: PublicInputArtifactSource,
): PublicInputArtifactProvenance {
  const finalizationId = getStringProperty(provenance, 'finalizationId');
  const bundleKey = getStringProperty(provenance, 'bundleKey');
  return { source, ...(finalizationId ? { finalizationId } : {}), ...(bundleKey ? { bundleKey } : {}) };
}

function admitStoredInputIdentity(record: Record<string, unknown>) {
  const electionId = getStringProperty(record, 'electionId');
  const electionConfigHash = getStringProperty(record, 'electionConfigHash');
  const methodVersion = getNumberProperty(record, 'methodVersion');
  if (!electionId || !isPublicInputHash(electionConfigHash) || !isPublicInputInteger(methodVersion)) return undefined;
  return { electionId, electionConfigHash: addHexPrefix(normalizeHexString(electionConfigHash)), methodVersion };
}

function admitStoredInputSnapshot(record: Record<string, unknown>) {
  const bulletinRoot = getStringProperty(record, 'bulletinRoot');
  const treeSize = getNumberProperty(record, 'treeSize');
  const totalExpected = getNumberProperty(record, 'totalExpected');
  const logId = getStringProperty(record, 'logId');
  const timestamp = getNumberProperty(record, 'timestamp');
  if (
    !isPublicInputHash(bulletinRoot) ||
    !isPublicInputInteger(treeSize) ||
    !isPublicInputInteger(totalExpected) ||
    !isPublicInputHash(logId) ||
    !isPublicInputInteger(timestamp)
  )
    return undefined;
  return {
    bulletinRoot: addHexPrefix(normalizeHexString(bulletinRoot)),
    treeSize,
    totalExpected,
    logId: addHexPrefix(normalizeHexString(logId)),
    timestamp,
  };
}

function admitStoredInputVoteFacts(record: Record<string, unknown>) {
  const votesCount = getNumberProperty(record, 'votesCount');
  const uniqueIndices = record['uniqueIndices'];
  const uniqueCommitments = record['uniqueCommitments'];
  const recomputedInputCommitment = getStringProperty(record, 'recomputedInputCommitment');
  if (
    !isPublicInputInteger(votesCount) ||
    typeof uniqueIndices !== 'boolean' ||
    typeof uniqueCommitments !== 'boolean' ||
    !isPublicInputHash(recomputedInputCommitment)
  )
    return undefined;
  return {
    votesCount,
    uniqueIndices,
    uniqueCommitments,
    recomputedInputCommitment: addHexPrefix(normalizeHexString(recomputedInputCommitment)),
  };
}

function admitStoredPublicInputAuthority(record: Record<string, unknown>): PublicInputAuthority | undefined {
  const identity = admitStoredInputIdentity(record);
  const snapshot = admitStoredInputSnapshot(record);
  const votes = admitStoredInputVoteFacts(record);
  if (!identity || !snapshot || !votes) return undefined;
  return {
    ...identity,
    bulletinRoot: snapshot.bulletinRoot,
    treeSize: snapshot.treeSize,
    totalExpected: snapshot.totalExpected,
    votesCount: votes.votesCount,
    uniqueIndices: votes.uniqueIndices,
    uniqueCommitments: votes.uniqueCommitments,
    logId: snapshot.logId,
    timestamp: snapshot.timestamp,
    recomputedInputCommitment: votes.recomputedInputCommitment,
  };
}

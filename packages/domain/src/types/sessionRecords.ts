import {
  isNonArrayObject as isRecord,
  hasExactOwnKeys as hasExactKeys,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from '@stark-ballot/validation/unknown-value-guards';
import { isValidHexString } from '@stark-ballot/crypto-primitives';
import type { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { isSafeVerifierSegment } from '@stark-ballot/validation/safe-verifier-segment';
import type { VoteChoice } from '@stark-ballot/domain/shared/constants';
import { asSessionId, type SessionId } from './identifiers';

export interface ElectionConfig {
  totalExpected: number;
  choices: readonly string[];
  version: string;
  botCount: number;
  merkleTreeDepth: number;
}

/**
 * Stable authority written once when a session is created.
 */
export interface SessionIdentityRecord {
  sessionId: SessionId;
  electionId: string;
  electionConfigHash: string;
  electionConfig: ElectionConfig;
  logId: string;
  createdAtMs: number;
}

/** Bot values whose identity and time are owned by the voting-store mutation. */
export interface BotVoteCommand {
  vote: VoteChoice;
  rand: string;
}

/** User-vote values fixed by the caller before the voting-store mutation begins. */
export interface UserVoteCommand {
  voteId: string;
  timestamp: number;
  vote: VoteChoice;
  rand: string;
}

/** Canonical vote admitted for a CT append after mutation-owned preparation. */
export interface PreparedVote extends UserVoteCommand {
  commit: string;
}

/** Persisted vote after its commitment has been appended to the CT log. */
export interface StoredVoteRecord extends PreparedVote {
  rootAtCast: string;
}

export interface RootSnapshot {
  timestamp: number;
  root: string;
  treeSize: number;
  signature?: string;
}

export type UserParticipation =
  | {
      status: 'not_cast';
    }
  | {
      status: 'cast';
      voteIndex: number;
    };

/**
 * Mutable voting/bulletin authority. Finalization and verification state do
 * not enter this record.
 */
export interface SessionVotingRecord {
  sessionId: SessionId;
  votes: Map<number, StoredVoteRecord>;
  bulletin: SimpleBulletinBoard;
  bulletinRootHistory: RootSnapshot[];
  botCount: number;
  userParticipation: UserParticipation;
  lastActivityMs: number;
}

export interface AddVoteResult {
  leafIndex: number;
  merklePath: string[];
  bulletinRootAtCast: string;
}

const IDENTITY_KEYS = new Set<keyof SessionIdentityRecord>([
  'sessionId',
  'electionId',
  'electionConfigHash',
  'electionConfig',
  'logId',
  'createdAtMs',
]);
const ELECTION_CONFIG_KEYS = new Set<keyof ElectionConfig>([
  'totalExpected',
  'choices',
  'version',
  'botCount',
  'merkleTreeDepth',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item: unknown) => typeof item === 'string' && item.length > 0)
  );
}

function parseElectionConfig(value: unknown): ElectionConfig | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ELECTION_CONFIG_KEYS)) {
    return undefined;
  }
  const totalExpected = value['totalExpected'];
  const choices = value['choices'];
  const version = value['version'];
  const botCount = value['botCount'];
  const merkleTreeDepth = value['merkleTreeDepth'];
  if (
    !isPositiveSafeInteger(totalExpected) ||
    !isNonEmptyStringArray(choices) ||
    typeof version !== 'string' ||
    version.length === 0 ||
    !isNonNegativeSafeInteger(botCount) ||
    !isPositiveSafeInteger(merkleTreeDepth)
  ) {
    return undefined;
  }
  return {
    totalExpected,
    choices: [...choices],
    version,
    botCount,
    merkleTreeDepth,
  };
}

/**
 * Strictly admits the one current identity shape. Missing and unknown fields
 * fail closed; callers do not repair identity during reads.
 */
export function parseSessionIdentityRecord(value: unknown): SessionIdentityRecord | undefined {
  if (!isRecord(value) || !hasExactKeys(value, IDENTITY_KEYS)) {
    return undefined;
  }
  const sessionId = value['sessionId'];
  const electionId = value['electionId'];
  const electionConfigHash = value['electionConfigHash'];
  const electionConfig = parseElectionConfig(value['electionConfig']);
  const logId = value['logId'];
  const createdAtMs = value['createdAtMs'];
  if (
    typeof sessionId !== 'string' ||
    !isSafeVerifierSegment(sessionId) ||
    typeof electionId !== 'string' ||
    !UUID_PATTERN.test(electionId) ||
    typeof electionConfigHash !== 'string' ||
    !isValidHexString(electionConfigHash, 32) ||
    !electionConfig ||
    typeof logId !== 'string' ||
    !isValidHexString(logId, 32) ||
    !isNonNegativeSafeInteger(createdAtMs)
  ) {
    return undefined;
  }
  return {
    sessionId: asSessionId(sessionId),
    electionId,
    electionConfigHash,
    electionConfig,
    logId,
    createdAtMs,
  };
}

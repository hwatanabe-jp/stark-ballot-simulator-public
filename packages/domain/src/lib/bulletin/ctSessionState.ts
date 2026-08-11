import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';
import type {
  RootSnapshot,
  SessionVotingRecord,
  StoredVoteRecord,
  UserParticipation,
} from '@stark-ballot/domain/types/sessionRecords';
import { asVoteIndex, type VoteIndex } from '@stark-ballot/domain/types/identifiers';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isRecord } from '@stark-ballot/validation/unknown-value-guards';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';

export interface CanonicalCtSessionProjection {
  bulletin: SimpleBulletinBoard;
  bulletinRootHistory: RootSnapshot[];
  botCount: number;
  userParticipation: UserParticipation;
  nextIndex: VoteIndex;
}

type CtVoteRecord = Pick<StoredVoteRecord, 'commit'> & Partial<Pick<StoredVoteRecord, 'voteId' | 'timestamp'>>;

export const USER_VOTE_REQUIRED_BEFORE_BOT_VOTES = 'USER_VOTE_REQUIRED_BEFORE_BOT_VOTES';
export const NON_CANONICAL_CT_VOTE_INDICES = 'NON_CANONICAL_CT_VOTE_INDICES';

export function assertCanonicalCtVoteIndices(indices: Iterable<number>): VoteIndex {
  const sortedIndices = Array.from(indices).sort((a, b) => a - b);

  for (const [expectedIndex, actualIndex] of sortedIndices.entries()) {
    if (!Number.isSafeInteger(actualIndex) || actualIndex < 0 || actualIndex !== expectedIndex) {
      throw new Error(NON_CANONICAL_CT_VOTE_INDICES);
    }
  }

  return asVoteIndex(sortedIndices.length);
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function cloneRootSnapshot(snapshot: RootSnapshot): RootSnapshot {
  return omitUndefinedProperties({
    timestamp: snapshot.timestamp,
    root: snapshot.root,
    treeSize: snapshot.treeSize,
    signature: snapshot.signature,
  });
}

function normalizePersistedRootSnapshot(value: unknown): RootSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const root = typeof value['root'] === 'string' ? value['root'] : undefined;
  const treeSize = toPositiveInteger(value['treeSize']);
  const timestamp = toPositiveInteger(value['timestamp']);

  if (!root || treeSize === undefined || timestamp === undefined) {
    return null;
  }

  try {
    return {
      root: normalizeHex(root, { allowEmpty: true }),
      treeSize,
      timestamp,
      ...(typeof value['signature'] === 'string' ? { signature: value['signature'] } : {}),
    };
  } catch {
    return null;
  }
}

function resolveSnapshotTimestamp(vote: CtVoteRecord, fallbackTimestamp: number): number {
  return typeof vote.timestamp === 'number' && Number.isInteger(vote.timestamp) && vote.timestamp > 0
    ? vote.timestamp
    : fallbackTimestamp;
}

export function parsePersistedRootHistory(value: unknown): RootSnapshot[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized: RootSnapshot[] = [];
  for (const snapshot of value) {
    const normalizedSnapshot = normalizePersistedRootSnapshot(snapshot);
    if (!normalizedSnapshot) {
      return undefined;
    }
    normalized.push(normalizedSnapshot);
  }

  return normalized;
}

export function resolveCanonicalUserVoteIndex(
  votes: ReadonlyMap<number, CtVoteRecord>,
  explicitUserVoteIndex: number | undefined,
): VoteIndex | undefined {
  if (
    typeof explicitUserVoteIndex === 'number' &&
    Number.isSafeInteger(explicitUserVoteIndex) &&
    explicitUserVoteIndex >= 0 &&
    votes.has(explicitUserVoteIndex)
  ) {
    return asVoteIndex(explicitUserVoteIndex);
  }

  return undefined;
}

export function assertCanonicalUserVoteIndexForBotVotes(
  votes: ReadonlyMap<number, CtVoteRecord>,
  explicitUserVoteIndex: number | undefined,
): VoteIndex {
  const userVoteIndex = resolveCanonicalUserVoteIndex(votes, explicitUserVoteIndex);
  if (userVoteIndex !== 0) {
    throw new Error(USER_VOTE_REQUIRED_BEFORE_BOT_VOTES);
  }
  return asVoteIndex(0);
}

export function deriveBotCountFromVotes(
  votes: ReadonlyMap<number, CtVoteRecord>,
  explicitUserVoteIndex: number | undefined,
): number {
  assertCanonicalCtVoteIndices(votes.keys());
  if (votes.size === 0) {
    return 0;
  }

  const userVoteIndex = resolveCanonicalUserVoteIndex(votes, explicitUserVoteIndex);
  if (userVoteIndex !== undefined) {
    let count = 0;
    for (const index of votes.keys()) {
      if (index !== Number(userVoteIndex)) {
        count += 1;
      }
    }
    return count;
  }

  return Math.max(votes.size - 1, 0);
}

export function getNextVoteIndex(votes: ReadonlyMap<number, CtVoteRecord>): VoteIndex {
  return assertCanonicalCtVoteIndices(votes.keys());
}

export function rebuildCanonicalBulletinFromVotes(voting: Pick<SessionVotingRecord, 'votes' | 'bulletin'>): {
  bulletin: SimpleBulletinBoard;
  reconstructedHistory: RootSnapshot[];
} {
  assertCanonicalCtVoteIndices(voting.votes.keys());
  const logId = voting.bulletin.getLogId();

  const bulletin = new SimpleBulletinBoard(logId);
  const reconstructedHistory: RootSnapshot[] = [];
  const sortedVotes = Array.from(voting.votes.entries()).sort((a, b) => a[0] - b[0]);

  for (const [, vote] of sortedVotes) {
    if (!vote.voteId) {
      continue;
    }
    const appendResult = bulletin.appendVote(vote.voteId, vote.commit.slice(2));
    reconstructedHistory.push({
      timestamp: resolveSnapshotTimestamp(vote, appendResult.timestamp),
      root: normalizeHex(appendResult.rootAtAppend, { allowEmpty: true }),
      treeSize: appendResult.index + 1,
    });
  }

  return { bulletin, reconstructedHistory };
}

function rebuildCanonicalHistoryFromVotes(votes: ReadonlyMap<number, CtVoteRecord>): RootSnapshot[] {
  assertCanonicalCtVoteIndices(votes.keys());
  const tree = new RFC6962MerkleTree();
  const reconstructedHistory: RootSnapshot[] = [];
  const sortedVotes = Array.from(votes.entries()).sort((a, b) => a[0] - b[0]);
  const fallbackTimestamp = Date.now();

  for (const [, vote] of sortedVotes) {
    tree.append(vote.commit);
    reconstructedHistory.push({
      timestamp: resolveSnapshotTimestamp(vote, fallbackTimestamp),
      root: normalizeHex(tree.getRoot(), { allowEmpty: true }),
      treeSize: tree.size,
    });
  }

  return reconstructedHistory;
}

export function mergePersistedRootHistory(
  reconstructedHistory: RootSnapshot[],
  persistedHistory: RootSnapshot[] | undefined,
): RootSnapshot[] {
  if (reconstructedHistory.length === 0) {
    return [];
  }

  if (!persistedHistory) {
    return reconstructedHistory.map(cloneRootSnapshot);
  }

  if (persistedHistory.length !== reconstructedHistory.length) {
    return reconstructedHistory.map(cloneRootSnapshot);
  }

  for (const [index, reconstructedSnapshot] of reconstructedHistory.entries()) {
    const persistedSnapshot = persistedHistory[index];
    if (!persistedSnapshot) {
      return reconstructedHistory.map(cloneRootSnapshot);
    }
    if (
      persistedSnapshot.treeSize !== reconstructedSnapshot.treeSize ||
      persistedSnapshot.root !== reconstructedSnapshot.root
    ) {
      return reconstructedHistory.map(cloneRootSnapshot);
    }
  }

  return reconstructedHistory.map((snapshot, index) => {
    const persistedSnapshot = persistedHistory[index];
    if (!persistedSnapshot) {
      return cloneRootSnapshot(snapshot);
    }
    return {
      ...snapshot,
      timestamp: persistedSnapshot.timestamp,
      ...(typeof persistedSnapshot.signature === 'string' ? { signature: persistedSnapshot.signature } : {}),
    };
  });
}

export function getCanonicalBulletinRootHistory(
  voting: Pick<SessionVotingRecord, 'sessionId' | 'votes' | 'bulletin' | 'bulletinRootHistory'>,
): RootSnapshot[] {
  const reconstructedHistory = rebuildCanonicalHistoryFromVotes(voting.votes);
  const persistedHistory = parsePersistedRootHistory(voting.bulletinRootHistory);

  return mergePersistedRootHistory(reconstructedHistory, persistedHistory);
}

export function getLatestCanonicalBulletinSnapshot(
  voting: Pick<SessionVotingRecord, 'sessionId' | 'votes' | 'bulletin' | 'bulletinRootHistory'>,
): RootSnapshot | undefined {
  const rootHistory = getCanonicalBulletinRootHistory(voting);
  return rootHistory.length > 0 ? rootHistory[rootHistory.length - 1] : undefined;
}

export function applyCanonicalCtSessionProjection(
  voting: Pick<SessionVotingRecord, 'bulletin' | 'bulletinRootHistory' | 'botCount' | 'userParticipation'>,
  projection: CanonicalCtSessionProjection,
): void {
  voting.bulletin = projection.bulletin;
  voting.bulletinRootHistory = projection.bulletinRootHistory;
  voting.botCount = projection.botCount;
  voting.userParticipation = projection.userParticipation;
}

export function buildCanonicalCtSessionProjection(
  voting: Pick<SessionVotingRecord, 'sessionId' | 'votes' | 'bulletin' | 'bulletinRootHistory' | 'userParticipation'>,
): CanonicalCtSessionProjection {
  const { bulletin } = rebuildCanonicalBulletinFromVotes(voting);
  const bulletinRootHistory = getCanonicalBulletinRootHistory(voting);
  const explicitUserVoteIndex =
    voting.userParticipation.status === 'cast' ? voting.userParticipation.voteIndex : undefined;
  const userVoteIndex = resolveCanonicalUserVoteIndex(voting.votes, explicitUserVoteIndex);

  return {
    bulletin,
    bulletinRootHistory,
    botCount: deriveBotCountFromVotes(voting.votes, explicitUserVoteIndex),
    userParticipation:
      userVoteIndex === undefined ? { status: 'not_cast' } : { status: 'cast', voteIndex: userVoteIndex },
    nextIndex: getNextVoteIndex(voting.votes),
  };
}

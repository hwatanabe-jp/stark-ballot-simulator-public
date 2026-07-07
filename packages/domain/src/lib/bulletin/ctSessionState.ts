import { SimpleBulletinBoard } from '@stark-ballot/domain/bulletin/simple-bulletin-board';
import { RFC6962MerkleTree } from '@stark-ballot/merkle/rfc6962-merkle-tree';
import type { RootSnapshot, SessionData, VoteData } from '@stark-ballot/domain/types/server';
import { asVoteIndex, type VoteIndex } from '@stark-ballot/domain/types/identifiers';
import { omitUndefinedProperties } from '@stark-ballot/validation/definedProperties';
import { isRecord } from '@stark-ballot/domain/utils/guards';
import { normalizeHex } from '@stark-ballot/domain/utils/hex';

export interface CanonicalCtSessionProjection {
  bulletin?: SimpleBulletinBoard;
  bulletinRootHistory: RootSnapshot[];
  botCount: number;
  userVoteIndex: VoteIndex | undefined;
  nextIndex: VoteIndex;
}

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

function resolveSnapshotTimestamp(vote: VoteData, fallbackTimestamp: number): number {
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
  votes: ReadonlyMap<number, VoteData>,
  fallbackUserVoteIndex: number | undefined,
): VoteIndex | undefined {
  if (
    typeof fallbackUserVoteIndex === 'number' &&
    Number.isSafeInteger(fallbackUserVoteIndex) &&
    fallbackUserVoteIndex >= 0 &&
    votes.has(fallbackUserVoteIndex)
  ) {
    return asVoteIndex(fallbackUserVoteIndex);
  }

  if (votes.has(0)) {
    return asVoteIndex(0);
  }

  return undefined;
}

export function assertCanonicalUserVoteIndexForBotVotes(
  votes: ReadonlyMap<number, VoteData>,
  fallbackUserVoteIndex: number | undefined,
): VoteIndex {
  const userVoteIndex = resolveCanonicalUserVoteIndex(votes, fallbackUserVoteIndex);
  if (userVoteIndex !== 0) {
    throw new Error(USER_VOTE_REQUIRED_BEFORE_BOT_VOTES);
  }
  return asVoteIndex(0);
}

export function deriveBotCountFromVotes(
  votes: ReadonlyMap<number, VoteData>,
  fallbackUserVoteIndex: number | undefined,
): number {
  assertCanonicalCtVoteIndices(votes.keys());
  if (votes.size === 0) {
    return 0;
  }

  const userVoteIndex = resolveCanonicalUserVoteIndex(votes, fallbackUserVoteIndex);
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

export function getNextVoteIndex(votes: ReadonlyMap<number, VoteData>): VoteIndex {
  return assertCanonicalCtVoteIndices(votes.keys());
}

export function rebuildCanonicalBulletinFromVotes(session: Pick<SessionData, 'votes' | 'logId' | 'bulletin'>): {
  bulletin?: SimpleBulletinBoard;
  reconstructedHistory: RootSnapshot[];
} {
  assertCanonicalCtVoteIndices(session.votes.keys());
  const logId = session.logId ?? session.bulletin?.getLogId();
  if (!logId) {
    return { reconstructedHistory: [] };
  }

  const bulletin = new SimpleBulletinBoard(logId);
  const reconstructedHistory: RootSnapshot[] = [];
  const sortedVotes = Array.from(session.votes.entries()).sort((a, b) => a[0] - b[0]);

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

function rebuildCanonicalHistoryFromVotes(votes: ReadonlyMap<number, VoteData>): RootSnapshot[] {
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
  session: Pick<SessionData, 'sessionId' | 'votes' | 'logId' | 'bulletin' | 'bulletinRootHistory'>,
): RootSnapshot[] {
  const reconstructedHistory = rebuildCanonicalHistoryFromVotes(session.votes);
  const persistedHistory = parsePersistedRootHistory(session.bulletinRootHistory);

  return mergePersistedRootHistory(reconstructedHistory, persistedHistory);
}

export function getLatestCanonicalBulletinSnapshot(
  session: Pick<SessionData, 'sessionId' | 'votes' | 'logId' | 'bulletin' | 'bulletinRootHistory'>,
): RootSnapshot | undefined {
  const rootHistory = getCanonicalBulletinRootHistory(session);
  return rootHistory.length > 0 ? rootHistory[rootHistory.length - 1] : undefined;
}

export function applyCanonicalCtSessionProjection(
  session: Pick<SessionData, 'bulletin' | 'bulletinRootHistory' | 'botCount' | 'userVoteIndex'>,
  projection: CanonicalCtSessionProjection,
): void {
  if (projection.bulletin) {
    session.bulletin = projection.bulletin;
  }
  session.bulletinRootHistory = projection.bulletinRootHistory;
  session.botCount = projection.botCount;
  if (projection.userVoteIndex !== undefined) {
    session.userVoteIndex = projection.userVoteIndex;
  } else {
    delete session.userVoteIndex;
  }
}

export function buildCanonicalCtSessionProjection(
  session: Pick<SessionData, 'sessionId' | 'votes' | 'logId' | 'bulletin' | 'bulletinRootHistory' | 'userVoteIndex'>,
): CanonicalCtSessionProjection {
  const { bulletin } = rebuildCanonicalBulletinFromVotes(session);
  const bulletinRootHistory = getCanonicalBulletinRootHistory(session);
  const userVoteIndex = resolveCanonicalUserVoteIndex(session.votes, session.userVoteIndex);

  return {
    ...omitUndefinedProperties({ bulletin }),
    bulletinRootHistory,
    botCount: deriveBotCountFromVotes(session.votes, session.userVoteIndex),
    userVoteIndex,
    nextIndex: getNextVoteIndex(session.votes),
  };
}

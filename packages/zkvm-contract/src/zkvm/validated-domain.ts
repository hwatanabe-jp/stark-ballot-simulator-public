import {
  asBulletinRoot,
  asElectionConfigHash,
  asElectionId,
  asImageId,
  asIncludedBitmapRoot,
  asInputCommitment,
  asLogId,
  asMerkleNodeHash,
  asRandomness32,
  asSeenBitmapRoot,
  asSthDigest,
  asVoteCommitment,
  type BulletinRoot,
  type ElectionConfigHash,
  type ElectionId,
  type ImageId,
  type IncludedBitmapRoot,
  type InputCommitment,
  type LogId,
  type MerkleNodeHash,
  type Randomness32,
  type SeenBitmapRoot,
  type SthDigest,
  type VoteCommitment,
} from './identifiers';
import { isSupportedZkVMJournal } from './journal-guards';
import {
  asBulletinIndex,
  asTotalExpected,
  asTreeSize,
  asUnixTimestampMillis,
  asVoteChoiceByte,
  asVoteCount,
  CURRENT_METHOD_VERSION,
  type BulletinIndex,
  type CurrentZkVMJournal,
  type TotalExpected,
  type TreeSize,
  type UnixTimestampMillis,
  type VoteChoiceByte,
  type VoteCount,
  type VoteWithProof,
  type ZkVMInput,
} from './types';
import { assertZkvmWireNumericPreflight } from './wire-numeric-preflight';

export interface ValidatedVoteWithProof extends VoteWithProof {
  commitment: VoteCommitment;
  choice: VoteChoiceByte;
  random: Randomness32;
  index: BulletinIndex;
  merklePath: MerkleNodeHash[];
}

export interface ValidatedZkVMInput extends ZkVMInput {
  electionId: ElectionId;
  bulletinRoot: BulletinRoot;
  treeSize: TreeSize;
  logId: LogId;
  timestamp: UnixTimestampMillis;
  totalExpected: TotalExpected;
  electionConfigHash: ElectionConfigHash;
  votes: ValidatedVoteWithProof[];
}

export interface ValidatedCurrentZkVMJournal extends CurrentZkVMJournal {
  electionId: ElectionId;
  electionConfigHash: ElectionConfigHash;
  bulletinRoot: BulletinRoot;
  treeSize: TreeSize;
  totalExpected: TotalExpected;
  sthDigest: SthDigest;
  verifiedTally: VoteCount[];
  totalVotes: VoteCount;
  validVotes: VoteCount;
  invalidVotes: VoteCount;
  seenIndicesCount: VoteCount;
  missingSlots: VoteCount;
  invalidPresentedSlots: VoteCount;
  rejectedRecords: VoteCount;
  seenBitmapRoot: SeenBitmapRoot;
  includedBitmapRoot: IncludedBitmapRoot;
  excludedSlots: VoteCount;
  inputCommitment: InputCommitment;
  methodVersion: typeof CURRENT_METHOD_VERSION;
  imageId?: ImageId;
}

export function toValidatedZkVMInput(input: ZkVMInput): ValidatedZkVMInput {
  assertZkvmWireNumericPreflight(input);

  return {
    ...input,
    electionId: asElectionId(input.electionId),
    bulletinRoot: asBulletinRoot(input.bulletinRoot),
    treeSize: asTreeSize(input.treeSize),
    logId: asLogId(input.logId),
    timestamp: asUnixTimestampMillis(input.timestamp),
    totalExpected: asTotalExpected(input.totalExpected),
    electionConfigHash: asElectionConfigHash(input.electionConfigHash),
    votes: input.votes.map(validateVoteWithProof),
  };
}

export function toValidatedCurrentZkVMJournal(journal: CurrentZkVMJournal): ValidatedCurrentZkVMJournal {
  if (!isSupportedZkVMJournal(journal)) {
    throw new Error('zkVM journal does not satisfy the current journal contract');
  }
  const { imageId, ...journalWithoutImageId } = journal;

  return {
    ...journalWithoutImageId,
    electionId: asElectionId(journal.electionId),
    electionConfigHash: asElectionConfigHash(journal.electionConfigHash),
    bulletinRoot: asBulletinRoot(journal.bulletinRoot),
    treeSize: asTreeSize(journal.treeSize),
    totalExpected: asTotalExpected(journal.totalExpected),
    sthDigest: asSthDigest(journal.sthDigest),
    verifiedTally: journal.verifiedTally.map(asVoteCount),
    totalVotes: asVoteCount(journal.totalVotes),
    validVotes: asVoteCount(journal.validVotes),
    invalidVotes: asVoteCount(journal.invalidVotes),
    seenIndicesCount: asVoteCount(journal.seenIndicesCount),
    missingSlots: asVoteCount(journal.missingSlots),
    invalidPresentedSlots: asVoteCount(journal.invalidPresentedSlots),
    rejectedRecords: asVoteCount(journal.rejectedRecords),
    seenBitmapRoot: asSeenBitmapRoot(journal.seenBitmapRoot),
    includedBitmapRoot: asIncludedBitmapRoot(journal.includedBitmapRoot),
    excludedSlots: asVoteCount(journal.excludedSlots),
    inputCommitment: asInputCommitment(journal.inputCommitment),
    methodVersion: CURRENT_METHOD_VERSION,
    ...(imageId ? { imageId: asImageId(imageId) } : {}),
  };
}

function validateVoteWithProof(vote: VoteWithProof): ValidatedVoteWithProof {
  return {
    ...vote,
    commitment: asVoteCommitment(vote.commitment),
    choice: asVoteChoiceByte(vote.choice),
    random: asRandomness32(vote.random),
    index: asBulletinIndex(vote.index),
    merklePath: vote.merklePath.map(asMerkleNodeHash),
  };
}

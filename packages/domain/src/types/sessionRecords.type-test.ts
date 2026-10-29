import type {
  BotVoteCommand,
  PreparedVote,
  SessionIdentityRecord,
  SessionVotingRecord,
  StoredVoteRecord,
  UserVoteCommand,
} from './sessionRecords';
import type * as SessionRecordTypes from './sessionRecords';
import type { CapabilityToken, SessionId } from './identifiers';

function assertSessionRecordBoundaries(
  identity: SessionIdentityRecord,
  voting: SessionVotingRecord,
  preparedVote: PreparedVote,
): void {
  // @ts-expect-error - stable identity fields are required rather than repaired during reads.
  const incompleteIdentity: SessionIdentityRecord = { sessionId: identity.sessionId };
  void incompleteIdentity;

  const identityWithFinalization: SessionIdentityRecord = {
    ...identity,
    // @ts-expect-error - application-owned finalization authority does not enter identity records.
    finalizationResult: {},
  };
  void identityWithFinalization;

  const votingWithObservation: SessionVotingRecord = {
    ...voting,
    // @ts-expect-error - verification observations remain outside voting authority.
    verificationObservation: {},
  };
  void votingWithObservation;

  // @ts-expect-error - persisted votes require the CT-owned root.
  const incompleteStoredVote: StoredVoteRecord = preparedVote;
  void incompleteStoredVote;
}

void assertSessionRecordBoundaries;

declare const sessionId: SessionId;
declare const capabilityToken: CapabilityToken;
declare const identity: SessionIdentityRecord;
declare const voting: SessionVotingRecord;

const identitySessionId: SessionId = identity.sessionId;
const votingSessionId: SessionId = voting.sessionId;
void identitySessionId;
void votingSessionId;

const userVoteCommand: UserVoteCommand = {
  voteId: '00000000-0000-4000-8000-000000000001',
  timestamp: 1,
  vote: 'A',
  rand: `0x${'1'.repeat(64)}`,
};
const botVoteCommand: BotVoteCommand = {
  vote: 'B',
  rand: `0x${'2'.repeat(64)}`,
};
const preparedVote: PreparedVote = {
  ...userVoteCommand,
  commit: `0x${'3'.repeat(64)}`,
};
const storedVote: StoredVoteRecord = {
  ...preparedVote,
  rootAtCast: `0x${'4'.repeat(64)}`,
};
void botVoteCommand;
void storedVote;

// @ts-expect-error - user callers must supply the public receipt identity.
const userVoteWithoutIdentity: UserVoteCommand = { vote: 'A', rand: '0x01' };
void userVoteWithoutIdentity;

const userVoteWithCommitment: UserVoteCommand = {
  ...userVoteCommand,
  // @ts-expect-error - callers cannot supply the mutation-owned commitment.
  commit: '0x01',
};
void userVoteWithCommitment;

const userVoteWithPath: UserVoteCommand = {
  ...userVoteCommand,
  // @ts-expect-error - callers cannot supply a dead Merkle path placeholder.
  path: [],
};
void userVoteWithPath;

const botVoteWithIdentity: BotVoteCommand = {
  ...botVoteCommand,
  // @ts-expect-error - bot identity is assigned by the mutation boundary.
  voteId: '00000000-0000-4000-8000-000000000002',
};
void botVoteWithIdentity;

const botVoteWithCommitment: BotVoteCommand = {
  ...botVoteCommand,
  // @ts-expect-error - callers cannot supply the mutation-owned commitment.
  commit: '0x02',
};
void botVoteWithCommitment;

const botVoteWithTimestamp: BotVoteCommand = {
  ...botVoteCommand,
  // @ts-expect-error - bot time is assigned by the mutation boundary.
  timestamp: 1,
};
void botVoteWithTimestamp;

// @ts-expect-error - a prepared vote always carries its computed commitment.
const preparedVoteWithoutCommitment: PreparedVote = userVoteCommand;
void preparedVoteWithoutCommitment;

const preparedVoteWithCtRoot: PreparedVote = {
  ...preparedVote,
  // @ts-expect-error - the CT append owns rootAtCast.
  rootAtCast: '0x03',
};
void preparedVoteWithCtRoot;

// @ts-expect-error - the broad legacy alias is intentionally retired.
type RetiredVoteData = SessionRecordTypes.VoteData;
declare const retiredVoteData: RetiredVoteData;
void retiredVoteData;

// @ts-expect-error - capability credentials cannot identify session records.
const identityWithCapability: SessionIdentityRecord = { ...identity, sessionId: capabilityToken };
void identityWithCapability;

// @ts-expect-error - a session identifier is not an authenticated capability credential.
const capabilityFromSession: CapabilityToken = sessionId;
void capabilityFromSession;

// Record shape is a compiler contract, independent of interface/type spelling.
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type Expect<T extends true> = T;
type IdentityKeys = 'sessionId' | 'electionId' | 'electionConfigHash' | 'electionConfig' | 'logId' | 'createdAtMs';
type VotingKeys =
  | 'sessionId'
  | 'votes'
  | 'bulletin'
  | 'bulletinRootHistory'
  | 'botCount'
  | 'userParticipation'
  | 'lastActivityMs';
type IdentityRequired = Expect<IdentityKeys extends RequiredKeys<SessionIdentityRecord> ? true : false>;
type VotingRequired = Expect<VotingKeys extends RequiredKeys<SessionVotingRecord> ? true : false>;
type IdentityAuthority = Expect<keyof SessionIdentityRecord extends IdentityKeys ? true : false>;
type VotingAuthority = Expect<keyof SessionVotingRecord extends VotingKeys ? true : false>;
const identityValues: { electionId: string; electionConfigHash: string; logId: string; createdAtMs: number } = identity;
void identityValues;
declare const recordContracts: [IdentityRequired, VotingRequired, IdentityAuthority, VotingAuthority];
void recordContracts;

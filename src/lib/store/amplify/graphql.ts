export type AmplifySessionRecord = {
  id: string;
  electionId: string;
  contractGeneration?: string | null;
  finalizationArtifactState?: string | null;
  electionConfigHash?: string | null;
  electionConfigJson?: unknown;
  logId?: string | null;
  botCount?: number | null;
  finalized?: boolean | null;
  userVoteIndex?: number | null;
  ttl?: number | null;
  createdAt?: string | number | null;
  lastActivity?: string | number | null;
  finalizationResultJson?: unknown;
  bulletinRootHistoryJson?: unknown;
};

export type AmplifyVoteRecord = {
  id: string;
  sessionId: string;
  voteIndex: number;
  choice: string;
  random: string;
  commitment: string;
  timestamp?: string | number | null;
  rootAtCast?: string | null;
  isUserVote?: boolean | null;
  path?: string[] | null;
};

export interface GraphQLError {
  message: string;
  path?: Array<string | number>;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

export interface ListVotesPage {
  items: AmplifyVoteRecord[];
  nextToken?: string | null;
}

export interface ListVoteLookupPage {
  items: AmplifyVoteRecord[];
  nextToken?: string | null;
}

const SESSION_FIELDS = [
  'id',
  'electionId',
  'contractGeneration',
  'finalizationArtifactState',
  'electionConfigHash',
  'electionConfigJson',
  'logId',
  'botCount',
  'finalized',
  'userVoteIndex',
  'ttl',
  'createdAt',
  'lastActivity',
  'finalizationResultJson',
  'bulletinRootHistoryJson',
] as const satisfies ReadonlyArray<keyof AmplifySessionRecord>;

const VOTE_FIELDS = [
  'id',
  'sessionId',
  'voteIndex',
  'choice',
  'random',
  'commitment',
  'timestamp',
  'rootAtCast',
  'isUserVote',
] as const satisfies ReadonlyArray<keyof AmplifyVoteRecord>;

const SESSION_SELECTION = SESSION_FIELDS.map((field) => `      ${field}`).join('\n');
const VOTE_SELECTION = VOTE_FIELDS.map((field) => `        ${field}`).join('\n');
const VOTE_LOOKUP_SELECTION = VOTE_FIELDS.map((field) => `        ${field}`).join('\n');

export const CREATE_SESSION_MUTATION = /* GraphQL */ `
  mutation CreateVotingSession($input: CreateVotingSessionInput!) {
    createVotingSession(input: $input) {
${SESSION_SELECTION}
    }
  }
`;

export const UPDATE_SESSION_MUTATION = /* GraphQL */ `
  mutation UpdateVotingSession($input: UpdateVotingSessionInput!) {
    updateVotingSession(input: $input) {
${SESSION_SELECTION}
    }
  }
`;

export const GET_SESSION_QUERY = /* GraphQL */ `
  query GetVotingSession($id: ID!) {
    getVotingSession(id: $id) {
${SESSION_SELECTION}
    }
  }
`;

export const LIST_VOTING_SESSIONS_QUERY = /* GraphQL */ `
  query ListVotingSessions($nextToken: String) {
    listVotingSessions(limit: 100, nextToken: $nextToken) {
      items {
        id
        contractGeneration
        finalizationArtifactState
        ttl
        finalized
        lastActivity
        finalizationResultJson
      }
      nextToken
    }
  }
`;

export const LIST_VOTES_BY_SESSION_QUERY = /* GraphQL */ `
  query VotesBySession($sessionId: ID!, $nextToken: String) {
    listVoteBySessionIdAndVoteIndex(sessionId: $sessionId, limit: 100, nextToken: $nextToken) {
      items {
${VOTE_SELECTION}
      }
      nextToken
    }
  }
`;

export const LIST_VOTES_BY_ID_QUERY = /* GraphQL */ `
  query VotesById($id: ID!, $nextToken: String) {
    listVoteById(id: $id, limit: 1, nextToken: $nextToken) {
      items {
${VOTE_LOOKUP_SELECTION}
      }
      nextToken
    }
  }
`;

export const CREATE_VOTE_MUTATION = /* GraphQL */ `
  mutation CreateVote($input: CreateVoteInput!) {
    createVote(input: $input) {
      id
      sessionId
      voteIndex
    }
  }
`;

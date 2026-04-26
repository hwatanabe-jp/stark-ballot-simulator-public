import { a, defineData, type ClientSchema } from '@aws-amplify/backend';
import { finalizeCallbackRunner } from '../functions/finalize-callback-runner/resource.js';
import { honoApi } from '../functions/hono-api/resource.js';
import { proverDispatchProxy } from '../functions/prover-dispatch-proxy/resource.js';
import { resolveDeploymentEnv } from '../lib/deployment-env-resolver.js';

type ResourceAuthorizationRule = {
  to(operations: readonly ('query' | 'mutate' | 'listen')[]): unknown;
};

type GroupAuthorizationRule = {
  to(
    operations: readonly ('create' | 'update' | 'delete' | 'read' | 'get' | 'list' | 'sync' | 'listen' | 'search')[],
  ): unknown;
};

type SecondaryIndexBuilder = (field: string) => {
  sortKeys(keys: readonly string[]): unknown;
  name(name: string): unknown;
  queryField(field: string): unknown;
};

type SchemaAuthorizationRuleBuilder = {
  resource(fn: unknown): ResourceAuthorizationRule;
  group(group: string): GroupAuthorizationRule;
};

// Amplify Data requires at least one non-resource auth rule in addition to allow.resource(...)
// for model validation. This group is intentionally not assigned to application users.
const MODEL_AUTH_FALLBACK_GROUP = 'stark-ballot-backend-service-only';

const schema = a
  .schema({
    VotingSession: a
      .model({
        id: a.id().required(),
        electionId: a.string().required(),
        contractGeneration: a.string(),
        finalizationArtifactState: a.string(),
        electionConfigHash: a.string(),
        electionConfigJson: a.json(),
        logId: a.string(),
        botCount: a.integer().default(0),
        finalized: a.boolean().default(false),
        userVoteIndex: a.integer(),
        ttl: a.integer(),
        createdAt: a.datetime(),
        lastActivity: a.datetime(),
        finalizationResultJson: a.json(),
        bulletinRootHistoryJson: a.json(),
        votes: a.hasMany('Vote', 'sessionId'),
      })
      .secondaryIndexes((index: SecondaryIndexBuilder) => [index('createdAt')]),
    Vote: a
      .model({
        id: a.id().required(),
        sessionId: a.id().required(),
        voteIndex: a.integer().required(),
        choice: a.string().required(),
        random: a.string().required(),
        commitment: a.string().required(),
        timestamp: a.datetime(),
        rootAtCast: a.string(),
        isUserVote: a.boolean(),
        session: a.belongsTo('VotingSession', 'sessionId'),
      })
      .identifier(['sessionId', 'voteIndex'])
      .secondaryIndexes((index: SecondaryIndexBuilder) => [
        index('sessionId').sortKeys(['voteIndex']),
        index('id').queryField('listVoteById'),
      ]),
  })
  .authorization((allow: SchemaAuthorizationRuleBuilder) => [
    allow.group(MODEL_AUTH_FALLBACK_GROUP).to(['read']),
    allow.resource(honoApi).to(['query', 'mutate']),
    allow.resource(proverDispatchProxy).to(['query', 'mutate']),
    allow.resource(finalizeCallbackRunner).to(['query', 'mutate']),
  ]);

export type Schema = ClientSchema<typeof schema>;

/**
 * AppSync authorization:
 * - Data-plane access is limited to trusted backend functions only.
 * - No broad authenticated principal category is used for model access.
 * - Backend roles access models through SigV4 (execution-role credentials).
 */
const deploymentEnv = resolveDeploymentEnv();
const logRetention = resolveLogRetention(deploymentEnv);

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'identityPool',
  },
  logging: {
    fieldLogLevel: 'error',
    excludeVerboseContent: true,
    retention: logRetention,
  },
});

function resolveLogRetention(env: 'develop' | 'main'): '1 week' | '2 weeks' {
  return env === 'main' ? '2 weeks' : '1 week';
}

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import { validateDynamoDbRecoverySelection } from './dynamodb-recovery-phase.js';
import {
  canonicalRecordJson,
  parseImmutableObjectReference,
  parseSha256,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from './index.js';
import { requireString } from './internal.js';

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
const MANIFEST_KEYS = [
  'accountAlias',
  'accountId',
  'deploymentEnvironment',
  'kmsKeyArn',
  'manifestType',
  'recoveryId',
  'recoveryPoint',
  'region',
  'tables',
  'validationStatus',
];
const TABLE_KEYS = [
  'globalSecondaryIndexes',
  'keySchema',
  'operationalControls',
  'replacementTableArn',
  'replacementTableName',
  'sourceTableArn',
];
const CONTROL_KEYS = [
  'billingMode',
  'deletionProtectionEnabled',
  'pointInTimeRecoveryEnabled',
  'requiredTags',
  'ttlAttribute',
];
const TAG_KEYS = ['AccountAlias', 'DataClass', 'Environment', 'Project'];
const KEY_ATTRIBUTE_KEYS = ['attributeName', 'attributeType'];
const INDEX_KEYS = ['attributeType', 'indexName', 'partitionKey', 'projectionType'];
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/u;
const WHOLE_SECOND_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/u;
const KMS_KEY_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exact(value, keys, label) {
  return snapshotExactRecord(value, keys, label);
}

/** @param {unknown} value @param {string} label */
function canonicalWholeSecondTimestamp(value, label) {
  const timestamp = requireString(value, label, WHOLE_SECOND_TIMESTAMP_PATTERN);
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return timestamp;
}

/** @param {unknown} value @param {string} label */
function denseArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a dense array.`);
  return value;
}

/** @param {'sessions' | 'votes'} kind */
function expectedTableContract(kind) {
  return kind === 'sessions'
    ? {
        keySchema: [{ attributeName: 'sessionId', attributeType: 'S' }],
        globalSecondaryIndexes: [],
        dataClass: 'session-authority',
      }
    : {
        keySchema: [
          { attributeName: 'sessionId', attributeType: 'S' },
          { attributeName: 'voteIndex', attributeType: 'N' },
        ],
        globalSecondaryIndexes: [
          {
            attributeType: 'S',
            indexName: 'voteId-index',
            partitionKey: 'voteId',
            projectionType: 'KEYS_ONLY',
          },
        ],
        dataClass: 'session-owned-votes',
      };
}

/** @param {unknown} value @param {'sessions' | 'votes'} kind @param {AllowedDeploymentTarget} target */
function admitTable(value, kind, target) {
  const label = `DynamoDB recovery ${kind} activation table`;
  const table = exact(value, TABLE_KEYS, label);
  const sourceTableArn = requireString(table['sourceTableArn'], `${label} source table ARN`);
  const replacementTableArn = requireString(table['replacementTableArn'], `${label} replacement table ARN`);
  const replacementTableName = requireString(
    table['replacementTableName'],
    `${label} replacement table name`,
    TABLE_NAME_PATTERN,
  );
  const keySchema = denseArray(table['keySchema'], `${label} key schema`).map((entry, index) => {
    const attribute = exact(entry, KEY_ATTRIBUTE_KEYS, `${label} key schema entry ${index}`);
    const attributeName = requireString(attribute['attributeName'], `${label} key schema attribute name`);
    if (attribute['attributeType'] !== 'S' && attribute['attributeType'] !== 'N') {
      throw new Error(`${label} key schema attribute type is invalid.`);
    }
    return { attributeName, attributeType: attribute['attributeType'] };
  });
  const globalSecondaryIndexes = denseArray(table['globalSecondaryIndexes'], `${label} indexes`).map((entry, index) => {
    const secondaryIndex = exact(entry, INDEX_KEYS, `${label} index ${index}`);
    const attributeType = secondaryIndex['attributeType'];
    const projectionType = secondaryIndex['projectionType'];
    if (
      (attributeType !== 'S' && attributeType !== 'N') ||
      (projectionType !== 'KEYS_ONLY' && projectionType !== 'ALL' && projectionType !== 'INCLUDE')
    ) {
      throw new Error(`${label} index is invalid.`);
    }
    return {
      attributeType,
      indexName: requireString(secondaryIndex['indexName'], `${label} index name`),
      partitionKey: requireString(secondaryIndex['partitionKey'], `${label} index partition key`),
      projectionType,
    };
  });
  const controls = exact(table['operationalControls'], CONTROL_KEYS, `${label} operational controls`);
  const tags = exact(controls['requiredTags'], TAG_KEYS, `${label} required tags`);
  const expected = expectedTableContract(kind);
  if (
    controls['billingMode'] !== 'PAY_PER_REQUEST' ||
    controls['deletionProtectionEnabled'] !== true ||
    controls['pointInTimeRecoveryEnabled'] !== true ||
    controls['ttlAttribute'] !== 'expiresAt' ||
    tags['Project'] !== 'stark-ballot-simulator' ||
    tags['AccountAlias'] !== target.accountLabel ||
    tags['Environment'] !== target.environmentId ||
    tags['DataClass'] !== expected.dataClass ||
    !isDeepStrictEqual(keySchema, expected.keySchema) ||
    !isDeepStrictEqual(globalSecondaryIndexes, expected.globalSecondaryIndexes)
  ) {
    throw new Error(`${label} is inconsistent with the current table contract.`);
  }
  return { sourceTableArn, replacementTableArn, replacementTableName };
}

/** @param {Readonly<Record<string, unknown>>} manifest */
function deriveRecoveryId(manifest) {
  const tables = /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (manifest['tables']);
  const sessions = tables['sessions'];
  const votes = tables['votes'];
  if (sessions === undefined || votes === undefined) {
    throw new Error('DynamoDB recovery activation tables are incomplete.');
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        planType: 'dynamodb-recovery',
        recoveryPoint: manifest['recoveryPoint'],
        accountAlias: manifest['accountAlias'],
        deploymentEnvironment: manifest['deploymentEnvironment'],
        accountId: manifest['accountId'],
        region: manifest['region'],
        sessionsSourceTableArn: sessions['sourceTableArn'],
        votesSourceTableArn: votes['sourceTableArn'],
        sessionsReplacementTableName: sessions['replacementTableName'],
        votesReplacementTableName: votes['replacementTableName'],
      }),
    )
    .digest('hex');
}

/**
 * @param {unknown} value
 * @param {ReturnType<typeof validateDynamoDbRecoverySelection>} selection
 * @param {AllowedDeploymentTarget} target
 */
function admitManifestAgainstSelection(value, selection, target) {
  const manifest = /** @type {Readonly<Record<string, unknown>>} */ (
    snapshotDataTree(value, 'DynamoDB recovery activation manifest snapshot')
  );
  exact(manifest, MANIFEST_KEYS, 'DynamoDB recovery activation manifest');
  if (selection.manifest === null) {
    throw new Error('DynamoDB recovery activation requires a selected transition manifest.');
  }
  const recoveryId = parseSha256(manifest['recoveryId'], 'DynamoDB recovery activation ID');
  const recoveryPoint = canonicalWholeSecondTimestamp(manifest['recoveryPoint'], 'DynamoDB recovery activation point');
  const accountAlias = requireString(manifest['accountAlias'], 'DynamoDB recovery activation account alias');
  const accountId = requireString(manifest['accountId'], 'DynamoDB recovery activation account ID', /^[0-9]{12}$/u);
  const deploymentEnvironment = requireString(
    manifest['deploymentEnvironment'],
    'DynamoDB recovery activation deployment environment',
  );
  const region = requireString(manifest['region'], 'DynamoDB recovery activation region');
  requireString(
    manifest['kmsKeyArn'],
    'DynamoDB recovery activation KMS key ARN',
    new RegExp(`^arn:${target.partition}:kms:${target.region}:${target.accountId}:key/${KMS_KEY_ID_PATTERN}$`, 'u'),
  );
  if (manifest['manifestType'] !== 'dynamodb-recovery-activation' || manifest['validationStatus'] !== 'validated') {
    throw new Error('DynamoDB recovery activation manifest type or validation status is invalid.');
  }
  const tableValues = exact(manifest['tables'], ['sessions', 'votes'], 'DynamoDB recovery activation tables');
  const tables = {
    sessions: admitTable(tableValues['sessions'], 'sessions', target),
    votes: admitTable(tableValues['votes'], 'votes', target),
  };
  const primaryNames = {
    sessions: `${target.resourcePrefix}-sessions`,
    votes: `${target.resourcePrefix}-votes`,
  };
  const sourceArns = {
    sessions: `arn:${target.partition}:dynamodb:${target.region}:${target.accountId}:table/${primaryNames.sessions}`,
    votes: `arn:${target.partition}:dynamodb:${target.region}:${target.accountId}:table/${primaryNames.votes}`,
  };
  const sessionsPrefix = `${primaryNames.sessions}-recovery-`;
  const votesPrefix = `${primaryNames.votes}-recovery-`;
  const sessionsSuffix = tables.sessions.replacementTableName.slice(sessionsPrefix.length);
  const votesSuffix = tables.votes.replacementTableName.slice(votesPrefix.length);
  const expectedReplacementArns = {
    sessions: `arn:${target.partition}:dynamodb:${target.region}:${target.accountId}:table/${tables.sessions.replacementTableName}`,
    votes: `arn:${target.partition}:dynamodb:${target.region}:${target.accountId}:table/${tables.votes.replacementTableName}`,
  };
  if (
    accountAlias !== target.accountLabel ||
    accountId !== target.accountId ||
    deploymentEnvironment !== target.environmentId ||
    region !== target.region ||
    tables.sessions.sourceTableArn !== sourceArns.sessions ||
    tables.votes.sourceTableArn !== sourceArns.votes ||
    !tables.sessions.replacementTableName.startsWith(sessionsPrefix) ||
    !tables.votes.replacementTableName.startsWith(votesPrefix) ||
    sessionsSuffix.length === 0 ||
    sessionsSuffix !== votesSuffix ||
    tables.sessions.replacementTableArn !== expectedReplacementArns.sessions ||
    tables.votes.replacementTableArn !== expectedReplacementArns.votes ||
    deriveRecoveryId({ ...manifest, recoveryPoint, recoveryId }) !== recoveryId
  ) {
    throw new Error('DynamoDB recovery activation target, source, or replacement table names are invalid.');
  }
  const bodySha256 = createHash('sha256').update(canonicalRecordJson(manifest)).digest('hex');
  if (
    selection.manifest.key !==
    `${resolveDeploymentLaneAuthority(target, 'app').names.recoveryManifestPrefix}/${recoveryId}.json`
  ) {
    throw new Error('DynamoDB recovery activation selected key is detached from its recovery ID.');
  }
  if (selection.manifest.sha256 !== bodySha256) {
    throw new Error('DynamoDB recovery activation body SHA-256 is detached from its selected reference.');
  }
  return manifest;
}

/**
 * Admit one exact immutable recovery activation body against the App execution's
 * already-selected recovery phase and versioned manifest reference.
 *
 * @param {unknown} value
 * @param {unknown} selectedRecovery
 * @param {unknown} expectedTargetKey
 */
export function admitDynamoDbRecoveryActivationManifest(value, selectedRecovery, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'DynamoDB recovery activation expected target'),
  );
  const selection = validateDynamoDbRecoverySelection(
    snapshotDataTree(selectedRecovery, 'DynamoDB recovery activation selection snapshot'),
  );
  return admitManifestAgainstSelection(value, selection, target);
}

/** @param {Readonly<Record<string, unknown>>} manifest @param {string} bodySha256 */
function projectActivation(manifest, bodySha256) {
  const tables = /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (manifest['tables']);
  const sessions = tables['sessions'];
  const votes = tables['votes'];
  if (sessions === undefined || votes === undefined) {
    throw new Error('DynamoDB recovery activation tables are incomplete.');
  }
  return /** @type {Readonly<Record<string, unknown>>} */ (
    snapshotDataTree(
      {
        manifest_type: 'dynamodb-recovery-activation',
        validation_status: 'validated',
        recovery_id: manifest['recoveryId'],
        recovery_point: manifest['recoveryPoint'],
        manifest_sha256: bodySha256,
        account_alias: manifest['accountAlias'],
        deployment_environment: manifest['deploymentEnvironment'],
        account_id: manifest['accountId'],
        region: manifest['region'],
        kms_key_arn: manifest['kmsKeyArn'],
        sessions: {
          source_table_arn: sessions['sourceTableArn'],
          table_arn: sessions['replacementTableArn'],
          table_name: sessions['replacementTableName'],
          key_schema: 'sessionId:S:HASH',
        },
        votes: {
          source_table_arn: votes['sourceTableArn'],
          table_arn: votes['replacementTableArn'],
          table_name: votes['replacementTableName'],
          key_schema: 'sessionId:S:HASH,voteIndex:N:RANGE',
          vote_id_index_schema: 'voteId-index:voteId:S:HASH:KEYS_ONLY',
        },
      },
      'DynamoDB recovery Terraform activation projection',
    )
  );
}

/**
 * Cross-bind the selected manifest body to the exact Terraform input projection
 * and specialized-smoke manifest authority from the same App execution.
 *
 * @param {unknown} value
 * @param {unknown} selectedRecovery
 * @param {unknown} evidence
 * @param {unknown} expectedTargetKey
 */
export function bindDynamoDbRecoveryActivationEvidence(value, selectedRecovery, evidence, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'DynamoDB recovery activation expected target'),
  );
  const selection = validateDynamoDbRecoverySelection(
    snapshotDataTree(selectedRecovery, 'DynamoDB recovery activation selection snapshot'),
  );
  const manifest = admitManifestAgainstSelection(value, selection, target);
  if (selection.manifest === null) {
    throw new Error('DynamoDB recovery activation evidence requires a selected manifest.');
  }
  const binding = exact(
    snapshotDataTree(evidence, 'DynamoDB recovery activation evidence snapshot'),
    ['smokeManifest', 'terraformActivation'],
    'DynamoDB recovery activation evidence',
  );
  const activation = projectActivation(manifest, selection.manifest.sha256);
  if (canonicalRecordJson(binding['terraformActivation']) !== canonicalRecordJson(activation)) {
    throw new Error('DynamoDB recovery Terraform activation is detached from its admitted manifest.');
  }
  const smokeManifest = exact(
    binding['smokeManifest'],
    ['key', 'recoveryId', 'recoveryPoint', 'replacement', 'sha256', 'versionId'],
    'DynamoDB recovery smoke manifest',
  );
  const smokeReference = parseImmutableObjectReference({
    key: smokeManifest['key'],
    sha256: smokeManifest['sha256'],
    versionId: smokeManifest['versionId'],
  });
  const replacement = exact(
    smokeManifest['replacement'],
    ['sessionsTableArn', 'votesTableArn'],
    'DynamoDB recovery smoke replacement',
  );
  const tables = /** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */ (manifest['tables']);
  const sessions = tables['sessions'];
  const votes = tables['votes'];
  if (
    sessions === undefined ||
    votes === undefined ||
    canonicalRecordJson(smokeReference) !== canonicalRecordJson(selection.manifest) ||
    smokeManifest['recoveryId'] !== manifest['recoveryId'] ||
    smokeManifest['recoveryPoint'] !== manifest['recoveryPoint'] ||
    replacement['sessionsTableArn'] !== sessions['replacementTableArn'] ||
    replacement['votesTableArn'] !== votes['replacementTableArn']
  ) {
    throw new Error('DynamoDB recovery smoke manifest is detached from its admitted activation.');
  }
  return Object.freeze({ activation, manifest });
}

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  evaluateDynamoDbRecoveryPhaseTransition,
  validateDynamoDbRecoverySelection,
} from './dynamodb-recovery-phase.js';
import {
  canonicalRecordJson,
  canonicalJsonSha256,
  deepFreeze,
  parseFullSourceSha,
  parseImmutableObjectReference,
  parseSha256,
  requireExactKeys,
  requireGroupedLowercaseUuid,
  requireString,
  sha256Text,
} from './internal.js';
import { validateAcceptedDeploymentCurrentAuthority } from './app-acceptance.js';
import {
  parseDeploymentLaneContext,
  renderDeploymentLaneContext,
  resolveAllowedDeploymentTarget,
  resolveDeploymentLaneAuthority,
} from './index.js';
import { validateTerraformDriftSummary } from './terraform-drift.js';

const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/u;
const KMS_KEY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RECOVERY_IDENTITY_KEYS = [
  'accountAlias',
  'accountId',
  'deploymentEnvironment',
  'planType',
  'recoveryPoint',
  'region',
  'sessionsReplacementTableName',
  'sessionsSourceTableArn',
  'votesReplacementTableName',
  'votesSourceTableArn',
];

export const DYNAMODB_RECOVERY_READINESS_CHECK_CATEGORIES = Object.freeze([
  'cleanup-authorization',
  'data-validation',
  'drain',
  'owner',
  'primary-sessions',
  'primary-votes',
  'quiescing',
  'read-only-iam',
  'replacement-sessions',
  'replacement-votes',
  'smoke',
  'wrong-capability',
]);

const INPUT_KEYS = [
  'acceptedBaseline',
  'cleanup',
  'currentAuthority',
  'currentControlSourceSha',
  'finishedAt',
  'iam',
  'manifest',
  'planSummary',
  'prerequisites',
  'requestedRecovery',
  'reviewedControlSourceSha',
  'startedAt',
  'tables',
  'targetContext',
];
const CURRENT_AUTHORITY_KEYS = [
  'acceptanceAttemptId',
  'authorityType',
  'bodySha256',
  'controlSourceSha',
  'dynamodbRecoveryManifest',
  'dynamodbRecoveryPhase',
  'pipelineExecutionId',
  'pointerAfter',
  'pointerBefore',
  'sourceSha',
  'stateIdentity',
];
const CURRENT_AUTHORITY_OBSERVATION_KEYS = ['body', 'pointerAfter', 'pointerBefore'];
const EVIDENCE_CURRENT_AUTHORITY_KEYS = [
  'acceptanceAttemptId',
  'authorityType',
  'bodySha256',
  'controlSourceSha',
  'dynamodbRecoveryManifest',
  'dynamodbRecoveryPhase',
  'pipelineExecutionId',
  'pointer',
  'sourceSha',
  'stateIdentity',
];
const BASELINE_KEYS = [
  'acceptanceAttemptId',
  'acceptedPlanChecksum',
  'backendKey',
  'controlSourceSha',
  'dynamodbRecoveryManifest',
  'dynamodbRecoveryPhase',
  'pipelineExecutionId',
  'recordType',
  'reference',
  'sourceSha',
  'stateIdentity',
];
const RECOVERY_ACTIVATION_MANIFEST_SOURCE_KEYS = [
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
const MANIFEST_KEYS = [...RECOVERY_ACTIVATION_MANIFEST_SOURCE_KEYS, 'bodySha256', 'reference'];
const MANIFEST_TABLE_KEYS = [
  'globalSecondaryIndexes',
  'keySchema',
  'operationalControls',
  'replacementTableArn',
  'replacementTableName',
  'sourceTableArn',
];
const OPERATIONAL_CONTROL_KEYS = [
  'billingMode',
  'deletionProtectionEnabled',
  'pointInTimeRecoveryEnabled',
  'requiredTags',
  'ttlAttribute',
];
const REQUIRED_TAG_KEYS = ['AccountAlias', 'DataClass', 'Environment', 'Project'];
const MANIFEST_KEY_ATTRIBUTE_KEYS = ['attributeName', 'attributeType'];
const MANIFEST_INDEX_KEYS = ['attributeType', 'indexName', 'partitionKey', 'projectionType'];
const TABLE_OBSERVATION_KEYS = ['availability', 'continuousBackups', 'describeTable', 'tags', 'timeToLive'];
const DESCRIBE_TABLE_KEYS = [
  'billingMode',
  'deletionProtectionEnabled',
  'globalSecondaryIndexes',
  'keySchema',
  'kmsKeyArn',
  'localSecondaryIndexCount',
  'restoreSummary',
  'sseStatus',
  'streamEnabled',
  'streamViewType',
  'tableArn',
  'tableName',
  'tableStatus',
];
const CONTINUOUS_BACKUP_KEYS = ['earliestRestorableAt', 'latestRestorableAt', 'status'];
const TIME_TO_LIVE_KEYS = ['attributeName', 'status'];
const RESTORE_SUMMARY_KEYS = ['recoveryPoint', 'restoreInProgress', 'sourceTableArn'];
const PREREQUISITE_KEYS = ['owner', 'retainedEvidence'];
const RETAINED_PREREQUISITE_SOURCE_KEYS = [
  'acceptedBaseline',
  'checks',
  'controlSourceSha',
  'currentAcceptedAuthority',
  'evidenceType',
  'observedAt',
  'requestedRecovery',
  'targetContextSha256',
];
const RETAINED_PREREQUISITE_KEYS = [...RETAINED_PREREQUISITE_SOURCE_KEYS, 'bodySha256', 'reference'];
const RETAINED_PREREQUISITE_CHECK_KEYS = ['dataValidation', 'drain', 'quiescing', 'smoke', 'wrongCapability'];
const RETAINED_AUTHORITY_KEYS = ['manifest', 'phase', 'pointer'];
const QUIESCING_KEYS = [
  'admissionClosed',
  'proverEventSourceMappingDisabled',
  'verificationEventSourceMappingDisabled',
];
const DRAIN_KEYS = [
  'finalizationsDrained',
  'inFlightExecutionsDrained',
  'proverQueueDrained',
  'verificationQueueDrained',
];
const OWNER_KEYS = ['accountMatched', 'regionMatched'];
const WRONG_CAPABILITY_KEYS = ['mutationDenied', 'stateReadDenied'];
const DATA_VALIDATION_KEYS = [
  'checksumCheckRequired',
  'countCheckRequired',
  'requiredBeforeActivation',
  'schemaCheckRequired',
];
const SMOKE_KEYS = ['currentAcceptedPhasePassed', 'requestedPhaseRequired'];
const IAM_KEYS = ['observed', 'reviewed'];
const IAM_REVIEWED_KEYS = ['attachedPolicies', 'inlinePolicies', 'permissionsBoundary', 'roleArn', 'trustPolicySha256'];
const IAM_OBSERVED_KEYS = ['attachedPolicies', 'inlinePolicies', 'permissionsBoundary', 'roleArn', 'trustPolicySha256'];
const IAM_MANAGED_POLICY_CONTRACT_KEYS = ['documentSha256', 'policyArn'];
const IAM_MANAGED_POLICY_OBSERVATION_KEYS = ['defaultVersionId', 'documentSha256', 'policyArn'];
const IAM_INLINE_POLICY_KEYS = ['documentSha256', 'policyName'];
const CLEANUP_KEYS = ['authorization', 'requested'];
const EVIDENCE_KEYS = [
  'acceptedAppBaseline',
  'cleanup',
  'controlSourceSha',
  'currentAcceptedAuthority',
  'evidenceType',
  'finishedAt',
  'iam',
  'manifest',
  'planSummary',
  'prerequisites',
  'recovery',
  'rejectedChecks',
  'reportOnly',
  'result',
  'startedAt',
  'tables',
  'target',
];
const EVIDENCE_TARGET_KEYS = [
  'accountId',
  'backendKey',
  'deploymentEnvironment',
  'region',
  'stateIdentity',
  'targetContextSha256',
  'targetKey',
];
const RECOVERY_EVIDENCE_KEYS = [
  'allowedNextPhases',
  'currentPhase',
  'manifest',
  'requestedPhase',
  'transitionDisposition',
];

function exactRecord(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact semantic shape.`, { cause: error });
  }
}

function denseDataArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  const entries = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be a dense data-property array.`);
    }
    entries.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== entries.length + 1) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  return entries;
}

function exactSourceManifestRecord(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} has unexpected fields; it must use the exact current shape.`, { cause: error });
  }
}

export function validateDynamoDbRecoveryActivationManifestSourceShape(value) {
  const manifest = exactSourceManifestRecord(
    value,
    RECOVERY_ACTIVATION_MANIFEST_SOURCE_KEYS,
    'DynamoDB recovery activation manifest',
  );
  const tables = exactSourceManifestRecord(
    manifest.tables,
    ['sessions', 'votes'],
    'DynamoDB recovery activation manifest tables',
  );
  for (const kind of ['sessions', 'votes']) {
    const rawTable = tables[kind];
    if (
      typeof rawTable === 'object' &&
      rawTable !== null &&
      !Array.isArray(rawTable) &&
      !Object.hasOwn(rawTable, 'operationalControls')
    ) {
      throw new Error(
        `${kind} recovery manifest operational controls are invalid; the manifest must use the exact current shape.`,
      );
    }
    const table = exactSourceManifestRecord(rawTable, MANIFEST_TABLE_KEYS, `${kind} recovery manifest table`);
    for (const [index, key] of denseDataArray(table.keySchema, `${kind} recovery manifest key schema`).entries()) {
      exactSourceManifestRecord(
        key,
        MANIFEST_KEY_ATTRIBUTE_KEYS,
        `${kind} recovery manifest key schema entry ${index}`,
      );
    }
    for (const [index, secondaryIndex] of denseDataArray(
      table.globalSecondaryIndexes,
      `${kind} recovery manifest index schema`,
    ).entries()) {
      exactSourceManifestRecord(
        secondaryIndex,
        MANIFEST_INDEX_KEYS,
        `${kind} recovery manifest index schema entry ${index}`,
      );
    }
    const controls = exactSourceManifestRecord(
      table.operationalControls,
      OPERATIONAL_CONTROL_KEYS,
      `${kind} recovery manifest operational controls`,
    );
    exactSourceManifestRecord(controls.requiredTags, REQUIRED_TAG_KEYS, `${kind} recovery manifest required tags`);
  }
  return deepFreeze(manifest);
}

export function validateDynamoDbRecoveryPrerequisiteEvidenceSourceShape(value) {
  const evidence = exactSourceManifestRecord(
    value,
    RETAINED_PREREQUISITE_SOURCE_KEYS,
    'DynamoDB recovery retained prerequisite evidence',
  );
  exactSourceManifestRecord(
    evidence.currentAcceptedAuthority,
    RETAINED_AUTHORITY_KEYS,
    'DynamoDB recovery retained prerequisite current authority',
  );
  const checks = exactSourceManifestRecord(
    evidence.checks,
    RETAINED_PREREQUISITE_CHECK_KEYS,
    'DynamoDB recovery retained prerequisite checks',
  );
  exactSourceManifestRecord(checks.quiescing, QUIESCING_KEYS, 'DynamoDB recovery retained quiescing checks');
  exactSourceManifestRecord(checks.drain, DRAIN_KEYS, 'DynamoDB recovery retained drain checks');
  exactSourceManifestRecord(
    checks.wrongCapability,
    WRONG_CAPABILITY_KEYS,
    'DynamoDB recovery retained wrong-capability checks',
  );
  exactSourceManifestRecord(
    checks.dataValidation,
    DATA_VALIDATION_KEYS,
    'DynamoDB recovery retained data-validation checks',
  );
  exactSourceManifestRecord(checks.smoke, SMOKE_KEYS, 'DynamoDB recovery retained smoke checks');
  return deepFreeze(evidence);
}

function canonicalTimestamp(value, label) {
  const timestamp = requireString(value, label, CANONICAL_TIMESTAMP_PATTERN);
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return timestamp;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be boolean.`);
  }
  return value;
}

function parseTargetContext(value) {
  const context = parseDeploymentLaneContext(value);
  if (context.root.lane !== 'app' || context.root.scope !== 'app') {
    throw new Error('DynamoDB recovery readiness target context must select the App lane.');
  }
  return context;
}

function parseEvidenceTarget(value, controlSourceSha) {
  const record = exactRecord(value, EVIDENCE_TARGET_KEYS, 'DynamoDB recovery readiness target');
  const target = resolveAllowedDeploymentTarget('stark-dev/develop');
  const authority = resolveDeploymentLaneAuthority(target, 'app');
  const parsed = {
    targetKey: requireString(record.targetKey, 'DynamoDB recovery readiness target key'),
    accountId: requireString(record.accountId, 'DynamoDB recovery readiness account ID', /^[0-9]{12}$/u),
    region: requireString(record.region, 'DynamoDB recovery readiness region'),
    deploymentEnvironment: requireString(
      record.deploymentEnvironment,
      'DynamoDB recovery readiness deployment environment',
    ),
    stateIdentity: requireString(record.stateIdentity, 'DynamoDB recovery readiness state identity'),
    backendKey: requireString(record.backendKey, 'DynamoDB recovery readiness backend key'),
    targetContextSha256: parseSha256(record.targetContextSha256, 'DynamoDB recovery readiness target context SHA-256'),
  };
  if (
    parsed.targetKey !== target.targetKey ||
    parsed.accountId !== target.accountId ||
    parsed.region !== target.region ||
    parsed.deploymentEnvironment !== target.environmentId ||
    parsed.stateIdentity !== authority.stateIdentity ||
    parsed.backendKey !== authority.backendKey
  ) {
    throw new Error('DynamoDB recovery readiness target does not match the reviewed App lane.');
  }
  const context = renderDeploymentLaneContext({
    target,
    lane: 'app',
    accountId: target.accountId,
    requestedControlSourceSha: controlSourceSha,
    selectedApplicationSourceSha: controlSourceSha,
    frameworkSourceSha: controlSourceSha,
  });
  if (canonicalJsonSha256(context) !== parsed.targetContextSha256) {
    throw new Error('DynamoDB recovery readiness target context SHA-256 is invalid.');
  }
  return { target: deepFreeze(parsed), context };
}

function parseCurrentAuthorityProjection(value, context, currentControlSourceSha) {
  const record = exactRecord(value, CURRENT_AUTHORITY_KEYS, 'DynamoDB recovery current accepted authority');
  if (record.authorityType !== 'app-accepted-deployment-authority') {
    throw new Error('DynamoDB recovery current accepted authority type is invalid.');
  }
  const bodySha256 = parseSha256(record.bodySha256, 'DynamoDB recovery current authority body SHA-256');
  const pointerBefore = parseImmutableObjectReference(record.pointerBefore);
  const pointerAfter = parseImmutableObjectReference(record.pointerAfter);
  if (
    record.stateIdentity !== context.root.stateIdentity ||
    pointerBefore.key !== context.names.acceptedDeploymentPointerKey ||
    pointerBefore.sha256 !== bodySha256 ||
    !isDeepStrictEqual(pointerBefore, pointerAfter)
  ) {
    throw new Error('DynamoDB recovery current accepted authority pointer changed or contradicts the App lane.');
  }
  const pipelineExecutionId = requireGroupedLowercaseUuid(
    record.pipelineExecutionId,
    'DynamoDB recovery current authority pipeline execution ID',
  );
  const acceptanceAttemptId = requireGroupedLowercaseUuid(
    record.acceptanceAttemptId,
    'DynamoDB recovery current authority acceptance attempt ID',
  );
  const sourceSha = parseFullSourceSha(record.sourceSha, 'DynamoDB recovery current authority source SHA');
  const controlSourceSha = parseFullSourceSha(
    record.controlSourceSha,
    'DynamoDB recovery current authority control source SHA',
  );
  const selection = validateDynamoDbRecoverySelection({
    phase: record.dynamodbRecoveryPhase,
    manifest: record.dynamodbRecoveryManifest,
  });
  if (sourceSha !== currentControlSourceSha || controlSourceSha !== currentControlSourceSha) {
    throw new Error('DynamoDB recovery current accepted authority does not bind the current control source.');
  }
  return deepFreeze({
    authorityType: 'app-accepted-deployment-authority',
    stateIdentity: context.root.stateIdentity,
    pointer: pointerBefore,
    bodySha256,
    pipelineExecutionId,
    acceptanceAttemptId,
    sourceSha,
    controlSourceSha,
    dynamodbRecoveryPhase: selection.phase,
    dynamodbRecoveryManifest: selection.manifest,
  });
}

function parseCurrentAuthority(value, context, currentControlSourceSha) {
  const observation = exactRecord(
    value,
    CURRENT_AUTHORITY_OBSERVATION_KEYS,
    'DynamoDB recovery current accepted authority observation',
  );
  let authority;
  try {
    authority = validateAcceptedDeploymentCurrentAuthority(observation.body);
  } catch (error) {
    throw new Error('DynamoDB recovery current accepted authority body is invalid.', { cause: error });
  }
  const acceptedDeployments = denseDataArray(
    authority.acceptedDeployments,
    'DynamoDB recovery current accepted authority deployments',
  );
  const head = acceptedDeployments[0];
  if (head === undefined) {
    throw new Error('DynamoDB recovery current accepted authority has no current deployment.');
  }
  return parseCurrentAuthorityProjection(
    {
      acceptanceAttemptId: head.acceptanceAttemptId,
      authorityType: authority.authorityType,
      bodySha256: sha256Text(canonicalRecordJson(authority)),
      controlSourceSha: head.controlSourceSha,
      dynamodbRecoveryManifest: head.dynamodbRecoveryManifest,
      dynamodbRecoveryPhase: head.dynamodbRecoveryPhase,
      pipelineExecutionId: head.pipelineExecutionId,
      pointerAfter: observation.pointerAfter,
      pointerBefore: observation.pointerBefore,
      sourceSha: head.sourceSha,
      stateIdentity: authority.stateIdentity,
    },
    context,
    currentControlSourceSha,
  );
}

function parseEvidenceCurrentAuthority(value, context, currentControlSourceSha) {
  const record = exactRecord(
    value,
    EVIDENCE_CURRENT_AUTHORITY_KEYS,
    'DynamoDB recovery readiness current accepted authority',
  );
  return parseCurrentAuthorityProjection(
    {
      acceptanceAttemptId: record.acceptanceAttemptId,
      authorityType: record.authorityType,
      bodySha256: record.bodySha256,
      controlSourceSha: record.controlSourceSha,
      dynamodbRecoveryManifest: record.dynamodbRecoveryManifest,
      dynamodbRecoveryPhase: record.dynamodbRecoveryPhase,
      pipelineExecutionId: record.pipelineExecutionId,
      pointerBefore: record.pointer,
      pointerAfter: record.pointer,
      sourceSha: record.sourceSha,
      stateIdentity: record.stateIdentity,
    },
    context,
    currentControlSourceSha,
  );
}

function parseAcceptedBaseline(value, context, currentAuthority, currentControlSourceSha) {
  const record = exactRecord(value, BASELINE_KEYS, 'DynamoDB recovery accepted App baseline');
  if (record.recordType !== 'accepted-terraform-baseline') {
    throw new Error('DynamoDB recovery accepted App baseline record type is invalid.');
  }
  const reference = parseImmutableObjectReference(record.reference);
  const pipelineExecutionId = requireGroupedLowercaseUuid(
    record.pipelineExecutionId,
    'DynamoDB recovery accepted App baseline pipeline execution ID',
  );
  const acceptanceAttemptId = requireGroupedLowercaseUuid(
    record.acceptanceAttemptId,
    'DynamoDB recovery accepted App baseline acceptance attempt ID',
  );
  const expectedKey =
    `${context.names.terraformBaselinePrefix}/${context.root.stateIdentity}/executions/${pipelineExecutionId}/` +
    `attempts/${acceptanceAttemptId}/baseline.json`;
  const sourceSha = parseFullSourceSha(record.sourceSha, 'DynamoDB recovery accepted App baseline source SHA');
  const controlSourceSha = parseFullSourceSha(
    record.controlSourceSha,
    'DynamoDB recovery accepted App baseline control source SHA',
  );
  const selection = validateDynamoDbRecoverySelection({
    phase: record.dynamodbRecoveryPhase,
    manifest: record.dynamodbRecoveryManifest,
  });
  if (
    reference.key !== expectedKey ||
    pipelineExecutionId !== currentAuthority.pipelineExecutionId ||
    acceptanceAttemptId !== currentAuthority.acceptanceAttemptId ||
    sourceSha !== currentControlSourceSha ||
    controlSourceSha !== currentControlSourceSha ||
    record.stateIdentity !== context.root.stateIdentity ||
    record.backendKey !== context.root.backendKey ||
    selection.phase !== currentAuthority.dynamodbRecoveryPhase ||
    !isDeepStrictEqual(selection.manifest, currentAuthority.dynamodbRecoveryManifest)
  ) {
    throw new Error('DynamoDB recovery accepted App baseline contradicts the current accepted authority.');
  }
  return deepFreeze({
    recordType: 'accepted-terraform-baseline',
    reference,
    pipelineExecutionId,
    acceptanceAttemptId,
    acceptedPlanChecksum: parseSha256(
      record.acceptedPlanChecksum,
      'DynamoDB recovery accepted App baseline plan checksum',
    ),
    sourceSha,
    controlSourceSha,
    stateIdentity: context.root.stateIdentity,
    backendKey: context.root.backendKey,
    dynamodbRecoveryPhase: selection.phase,
    dynamodbRecoveryManifest: selection.manifest,
  });
}

function parseRequiredTags(value, label) {
  const tags = exactRecord(value, REQUIRED_TAG_KEYS, label);
  for (const key of REQUIRED_TAG_KEYS) {
    requireString(tags[key], `${label} ${key}`);
  }
  return deepFreeze({
    Project: tags.Project,
    AccountAlias: tags.AccountAlias,
    Environment: tags.Environment,
    DataClass: tags.DataClass,
  });
}

function requiredTagsMatch(tags, context, kind) {
  return isDeepStrictEqual(tags, {
    Project: 'stark-ballot-simulator',
    AccountAlias: context.target.accountLabel,
    Environment: context.target.environmentId,
    DataClass: kind === 'sessions' ? 'session-authority' : 'session-owned-votes',
  });
}

function parseManifestKeySchema(value, label) {
  return denseDataArray(value, label).map((entry, index) => {
    const record = exactRecord(entry, MANIFEST_KEY_ATTRIBUTE_KEYS, `${label} entry ${index}`);
    const attributeName = requireString(record.attributeName, `${label} entry ${index} attribute name`);
    if (!['S', 'N'].includes(record.attributeType)) {
      throw new Error(`${label} entry ${index} attribute type is invalid.`);
    }
    return deepFreeze({ attributeName, attributeType: record.attributeType });
  });
}

function parseObservedKeySchema(value, label) {
  return denseDataArray(value, label).map((entry, index) => {
    const record = exactRecord(entry, ['attributeName', 'attributeType', 'keyType'], `${label} entry ${index}`);
    const attributeName = requireString(record.attributeName, `${label} entry ${index} attribute name`);
    if (!['S', 'N'].includes(record.attributeType) || !['HASH', 'RANGE'].includes(record.keyType)) {
      throw new Error(`${label} entry ${index} is invalid.`);
    }
    return deepFreeze({ attributeName, attributeType: record.attributeType, keyType: record.keyType });
  });
}

function parseIndexes(value, label) {
  return denseDataArray(value, label).map((entry, index) => {
    const record = exactRecord(entry, MANIFEST_INDEX_KEYS, `${label} entry ${index}`);
    const parsed = {
      indexName: requireString(record.indexName, `${label} entry ${index} index name`),
      partitionKey: requireString(record.partitionKey, `${label} entry ${index} partition key`),
      attributeType: record.attributeType,
      projectionType: record.projectionType,
    };
    if (
      !['S', 'N'].includes(parsed.attributeType) ||
      !['KEYS_ONLY', 'ALL', 'INCLUDE'].includes(parsed.projectionType)
    ) {
      throw new Error(`${label} entry ${index} is invalid.`);
    }
    return deepFreeze(parsed);
  });
}

function expectedManifestSchema(kind) {
  return kind === 'sessions'
    ? {
        keySchema: [{ attributeName: 'sessionId', attributeType: 'S' }],
        globalSecondaryIndexes: [],
      }
    : {
        keySchema: [
          { attributeName: 'sessionId', attributeType: 'S' },
          { attributeName: 'voteIndex', attributeType: 'N' },
        ],
        globalSecondaryIndexes: [
          {
            indexName: 'voteId-index',
            partitionKey: 'voteId',
            attributeType: 'S',
            projectionType: 'KEYS_ONLY',
          },
        ],
      };
}

function expectedObservedKeySchema(kind) {
  return kind === 'sessions'
    ? [{ attributeName: 'sessionId', attributeType: 'S', keyType: 'HASH' }]
    : [
        { attributeName: 'sessionId', attributeType: 'S', keyType: 'HASH' },
        { attributeName: 'voteIndex', attributeType: 'N', keyType: 'RANGE' },
      ];
}

function parseManifestTable(value, context, kind) {
  const label = `DynamoDB recovery ${kind} manifest table`;
  const record = exactRecord(value, MANIFEST_TABLE_KEYS, label);
  const sourceTableArn = requireString(record.sourceTableArn, `${label} source table ARN`);
  const replacementTableArn = requireString(record.replacementTableArn, `${label} replacement table ARN`);
  const replacementTableName = requireString(
    record.replacementTableName,
    `${label} replacement table name`,
    TABLE_NAME_PATTERN,
  );
  const keySchema = parseManifestKeySchema(record.keySchema, `${label} key schema`);
  const globalSecondaryIndexes = parseIndexes(record.globalSecondaryIndexes, `${label} indexes`);
  const expectedSchema = expectedManifestSchema(kind);
  const controls = exactRecord(record.operationalControls, OPERATIONAL_CONTROL_KEYS, `${label} operational controls`);
  const requiredTags = parseRequiredTags(controls.requiredTags, `${label} required tags`);
  if (
    controls.billingMode !== 'PAY_PER_REQUEST' ||
    controls.deletionProtectionEnabled !== true ||
    controls.pointInTimeRecoveryEnabled !== true ||
    controls.ttlAttribute !== 'expiresAt' ||
    !requiredTagsMatch(requiredTags, context, kind) ||
    !isDeepStrictEqual(keySchema, expectedSchema.keySchema) ||
    !isDeepStrictEqual(globalSecondaryIndexes, expectedSchema.globalSecondaryIndexes)
  ) {
    throw new Error(`${label} is inconsistent with the current table contract.`);
  }
  return deepFreeze({
    sourceTableArn,
    replacementTableArn,
    replacementTableName,
    keySchema,
    globalSecondaryIndexes,
    operationalControls: {
      billingMode: 'PAY_PER_REQUEST',
      deletionProtectionEnabled: true,
      pointInTimeRecoveryEnabled: true,
      ttlAttribute: 'expiresAt',
      requiredTags: {
        Project: requiredTags.Project,
        AccountAlias: requiredTags.AccountAlias,
        Environment: requiredTags.Environment,
        DataClass: requiredTags.DataClass,
      },
    },
  });
}

export function deriveDynamoDbRecoveryId(value) {
  const identity = exactRecord(value, RECOVERY_IDENTITY_KEYS, 'DynamoDB recovery identity');
  if (identity.planType !== 'dynamodb-recovery') {
    throw new Error('DynamoDB recovery identity plan type is invalid.');
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        planType: 'dynamodb-recovery',
        recoveryPoint: canonicalTimestamp(identity.recoveryPoint, 'DynamoDB recovery identity recovery point'),
        accountAlias: requireString(identity.accountAlias, 'DynamoDB recovery identity account alias'),
        deploymentEnvironment: requireString(
          identity.deploymentEnvironment,
          'DynamoDB recovery identity deployment environment',
        ),
        accountId: requireString(identity.accountId, 'DynamoDB recovery identity account ID', /^[0-9]{12}$/u),
        region: requireString(identity.region, 'DynamoDB recovery identity region'),
        sessionsSourceTableArn: requireString(
          identity.sessionsSourceTableArn,
          'DynamoDB recovery identity sessions source table ARN',
        ),
        votesSourceTableArn: requireString(
          identity.votesSourceTableArn,
          'DynamoDB recovery identity votes source table ARN',
        ),
        sessionsReplacementTableName: requireString(
          identity.sessionsReplacementTableName,
          'DynamoDB recovery identity sessions replacement table name',
        ),
        votesReplacementTableName: requireString(
          identity.votesReplacementTableName,
          'DynamoDB recovery identity votes replacement table name',
        ),
      }),
    )
    .digest('hex');
}

function parseManifest(value, context) {
  const record = exactRecord(value, MANIFEST_KEYS, 'DynamoDB recovery readiness manifest');
  const reference = parseImmutableObjectReference(record.reference);
  const bodySha256 = parseSha256(record.bodySha256, 'DynamoDB recovery manifest body SHA-256');
  const recoveryId = parseSha256(record.recoveryId, 'DynamoDB recovery ID');
  const recoveryPoint = canonicalTimestamp(record.recoveryPoint, 'DynamoDB recovery point');
  if (!recoveryPoint.endsWith('.000Z')) {
    throw new Error('DynamoDB recovery point must use whole-second precision.');
  }
  const accountAlias = requireString(record.accountAlias, 'DynamoDB recovery manifest account alias');
  const deploymentEnvironment = requireString(
    record.deploymentEnvironment,
    'DynamoDB recovery manifest deployment environment',
  );
  const accountId = requireString(record.accountId, 'DynamoDB recovery manifest account ID', /^[0-9]{12}$/u);
  const region = requireString(record.region, 'DynamoDB recovery manifest region');
  const kmsKeyArn = requireString(
    record.kmsKeyArn,
    'DynamoDB recovery manifest KMS key ARN',
    new RegExp(
      `^arn:${context.target.partition}:kms:${context.target.region}:${context.target.accountId}:key/${KMS_KEY_ID_PATTERN.source.slice(1, -1)}$`,
      'u',
    ),
  );
  if (record.manifestType !== 'dynamodb-recovery-activation' || record.validationStatus !== 'validated') {
    throw new Error('DynamoDB recovery readiness manifest type or validation status is invalid.');
  }
  const tablesRecord = exactRecord(record.tables, ['sessions', 'votes'], 'DynamoDB recovery manifest tables');
  const tables = {
    sessions: parseManifestTable(tablesRecord.sessions, context, 'sessions'),
    votes: parseManifestTable(tablesRecord.votes, context, 'votes'),
  };
  const allowedTarget = resolveAllowedDeploymentTarget('stark-dev/develop');
  const expectedPrimaryNames = {
    sessions: `${allowedTarget.resourcePrefix}-sessions`,
    votes: `${allowedTarget.resourcePrefix}-votes`,
  };
  const expectedSourceArns = {
    sessions: `arn:${context.target.partition}:dynamodb:${context.target.region}:${context.target.accountId}:table/${expectedPrimaryNames.sessions}`,
    votes: `arn:${context.target.partition}:dynamodb:${context.target.region}:${context.target.accountId}:table/${expectedPrimaryNames.votes}`,
  };
  const sessionsPrefix = `${expectedPrimaryNames.sessions}-recovery-`;
  const votesPrefix = `${expectedPrimaryNames.votes}-recovery-`;
  const sessionsSuffix = tables.sessions.replacementTableName.slice(sessionsPrefix.length);
  const votesSuffix = tables.votes.replacementTableName.slice(votesPrefix.length);
  const expectedReplacementArns = {
    sessions: `arn:${context.target.partition}:dynamodb:${context.target.region}:${context.target.accountId}:table/${tables.sessions.replacementTableName}`,
    votes: `arn:${context.target.partition}:dynamodb:${context.target.region}:${context.target.accountId}:table/${tables.votes.replacementTableName}`,
  };
  const parsed = {
    reference,
    bodySha256,
    manifestType: 'dynamodb-recovery-activation',
    validationStatus: 'validated',
    recoveryId,
    recoveryPoint,
    accountAlias,
    deploymentEnvironment,
    accountId,
    region,
    kmsKeyArn,
    tables,
  };
  if (
    reference.sha256 !== bodySha256 ||
    reference.key !== `${context.names.recoveryManifestPrefix}/${recoveryId}.json` ||
    accountAlias !== context.target.accountLabel ||
    deploymentEnvironment !== context.target.environmentId ||
    accountId !== context.target.accountId ||
    region !== context.target.region ||
    tables.sessions.sourceTableArn !== expectedSourceArns.sessions ||
    tables.votes.sourceTableArn !== expectedSourceArns.votes ||
    !tables.sessions.replacementTableName.startsWith(sessionsPrefix) ||
    !tables.votes.replacementTableName.startsWith(votesPrefix) ||
    sessionsSuffix !== votesSuffix ||
    tables.sessions.replacementTableArn !== expectedReplacementArns.sessions ||
    tables.votes.replacementTableArn !== expectedReplacementArns.votes ||
    new Set([
      expectedPrimaryNames.sessions,
      expectedPrimaryNames.votes,
      tables.sessions.replacementTableName,
      tables.votes.replacementTableName,
    ]).size !== 4 ||
    deriveDynamoDbRecoveryId({
      planType: 'dynamodb-recovery',
      recoveryPoint: parsed.recoveryPoint,
      accountAlias: parsed.accountAlias,
      deploymentEnvironment: parsed.deploymentEnvironment,
      accountId: parsed.accountId,
      region: parsed.region,
      sessionsSourceTableArn: parsed.tables.sessions.sourceTableArn,
      votesSourceTableArn: parsed.tables.votes.sourceTableArn,
      sessionsReplacementTableName: parsed.tables.sessions.replacementTableName,
      votesReplacementTableName: parsed.tables.votes.replacementTableName,
    }) !== recoveryId
  ) {
    throw new Error('DynamoDB recovery manifest target, source, or replacement table names are invalid.');
  }
  return deepFreeze(parsed);
}

function parseRestoreSummary(value, label) {
  if (value === null) return null;
  const record = exactRecord(value, RESTORE_SUMMARY_KEYS, label);
  return deepFreeze({
    sourceTableArn: requireString(record.sourceTableArn, `${label} source table ARN`),
    recoveryPoint: canonicalTimestamp(record.recoveryPoint, `${label} recovery point`),
    restoreInProgress: booleanValue(record.restoreInProgress, `${label} restoreInProgress`),
  });
}

function parseDescribeTable(value, label) {
  const record = exactRecord(value, DESCRIBE_TABLE_KEYS, label);
  if (
    ![
      'ACTIVE',
      'CREATING',
      'UPDATING',
      'DELETING',
      'ARCHIVING',
      'ARCHIVED',
      'INACCESSIBLE_ENCRYPTION_CREDENTIALS',
      'REPLICATION_NOT_AUTHORIZED',
    ].includes(record.tableStatus)
  ) {
    throw new Error(`${label} table status is invalid.`);
  }
  if (!['PAY_PER_REQUEST', 'PROVISIONED'].includes(record.billingMode)) {
    throw new Error(`${label} billing mode is invalid.`);
  }
  if (!Number.isSafeInteger(record.localSecondaryIndexCount) || record.localSecondaryIndexCount < 0) {
    throw new Error(`${label} local secondary index count is invalid.`);
  }
  if (!['ENABLED', 'ENABLING', 'DISABLED', 'DISABLING', 'UPDATING'].includes(record.sseStatus)) {
    throw new Error(`${label} SSE status is invalid.`);
  }
  const streamEnabled = booleanValue(record.streamEnabled, `${label} streamEnabled`);
  if (
    record.streamViewType !== null &&
    !['KEYS_ONLY', 'NEW_IMAGE', 'OLD_IMAGE', 'NEW_AND_OLD_IMAGES'].includes(record.streamViewType)
  ) {
    throw new Error(`${label} stream view type is invalid.`);
  }
  if ((streamEnabled && record.streamViewType === null) || (!streamEnabled && record.streamViewType !== null)) {
    throw new Error(`${label} stream configuration is inconsistent.`);
  }
  return deepFreeze({
    tableArn: requireString(record.tableArn, `${label} table ARN`),
    tableName: requireString(record.tableName, `${label} table name`, TABLE_NAME_PATTERN),
    tableStatus: record.tableStatus,
    keySchema: parseObservedKeySchema(record.keySchema, `${label} key schema`),
    globalSecondaryIndexes: parseIndexes(record.globalSecondaryIndexes, `${label} indexes`),
    localSecondaryIndexCount: record.localSecondaryIndexCount,
    billingMode: record.billingMode,
    deletionProtectionEnabled: booleanValue(record.deletionProtectionEnabled, `${label} deletionProtectionEnabled`),
    sseStatus: record.sseStatus,
    kmsKeyArn: record.kmsKeyArn === null ? null : requireString(record.kmsKeyArn, `${label} KMS key ARN`),
    streamEnabled,
    streamViewType: record.streamViewType,
    restoreSummary: parseRestoreSummary(record.restoreSummary, `${label} restore summary`),
  });
}

function parseContinuousBackups(value, label) {
  const record = exactRecord(value, CONTINUOUS_BACKUP_KEYS, label);
  if (!['ENABLED', 'DISABLED'].includes(record.status)) {
    throw new Error(`${label} status is invalid.`);
  }
  if (record.status === 'DISABLED') {
    if (record.earliestRestorableAt !== null || record.latestRestorableAt !== null) {
      throw new Error(`${label} disabled status must not claim a recovery window.`);
    }
    return deepFreeze({ status: 'DISABLED', earliestRestorableAt: null, latestRestorableAt: null });
  }
  const earliestRestorableAt = canonicalTimestamp(record.earliestRestorableAt, `${label} earliestRestorableAt`);
  const latestRestorableAt = canonicalTimestamp(record.latestRestorableAt, `${label} latestRestorableAt`);
  if (Date.parse(latestRestorableAt) < Date.parse(earliestRestorableAt)) {
    throw new Error(`${label} recovery window is invalid.`);
  }
  return deepFreeze({ status: 'ENABLED', earliestRestorableAt, latestRestorableAt });
}

function parseTimeToLive(value, label) {
  const record = exactRecord(value, TIME_TO_LIVE_KEYS, label);
  if (!['ENABLED', 'DISABLED', 'ENABLING', 'DISABLING'].includes(record.status)) {
    throw new Error(`${label} status is invalid.`);
  }
  if (record.status === 'DISABLED') {
    if (record.attributeName !== null) {
      throw new Error(`${label} disabled status must not claim an attribute.`);
    }
    return deepFreeze({ status: 'DISABLED', attributeName: null });
  }
  return deepFreeze({
    status: record.status,
    attributeName:
      record.attributeName === null ? null : requireString(record.attributeName, `${label} attribute name`),
  });
}

function parseTableObservation(value, context, kind, role) {
  const label = `DynamoDB recovery ${role} ${kind} observation`;
  const record = exactRecord(value, TABLE_OBSERVATION_KEYS, label);
  if (!['available', 'missing'].includes(record.availability)) {
    throw new Error(`${label} availability is invalid.`);
  }
  if (record.availability === 'missing') {
    if (
      record.describeTable !== null ||
      record.continuousBackups !== null ||
      record.timeToLive !== null ||
      record.tags !== null
    ) {
      throw new Error(`${label} missing result must not retain partial AWS observations.`);
    }
    return deepFreeze({
      availability: 'missing',
      describeTable: null,
      continuousBackups: null,
      timeToLive: null,
      tags: null,
    });
  }
  if (
    record.describeTable === null ||
    record.continuousBackups === null ||
    record.timeToLive === null ||
    record.tags === null
  ) {
    throw new Error(`${label} available result requires every read-only projection.`);
  }
  const tags = parseRequiredTags(record.tags, `${label} tags`);
  return deepFreeze({
    availability: 'available',
    describeTable: parseDescribeTable(record.describeTable, `${label} DescribeTable`),
    continuousBackups: parseContinuousBackups(record.continuousBackups, `${label} DescribeContinuousBackups`),
    timeToLive: parseTimeToLive(record.timeToLive, `${label} DescribeTimeToLive`),
    tags,
  });
}

function parseTables(value, context) {
  const tables = exactRecord(value, ['primary', 'replacement'], 'DynamoDB recovery table observations');
  const primary = exactRecord(tables.primary, ['sessions', 'votes'], 'DynamoDB recovery primary tables');
  const replacement = exactRecord(tables.replacement, ['sessions', 'votes'], 'DynamoDB recovery replacement tables');
  return deepFreeze({
    primary: {
      sessions: parseTableObservation(primary.sessions, context, 'sessions', 'primary'),
      votes: parseTableObservation(primary.votes, context, 'votes', 'primary'),
    },
    replacement: {
      sessions: parseTableObservation(replacement.sessions, context, 'sessions', 'replacement'),
      votes: parseTableObservation(replacement.votes, context, 'votes', 'replacement'),
    },
  });
}

function tableReady(observation, manifest, kind, role) {
  if (observation.availability !== 'available') return false;
  const description = observation.describeTable;
  const backups = observation.continuousBackups;
  const ttl = observation.timeToLive;
  const manifestTable = manifest.tables[kind];
  const expectedArn = role === 'primary' ? manifestTable.sourceTableArn : manifestTable.replacementTableArn;
  const expectedName = expectedArn.slice(expectedArn.lastIndexOf('/') + 1);
  const expectedRestore =
    role === 'primary'
      ? null
      : {
          sourceTableArn: manifestTable.sourceTableArn,
          recoveryPoint: manifest.recoveryPoint,
          restoreInProgress: false,
        };
  const recoveryPointInWindow =
    role !== 'primary' ||
    (backups.status === 'ENABLED' &&
      Date.parse(backups.earliestRestorableAt) <= Date.parse(manifest.recoveryPoint) &&
      Date.parse(manifest.recoveryPoint) <= Date.parse(backups.latestRestorableAt));
  return (
    description.tableArn === expectedArn &&
    description.tableName === expectedName &&
    description.tableStatus === 'ACTIVE' &&
    isDeepStrictEqual(description.keySchema, expectedObservedKeySchema(kind)) &&
    isDeepStrictEqual(description.globalSecondaryIndexes, manifestTable.globalSecondaryIndexes) &&
    description.localSecondaryIndexCount === 0 &&
    description.billingMode === manifestTable.operationalControls.billingMode &&
    description.deletionProtectionEnabled === manifestTable.operationalControls.deletionProtectionEnabled &&
    description.sseStatus === 'ENABLED' &&
    description.kmsKeyArn === manifest.kmsKeyArn &&
    description.streamEnabled === false &&
    description.streamViewType === null &&
    isDeepStrictEqual(description.restoreSummary, expectedRestore) &&
    backups.status === 'ENABLED' &&
    recoveryPointInWindow &&
    ttl.status === 'ENABLED' &&
    ttl.attributeName === manifestTable.operationalControls.ttlAttribute &&
    isDeepStrictEqual(
      {
        Project: observation.tags.Project,
        AccountAlias: observation.tags.AccountAlias,
        Environment: observation.tags.Environment,
        DataClass: observation.tags.DataClass,
      },
      manifestTable.operationalControls.requiredTags,
    )
  );
}

function parseBooleanRecord(value, keys, label) {
  const record = exactRecord(value, keys, label);
  return deepFreeze(Object.fromEntries(keys.map((key) => [key, booleanValue(record[key], `${label} ${key}`)])));
}

function parseRetainedPrerequisiteChecks(value) {
  const record = exactRecord(value, RETAINED_PREREQUISITE_CHECK_KEYS, 'DynamoDB recovery retained prerequisite checks');
  return deepFreeze({
    quiescing: parseBooleanRecord(record.quiescing, QUIESCING_KEYS, 'DynamoDB recovery quiescing prerequisite'),
    drain: parseBooleanRecord(record.drain, DRAIN_KEYS, 'DynamoDB recovery drain prerequisite'),
    wrongCapability: parseBooleanRecord(
      record.wrongCapability,
      WRONG_CAPABILITY_KEYS,
      'DynamoDB recovery wrong-capability prerequisite',
    ),
    dataValidation: parseBooleanRecord(
      record.dataValidation,
      DATA_VALIDATION_KEYS,
      'DynamoDB recovery data-validation prerequisite',
    ),
    smoke: parseBooleanRecord(record.smoke, SMOKE_KEYS, 'DynamoDB recovery smoke prerequisite'),
  });
}

function parseRetainedPrerequisiteEvidence(
  value,
  context,
  currentAuthority,
  acceptedBaseline,
  transition,
  controlSourceSha,
  startedAt,
) {
  if (value === null) return null;
  const record = exactRecord(value, RETAINED_PREREQUISITE_KEYS, 'DynamoDB recovery retained prerequisite evidence');
  const reference = parseImmutableObjectReference(record.reference);
  const bodySha256 = parseSha256(record.bodySha256, 'DynamoDB recovery retained prerequisite body SHA-256');
  if (reference.sha256 !== bodySha256) {
    throw new Error('DynamoDB recovery retained prerequisite evidence bytes do not match their immutable reference.');
  }
  const source = validateDynamoDbRecoveryPrerequisiteEvidenceSourceShape({
    acceptedBaseline: record.acceptedBaseline,
    checks: record.checks,
    controlSourceSha: record.controlSourceSha,
    currentAcceptedAuthority: record.currentAcceptedAuthority,
    evidenceType: record.evidenceType,
    observedAt: record.observedAt,
    requestedRecovery: record.requestedRecovery,
    targetContextSha256: record.targetContextSha256,
  });
  if (source.evidenceType !== 'dynamodb-recovery-prerequisites') {
    throw new Error('DynamoDB recovery retained prerequisite evidence type is invalid.');
  }
  const sourceControlSha = parseFullSourceSha(
    source.controlSourceSha,
    'DynamoDB recovery retained prerequisite control source SHA',
  );
  const targetContextSha256 = parseSha256(
    source.targetContextSha256,
    'DynamoDB recovery retained prerequisite target context SHA-256',
  );
  const acceptedBaselineReference = parseImmutableObjectReference(source.acceptedBaseline);
  const authorityRecord = exactRecord(
    source.currentAcceptedAuthority,
    RETAINED_AUTHORITY_KEYS,
    'DynamoDB recovery retained prerequisite current authority',
  );
  const retainedCurrent = validateDynamoDbRecoverySelection({
    phase: authorityRecord.phase,
    manifest: authorityRecord.manifest,
  });
  const authorityPointer = parseImmutableObjectReference(authorityRecord.pointer);
  const retainedRequested = validateDynamoDbRecoverySelection(source.requestedRecovery);
  const observedAt = canonicalTimestamp(source.observedAt, 'DynamoDB recovery retained prerequisite observedAt');
  const prefix = `${context.names.approvalEvidencePrefix}/recovery-readiness/`;
  if (
    !reference.key.startsWith(prefix) ||
    reference.key.length <= prefix.length ||
    sourceControlSha !== controlSourceSha ||
    targetContextSha256 !== canonicalJsonSha256(context) ||
    !isDeepStrictEqual(acceptedBaselineReference, acceptedBaseline.reference) ||
    !isDeepStrictEqual(authorityPointer, currentAuthority.pointer) ||
    !isDeepStrictEqual(retainedCurrent, transition.current) ||
    !isDeepStrictEqual(retainedRequested, transition.requested) ||
    Date.parse(observedAt) > Date.parse(startedAt)
  ) {
    throw new Error('DynamoDB recovery retained prerequisite evidence does not bind the current reviewed transition.');
  }
  return deepFreeze({
    reference,
    bodySha256,
    evidenceType: 'dynamodb-recovery-prerequisites',
    acceptedBaseline: acceptedBaselineReference,
    checks: parseRetainedPrerequisiteChecks(source.checks),
    controlSourceSha: sourceControlSha,
    currentAcceptedAuthority: {
      pointer: authorityPointer,
      phase: retainedCurrent.phase,
      manifest: retainedCurrent.manifest,
    },
    observedAt,
    requestedRecovery: retainedRequested,
    targetContextSha256,
  });
}

function parsePrerequisites(value, bindings) {
  let record;
  try {
    record = exactRecord(value, PREREQUISITE_KEYS, 'DynamoDB recovery readiness prerequisites');
  } catch (error) {
    throw new Error(
      'DynamoDB recovery readiness prerequisites must use the exact semantic shape with retained prerequisite evidence.',
      { cause: error },
    );
  }
  const retainedEvidence = parseRetainedPrerequisiteEvidence(
    record.retainedEvidence,
    bindings.context,
    bindings.currentAuthority,
    bindings.acceptedBaseline,
    bindings.transition,
    bindings.controlSourceSha,
    bindings.startedAt,
  );
  return deepFreeze({
    retainedEvidence,
    owner: parseBooleanRecord(record.owner, OWNER_KEYS, 'DynamoDB recovery owner prerequisite'),
  });
}

function parseManagedPolicyContract(value, label) {
  const record = exactRecord(value, IAM_MANAGED_POLICY_CONTRACT_KEYS, label);
  return deepFreeze({
    policyArn: requireString(record.policyArn, `${label} ARN`, /^arn:aws:iam::[0-9]{12}:policy\/[A-Za-z0-9+=,.@_-]+$/u),
    documentSha256: parseSha256(record.documentSha256, `${label} document SHA-256`),
  });
}

function parseManagedPolicyObservation(value, label) {
  const record = exactRecord(value, IAM_MANAGED_POLICY_OBSERVATION_KEYS, label);
  return deepFreeze({
    ...parseManagedPolicyContract({ policyArn: record.policyArn, documentSha256: record.documentSha256 }, label),
    defaultVersionId: requireString(record.defaultVersionId, `${label} default version ID`, /^v[1-9][0-9]*$/u),
  });
}

function parseInlinePolicy(value, label) {
  const record = exactRecord(value, IAM_INLINE_POLICY_KEYS, label);
  return deepFreeze({
    policyName: requireString(record.policyName, `${label} name`, /^[A-Za-z0-9+=,.@_-]{1,128}$/u),
    documentSha256: parseSha256(record.documentSha256, `${label} document SHA-256`),
  });
}

function sortedUniquePolicies(value, parser, identityOf, label, expectedLength) {
  const policies = denseDataArray(value, label).map((entry, index) => parser(entry, `${label} entry ${index}`));
  const sorted = [...policies].sort((left, right) => {
    const leftIdentity = identityOf(left);
    const rightIdentity = identityOf(right);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
  const identities = policies.map(identityOf);
  if (
    policies.length !== expectedLength ||
    new Set(identities).size !== identities.length ||
    !isDeepStrictEqual(policies, sorted)
  ) {
    throw new Error(`${label} must contain the exact sorted policy inventory.`);
  }
  return deepFreeze(policies);
}

function parseReviewedIam(value, context) {
  const record = exactRecord(value, IAM_REVIEWED_KEYS, 'DynamoDB recovery reviewed IAM contract');
  const roleArn = requireString(record.roleArn, 'DynamoDB recovery reviewed IAM role ARN');
  if (
    roleArn !==
    `arn:${context.target.partition}:iam::${context.target.accountId}:role/${context.names.recoveryReadinessRole}`
  ) {
    throw new Error('DynamoDB recovery reviewed IAM role does not match the canonical readiness role.');
  }
  return deepFreeze({
    roleArn,
    trustPolicySha256: parseSha256(record.trustPolicySha256, 'DynamoDB recovery reviewed trust policy SHA-256'),
    permissionsBoundary: parseManagedPolicyContract(
      record.permissionsBoundary,
      'DynamoDB recovery reviewed permissions boundary',
    ),
    attachedPolicies: sortedUniquePolicies(
      record.attachedPolicies,
      parseManagedPolicyContract,
      (policy) => policy.policyArn,
      'DynamoDB recovery reviewed attached policies',
      2,
    ),
    inlinePolicies: sortedUniquePolicies(
      record.inlinePolicies,
      parseInlinePolicy,
      (policy) => policy.policyName,
      'DynamoDB recovery reviewed inline policies',
      1,
    ),
  });
}

function parseObservedIam(value, context) {
  if (value === null) return null;
  const record = exactRecord(value, IAM_OBSERVED_KEYS, 'DynamoDB recovery observed IAM evidence');
  const roleArn = requireString(record.roleArn, 'DynamoDB recovery observed IAM role ARN');
  if (
    roleArn !==
    `arn:${context.target.partition}:iam::${context.target.accountId}:role/${context.names.recoveryReadinessRole}`
  ) {
    throw new Error('DynamoDB recovery observed IAM role does not match the canonical readiness role.');
  }
  return deepFreeze({
    roleArn,
    trustPolicySha256: parseSha256(record.trustPolicySha256, 'DynamoDB recovery observed trust policy SHA-256'),
    permissionsBoundary: parseManagedPolicyObservation(
      record.permissionsBoundary,
      'DynamoDB recovery observed permissions boundary',
    ),
    attachedPolicies: sortedUniquePolicies(
      record.attachedPolicies,
      parseManagedPolicyObservation,
      (policy) => policy.policyArn,
      'DynamoDB recovery observed attached policies',
      2,
    ),
    inlinePolicies: sortedUniquePolicies(
      record.inlinePolicies,
      parseInlinePolicy,
      (policy) => policy.policyName,
      'DynamoDB recovery observed inline policies',
      1,
    ),
  });
}

function observedIamMatchesReviewed(observed, reviewed) {
  if (
    observed === null ||
    observed.roleArn !== reviewed.roleArn ||
    observed.trustPolicySha256 !== reviewed.trustPolicySha256
  ) {
    return false;
  }
  const withoutVersion = (policy) => ({ policyArn: policy.policyArn, documentSha256: policy.documentSha256 });
  return (
    isDeepStrictEqual(withoutVersion(observed.permissionsBoundary), reviewed.permissionsBoundary) &&
    isDeepStrictEqual(observed.attachedPolicies.map(withoutVersion), reviewed.attachedPolicies) &&
    isDeepStrictEqual(observed.inlinePolicies, reviewed.inlinePolicies)
  );
}

function parseIam(value, context) {
  const record = exactRecord(value, IAM_KEYS, 'DynamoDB recovery report-only IAM evidence');
  return deepFreeze({
    reviewed: parseReviewedIam(record.reviewed, context),
    observed: parseObservedIam(record.observed, context),
  });
}

function parseCleanup(value) {
  const record = exactRecord(value, CLEANUP_KEYS, 'DynamoDB recovery cleanup selection');
  const requested = booleanValue(record.requested, 'DynamoDB recovery cleanup requested');
  const authorization = record.authorization === null ? null : parseImmutableObjectReference(record.authorization);
  if (!requested && authorization !== null) {
    throw new Error('DynamoDB recovery cleanup authorization must not be retained when cleanup is not requested.');
  }
  return deepFreeze({ requested, authorization });
}

function parsePlanSummary(value) {
  return value === null ? null : validateTerraformDriftSummary(value);
}

function allTrue(record) {
  return Object.values(record).every((value) => value === true);
}

function rejectedChecksFor({ cleanup, iam, manifest, prerequisites, tables, transition }) {
  const expectedQuiesced = transition.current.phase.endsWith('_quiesced');
  const checks = prerequisites.retainedEvidence?.checks ?? null;
  const retainedPrerequisitesAvailable = checks !== null;
  const quiescingReady =
    retainedPrerequisitesAvailable && Object.values(checks.quiescing).every((value) => value === expectedQuiesced);
  const drainReady = retainedPrerequisitesAvailable && (!expectedQuiesced || allTrue(checks.drain));
  const readyByCategory = {
    'cleanup-authorization': !cleanup.requested || cleanup.authorization !== null,
    'data-validation': retainedPrerequisitesAvailable && allTrue(checks.dataValidation),
    drain: drainReady,
    owner: allTrue(prerequisites.owner),
    'primary-sessions': tableReady(tables.primary.sessions, manifest, 'sessions', 'primary'),
    'primary-votes': tableReady(tables.primary.votes, manifest, 'votes', 'primary'),
    quiescing: quiescingReady,
    'read-only-iam': observedIamMatchesReviewed(iam.observed, iam.reviewed),
    'replacement-sessions': tableReady(tables.replacement.sessions, manifest, 'sessions', 'replacement'),
    'replacement-votes': tableReady(tables.replacement.votes, manifest, 'votes', 'replacement'),
    smoke: retainedPrerequisitesAvailable && allTrue(checks.smoke),
    'wrong-capability': retainedPrerequisitesAvailable && allTrue(checks.wrongCapability),
  };
  return DYNAMODB_RECOVERY_READINESS_CHECK_CATEGORIES.filter((category) => readyByCategory[category] !== true);
}

function parseRejectedChecks(value) {
  const checks = denseDataArray(value, 'DynamoDB recovery readiness rejected checks');
  if (
    checks.some((check) => !DYNAMODB_RECOVERY_READINESS_CHECK_CATEGORIES.includes(check)) ||
    new Set(checks).size !== checks.length ||
    !isDeepStrictEqual(
      checks,
      DYNAMODB_RECOVERY_READINESS_CHECK_CATEGORIES.filter((category) => checks.includes(category)),
    )
  ) {
    throw new Error('DynamoDB recovery readiness rejected checks are invalid.');
  }
  return checks;
}

function bindManifest(manifest, currentAuthority, acceptedBaseline, requestedRecovery) {
  const selectedReferences = [
    currentAuthority.dynamodbRecoveryManifest,
    acceptedBaseline.dynamodbRecoveryManifest,
    requestedRecovery.manifest,
  ].filter((reference) => reference !== null);
  if (
    selectedReferences.length === 0 ||
    selectedReferences.some((reference) => !isDeepStrictEqual(reference, manifest.reference))
  ) {
    throw new Error('DynamoDB recovery manifest does not bind every current and requested recovery authority.');
  }
}

function parseRecoveryEvidence(value, currentAuthority, manifest) {
  const record = exactRecord(value, RECOVERY_EVIDENCE_KEYS, 'DynamoDB recovery readiness transition evidence');
  const requested = validateDynamoDbRecoverySelection({
    phase: record.requestedPhase,
    manifest: record.requestedPhase === 'primary_active' ? null : record.manifest,
  });
  const transition = evaluateDynamoDbRecoveryPhaseTransition({
    current: {
      phase: currentAuthority.dynamodbRecoveryPhase,
      manifest: currentAuthority.dynamodbRecoveryManifest,
    },
    requested,
  });
  const manifestReference = parseImmutableObjectReference(record.manifest);
  const allowedNextPhases = denseDataArray(record.allowedNextPhases, 'DynamoDB recovery readiness allowed next phases');
  if (
    record.currentPhase !== transition.current.phase ||
    record.transitionDisposition !== transition.disposition ||
    !isDeepStrictEqual(manifestReference, manifest.reference) ||
    !isDeepStrictEqual(allowedNextPhases, transition.allowedNextPhases)
  ) {
    throw new Error('DynamoDB recovery readiness transition evidence is inconsistent.');
  }
  return transition;
}

export function validateDynamoDbRecoveryReadinessEvidence(value) {
  const evidence = exactRecord(value, EVIDENCE_KEYS, 'DynamoDB recovery readiness evidence');
  if (evidence.evidenceType !== 'dynamodb-recovery-readiness' || evidence.reportOnly !== true) {
    throw new Error('DynamoDB recovery readiness evidence type or report-only boundary is invalid.');
  }
  const controlSourceSha = parseFullSourceSha(
    evidence.controlSourceSha,
    'DynamoDB recovery readiness control source SHA',
  );
  const { target, context } = parseEvidenceTarget(evidence.target, controlSourceSha);
  const currentAuthority = parseEvidenceCurrentAuthority(evidence.currentAcceptedAuthority, context, controlSourceSha);
  const acceptedAppBaseline = parseAcceptedBaseline(
    evidence.acceptedAppBaseline,
    context,
    currentAuthority,
    controlSourceSha,
  );
  const manifest = parseManifest(evidence.manifest, context);
  const transition = parseRecoveryEvidence(evidence.recovery, currentAuthority, manifest);
  bindManifest(manifest, currentAuthority, acceptedAppBaseline, transition.requested);
  const tables = parseTables(evidence.tables, context);
  const startedAt = canonicalTimestamp(evidence.startedAt, 'DynamoDB recovery readiness startedAt');
  const prerequisites = parsePrerequisites(evidence.prerequisites, {
    context,
    currentAuthority,
    acceptedBaseline: acceptedAppBaseline,
    transition,
    controlSourceSha,
    startedAt,
  });
  const iam = parseIam(evidence.iam, context);
  const cleanup = parseCleanup(evidence.cleanup);
  const planSummary = parsePlanSummary(evidence.planSummary);
  const finishedAt = canonicalTimestamp(evidence.finishedAt, 'DynamoDB recovery readiness finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('DynamoDB recovery readiness finishedAt must not precede startedAt.');
  }
  const rejectedChecks = rejectedChecksFor({ cleanup, iam, manifest, prerequisites, tables, transition });
  const reportedRejectedChecks = parseRejectedChecks(evidence.rejectedChecks);
  const result = rejectedChecks.length === 0 ? 'ready' : 'not-ready';
  if (!isDeepStrictEqual(reportedRejectedChecks, rejectedChecks) || evidence.result !== result) {
    throw new Error('DynamoDB recovery readiness result is inconsistent with its admitted observations.');
  }
  return deepFreeze({
    evidenceType: 'dynamodb-recovery-readiness',
    target,
    currentAcceptedAuthority: currentAuthority,
    acceptedAppBaseline,
    controlSourceSha,
    recovery: {
      currentPhase: transition.current.phase,
      requestedPhase: transition.requested.phase,
      transitionDisposition: transition.disposition,
      manifest: manifest.reference,
      allowedNextPhases: transition.allowedNextPhases,
    },
    manifest,
    tables,
    prerequisites,
    iam,
    cleanup,
    planSummary,
    startedAt,
    finishedAt,
    result,
    rejectedChecks,
    reportOnly: true,
  });
}

export function evaluateDynamoDbRecoveryReadiness(value) {
  const input = exactRecord(value, INPUT_KEYS, 'DynamoDB recovery readiness input');
  const context = parseTargetContext(input.targetContext);
  const reviewedControlSourceSha = parseFullSourceSha(
    input.reviewedControlSourceSha,
    'DynamoDB recovery reviewed control source SHA',
  );
  const currentControlSourceSha = parseFullSourceSha(
    input.currentControlSourceSha,
    'DynamoDB recovery current control source SHA',
  );
  if (
    reviewedControlSourceSha !== currentControlSourceSha ||
    reviewedControlSourceSha !== context.source.requestedControlSourceSha ||
    reviewedControlSourceSha !== context.source.selectedApplicationSourceSha ||
    reviewedControlSourceSha !== context.source.frameworkSourceSha
  ) {
    throw new Error('DynamoDB recovery current control source is not the explicitly reviewed source.');
  }
  const currentAuthority = parseCurrentAuthority(input.currentAuthority, context, currentControlSourceSha);
  const acceptedAppBaseline = parseAcceptedBaseline(
    input.acceptedBaseline,
    context,
    currentAuthority,
    currentControlSourceSha,
  );
  const requestedRecovery = validateDynamoDbRecoverySelection(input.requestedRecovery);
  const transition = evaluateDynamoDbRecoveryPhaseTransition({
    current: {
      phase: currentAuthority.dynamodbRecoveryPhase,
      manifest: currentAuthority.dynamodbRecoveryManifest,
    },
    requested: requestedRecovery,
  });
  const manifest = parseManifest(input.manifest, context);
  bindManifest(manifest, currentAuthority, acceptedAppBaseline, requestedRecovery);
  const tables = parseTables(input.tables, context);
  const startedAt = canonicalTimestamp(input.startedAt, 'DynamoDB recovery readiness startedAt');
  const prerequisites = parsePrerequisites(input.prerequisites, {
    context,
    currentAuthority,
    acceptedBaseline: acceptedAppBaseline,
    transition,
    controlSourceSha: currentControlSourceSha,
    startedAt,
  });
  const iam = parseIam(input.iam, context);
  const cleanup = parseCleanup(input.cleanup);
  const planSummary = parsePlanSummary(input.planSummary);
  const finishedAt = canonicalTimestamp(input.finishedAt, 'DynamoDB recovery readiness finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new Error('DynamoDB recovery readiness finishedAt must not precede startedAt.');
  }
  const rejectedChecks = rejectedChecksFor({ cleanup, iam, manifest, prerequisites, tables, transition });
  return validateDynamoDbRecoveryReadinessEvidence({
    evidenceType: 'dynamodb-recovery-readiness',
    target: {
      targetKey: `${context.target.accountLabel}/${context.target.environmentId}`,
      accountId: context.target.accountId,
      region: context.target.region,
      deploymentEnvironment: context.target.environmentId,
      stateIdentity: context.root.stateIdentity,
      backendKey: context.root.backendKey,
      targetContextSha256: canonicalJsonSha256(context),
    },
    currentAcceptedAuthority: currentAuthority,
    acceptedAppBaseline,
    controlSourceSha: currentControlSourceSha,
    recovery: {
      currentPhase: transition.current.phase,
      requestedPhase: transition.requested.phase,
      transitionDisposition: transition.disposition,
      manifest: manifest.reference,
      allowedNextPhases: transition.allowedNextPhases,
    },
    manifest,
    tables,
    prerequisites,
    iam,
    cleanup,
    planSummary,
    startedAt,
    finishedAt,
    result: rejectedChecks.length === 0 ? 'ready' : 'not-ready',
    rejectedChecks,
    reportOnly: true,
  });
}

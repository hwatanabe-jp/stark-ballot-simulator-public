import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types as utilTypes } from 'node:util';
import { deepFreeze, parseImmutableObjectReference, requireExactKeys, requireString } from './internal.js';

/** @type {readonly ['primary_active', 'primary_quiesced', 'replacement_quiesced', 'replacement_active']} */
export const DYNAMODB_RECOVERY_PHASES = Object.freeze([
  'primary_active',
  'primary_quiesced',
  'replacement_quiesced',
  'replacement_active',
]);

const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
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

/**
 * @typedef {(typeof DYNAMODB_RECOVERY_PHASES)[number]} DynamoDbRecoveryPhase
 * @typedef {{ readonly phase: DynamoDbRecoveryPhase, readonly manifest: import('./internal.js').ImmutableObjectReference | null }} DynamoDbRecoverySelection
 * @typedef {{ readonly current: DynamoDbRecoverySelection | null, readonly requested: DynamoDbRecoverySelection }} DynamoDbRecoveryPhaseTransitionInput
 * @typedef {{
 *   readonly current: DynamoDbRecoverySelection | null,
 *   readonly requested: DynamoDbRecoverySelection,
 *   readonly disposition: 'initial' | 'idempotent' | 'forward' | 'reverse',
 *   readonly allowedNextPhases: readonly DynamoDbRecoveryPhase[],
 * }} DynamoDbRecoveryPhaseTransition
 */

/** @param {unknown} value @param {readonly string[]} keys @param {string} label @returns {Record<string, unknown>} */
function exactRecord(value, keys, label) {
  try {
    return requireExactKeys(value, keys, label);
  } catch {
    throw new Error(`${label} must use the exact current shape.`);
  }
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} label @returns {Record<string, unknown>} */
function exactSourceManifestRecord(value, keys, label) {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null && utilTypes.isProxy(value)) {
    throw new Error(`${label} has unexpected fields; it must use the exact current shape.`);
  }
  try {
    return requireExactKeys(value, keys, label);
  } catch (error) {
    throw new Error(`${label} has unexpected fields; it must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label @returns {unknown[]} */
function denseDataArray(value, label) {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null && utilTypes.isProxy(value)) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a dense data-property array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
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

/** @param {unknown} value @param {string} label @returns {string} */
function canonicalTimestamp(value, label) {
  const timestamp = requireString(value, label, CANONICAL_TIMESTAMP_PATTERN);
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return timestamp;
}

/**
 * Retains exact activation-manifest source admission for the real recovery
 * workflow after the optional report-only readiness surface is removed.
 *
 * @param {unknown} value
 * @returns {Readonly<Record<string, unknown>>}
 */
export function validateDynamoDbRecoveryActivationManifestSourceShape(value) {
  const manifest = exactSourceManifestRecord(
    value,
    RECOVERY_ACTIVATION_MANIFEST_SOURCE_KEYS,
    'DynamoDB recovery activation manifest',
  );
  const tables = exactSourceManifestRecord(
    manifest['tables'],
    ['sessions', 'votes'],
    'DynamoDB recovery activation manifest tables',
  );
  for (const kind of ['sessions', 'votes']) {
    const rawTable = tables[kind];
    if (
      typeof rawTable === 'object' &&
      rawTable !== null &&
      !Array.isArray(rawTable) &&
      !utilTypes.isProxy(rawTable) &&
      !Object.hasOwn(rawTable, 'operationalControls')
    ) {
      throw new Error(
        `${kind} recovery manifest operational controls are invalid; the manifest must use the exact current shape.`,
      );
    }
    const table = exactSourceManifestRecord(rawTable, MANIFEST_TABLE_KEYS, `${kind} recovery manifest table`);
    for (const [index, key] of denseDataArray(table['keySchema'], `${kind} recovery manifest key schema`).entries()) {
      exactSourceManifestRecord(
        key,
        MANIFEST_KEY_ATTRIBUTE_KEYS,
        `${kind} recovery manifest key schema entry ${index}`,
      );
    }
    for (const [index, secondaryIndex] of denseDataArray(
      table['globalSecondaryIndexes'],
      `${kind} recovery manifest index schema`,
    ).entries()) {
      exactSourceManifestRecord(
        secondaryIndex,
        MANIFEST_INDEX_KEYS,
        `${kind} recovery manifest index schema entry ${index}`,
      );
    }
    const controls = exactSourceManifestRecord(
      table['operationalControls'],
      OPERATIONAL_CONTROL_KEYS,
      `${kind} recovery manifest operational controls`,
    );
    exactSourceManifestRecord(controls['requiredTags'], REQUIRED_TAG_KEYS, `${kind} recovery manifest required tags`);
  }
  return deepFreeze(manifest);
}

/**
 * Derives the stable recovery identity used by the real dry-run/activation
 * workflow. This is recovery authority, not readiness evidence.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function deriveDynamoDbRecoveryId(value) {
  const identity = exactRecord(value, RECOVERY_IDENTITY_KEYS, 'DynamoDB recovery identity');
  if (identity['planType'] !== 'dynamodb-recovery') {
    throw new Error('DynamoDB recovery identity plan type is invalid.');
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        planType: 'dynamodb-recovery',
        recoveryPoint: canonicalTimestamp(identity['recoveryPoint'], 'DynamoDB recovery identity recovery point'),
        accountAlias: requireString(identity['accountAlias'], 'DynamoDB recovery identity account alias'),
        deploymentEnvironment: requireString(
          identity['deploymentEnvironment'],
          'DynamoDB recovery identity deployment environment',
        ),
        accountId: requireString(identity['accountId'], 'DynamoDB recovery identity account ID', /^[0-9]{12}$/u),
        region: requireString(identity['region'], 'DynamoDB recovery identity region'),
        sessionsSourceTableArn: requireString(
          identity['sessionsSourceTableArn'],
          'DynamoDB recovery identity sessions source table ARN',
        ),
        votesSourceTableArn: requireString(
          identity['votesSourceTableArn'],
          'DynamoDB recovery identity votes source table ARN',
        ),
        sessionsReplacementTableName: requireString(
          identity['sessionsReplacementTableName'],
          'DynamoDB recovery identity sessions replacement table name',
        ),
        votesReplacementTableName: requireString(
          identity['votesReplacementTableName'],
          'DynamoDB recovery identity votes replacement table name',
        ),
      }),
    )
    .digest('hex');
}

/** @param {unknown} value @returns {DynamoDbRecoveryPhase} */
export function parseDynamoDbRecoveryPhase(value) {
  switch (value) {
    case 'primary_active':
    case 'primary_quiesced':
    case 'replacement_quiesced':
    case 'replacement_active':
      return value;
    default:
      throw new Error('DynamoDB recovery phase is invalid.');
  }
}

/** @param {unknown} value @returns {DynamoDbRecoverySelection} */
export function validateDynamoDbRecoverySelection(value) {
  const record = exactRecord(value, ['manifest', 'phase'], 'DynamoDB recovery selection');
  const phase = parseDynamoDbRecoveryPhase(record['phase']);
  if (phase === 'primary_active') {
    if (record['manifest'] !== null) {
      throw new Error('primary_active must not select a DynamoDB recovery manifest.');
    }
    return deepFreeze({ phase, manifest: null });
  }
  if (record['manifest'] === null) {
    throw new Error('DynamoDB recovery transition phases require an exact recovery manifest.');
  }
  return deepFreeze({
    phase,
    manifest: parseImmutableObjectReference(record['manifest']),
  });
}

/** @param {DynamoDbRecoverySelection | null} current @returns {readonly DynamoDbRecoveryPhase[]} */
function allowedNextPhases(current) {
  if (current === null) {
    return Object.freeze(['primary_active']);
  }
  const currentIndex = DYNAMODB_RECOVERY_PHASES.indexOf(current.phase);
  return Object.freeze(DYNAMODB_RECOVERY_PHASES.filter((_phase, index) => Math.abs(index - currentIndex) <= 1));
}

/** @param {unknown} value @returns {DynamoDbRecoveryPhaseTransition} */
export function evaluateDynamoDbRecoveryPhaseTransition(value) {
  const record = exactRecord(value, ['current', 'requested'], 'DynamoDB recovery phase transition');
  const current = record['current'] === null ? null : validateDynamoDbRecoverySelection(record['current']);
  const requested = validateDynamoDbRecoverySelection(record['requested']);
  const allowedNext = allowedNextPhases(current);

  if (current === null) {
    if (requested.phase !== 'primary_active') {
      throw new Error('Initial DynamoDB recovery authority must use primary_active.');
    }
    return deepFreeze({
      current,
      requested,
      disposition: 'initial',
      allowedNextPhases: allowedNext,
    });
  }

  const currentIndex = DYNAMODB_RECOVERY_PHASES.indexOf(current.phase);
  const requestedIndex = DYNAMODB_RECOVERY_PHASES.indexOf(requested.phase);
  const phaseDelta = requestedIndex - currentIndex;
  if (Math.abs(phaseDelta) > 1) {
    throw new Error('DynamoDB recovery phases may change by only one adjacent phase.');
  }
  if (
    current.manifest !== null &&
    requested.manifest !== null &&
    !isDeepStrictEqual(current.manifest, requested.manifest)
  ) {
    throw new Error('DynamoDB recovery manifest must remain exact across selected recovery phases.');
  }

  return deepFreeze({
    current,
    requested,
    disposition: phaseDelta === 0 ? 'idempotent' : phaseDelta === 1 ? 'forward' : 'reverse',
    allowedNextPhases: allowedNext,
  });
}

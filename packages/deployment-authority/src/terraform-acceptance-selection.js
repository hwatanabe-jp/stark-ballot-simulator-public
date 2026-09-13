import { canonicalRecordJson, resolveAllowedDeploymentTarget } from './index.js';
import { captureExactPortRecord, invokeExactPort } from './conditional-object-ledger.js';
import { snapshotExactRecord } from './descriptor-snapshot.js';
import { deepFreeze, parseS3VersionId, requireString } from './internal.js';
import {
  BOOTSTRAP_ACCEPTANCE_KIND,
  BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND,
  FOUNDATION_ACCEPTANCE_KIND,
  FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND,
  admitTerraformAcceptancePointer,
  admitTerraformAcceptanceRecord,
  admitTerraformAcceptanceRecordKey,
  deriveTerraformAcceptanceRecordKey,
  deriveTerraformAcceptancePointerKey,
} from './terraform-acceptance.js';

const INPUT_KEYS = ['expectedTargetKey', 'root', 'transport'];
const TRANSPORT_KEYS = ['getObject'];
const OBJECT_KEYS = ['body', 'etag', 'versionId'];
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_ACCEPTANCE_BYTES = 8 * 1024 * 1024;

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactRecord(value, keys, label) {
  try {
    return snapshotExactRecord(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value */
function admitRoot(value) {
  if (value !== 'bootstrap' && value !== 'foundation') {
    throw new Error('Terraform acceptance selection root is not admitted.');
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function admitObservation(value, label) {
  const observation = exactRecord(value, ['etag', 'versionId'], label);
  const etag = requireString(observation['etag'], `${label} ETag`);
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} ETag is invalid.`);
  }
  return deepFreeze({
    etag,
    versionId: parseS3VersionId(observation['versionId'], `${label} VersionId`),
  });
}

/** @param {unknown} body @param {number} maximumBytes @param {string} label */
function parseCanonicalBody(body, maximumBytes, label) {
  if (
    typeof body !== 'string' ||
    body.length === 0 ||
    Buffer.byteLength(body, 'utf8') > maximumBytes ||
    body.includes('\0')
  ) {
    throw new Error(`${label} body is invalid.`);
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} body is not valid JSON.`, { cause: error });
  }
  if (canonicalRecordJson(value) !== body) {
    throw new Error(`${label} body is not canonical JSON.`);
  }
  return value;
}

/** @param {unknown} value @param {number} maximumBytes @param {string} label */
function admitObject(value, maximumBytes, label) {
  if (value === undefined) throw new Error(`${label} does not exist.`);
  const object = exactRecord(value, OBJECT_KEYS, label);
  return deepFreeze({
    value: parseCanonicalBody(object['body'], maximumBytes, label),
    observation: admitObservation({ etag: object['etag'], versionId: object['versionId'] }, label),
  });
}

/** @param {'bootstrap' | 'foundation'} root @param {unknown} value @param {import('./index.js').AllowedDeploymentTarget} target */
function admitSelectedRecord(root, value, target) {
  if (root === 'bootstrap') {
    const record = admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, value, target.targetKey);
    return deepFreeze({
      derivedRecordKey: deriveTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, record, target.targetKey),
      record,
    });
  }
  const record = admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, value, target.targetKey);
  return deepFreeze({
    derivedRecordKey: deriveTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, record, target.targetKey),
    record,
  });
}

/**
 * Resolve one current Bootstrap or Foundation Terraform acceptance through
 * exactly one pointer observation and one selected-record observation.
 *
 * @param {unknown} input
 */
export async function resolveCurrentTerraformAcceptance(input) {
  const request = exactRecord(input, INPUT_KEYS, 'Current Terraform acceptance selection request');
  const target = resolveAllowedDeploymentTarget(
    requireString(request['expectedTargetKey'], 'Terraform acceptance selection expected target'),
  );
  const root = admitRoot(request['root']);
  const transport = captureExactPortRecord(
    request['transport'],
    TRANSPORT_KEYS,
    'Current Terraform acceptance selection transport',
  );
  const pointerKind =
    root === 'bootstrap' ? BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND : FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND;
  const pointerKey = deriveTerraformAcceptancePointerKey(pointerKind, target.targetKey);
  const pointerObject = await invokeExactPort(
    transport['getObject'],
    [Object.freeze({ key: pointerKey, maxBytes: MAX_POINTER_BYTES })],
    `Current ${root} Terraform acceptance pointer read`,
    (value) => admitObject(value, MAX_POINTER_BYTES, `Current ${root} Terraform acceptance pointer`),
  );
  const recordKind = root === 'bootstrap' ? BOOTSTRAP_ACCEPTANCE_KIND : FOUNDATION_ACCEPTANCE_KIND;
  const pointer = admitTerraformAcceptancePointer(pointerKind, pointerObject.value, target.targetKey);
  const recordKey = admitTerraformAcceptanceRecordKey(recordKind, pointer.recordKey, target.targetKey);
  const recordObject = await invokeExactPort(
    transport['getObject'],
    [Object.freeze({ key: recordKey, maxBytes: MAX_ACCEPTANCE_BYTES })],
    `Current ${root} Terraform acceptance record read`,
    (value) => admitObject(value, MAX_ACCEPTANCE_BYTES, `Current ${root} Terraform acceptance record`),
  );
  const selectedRecord = admitSelectedRecord(root, recordObject.value, target);
  const record = selectedRecord.record;
  if (
    selectedRecord.derivedRecordKey !== recordKey ||
    pointer.pipelineExecutionId !== record.pipelineExecutionId ||
    pointer.acceptanceAttemptId !== record.acceptanceAttemptId
  ) {
    throw new Error(`Current ${root} Terraform acceptance pointer is detached from its selected record.`);
  }
  return deepFreeze({
    pointer,
    pointerKey,
    pointerObservation: pointerObject.observation,
    record,
    recordKey,
    recordObservation: recordObject.observation,
  });
}

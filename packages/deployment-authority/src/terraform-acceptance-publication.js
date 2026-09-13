/**
 * @typedef {import('./index.js').AllowedDeploymentTarget} AllowedDeploymentTarget
 * @typedef {import('./terraform-acceptance.js').BootstrapTerraformAcceptance} BootstrapTerraformAcceptance
 * @typedef {import('./terraform-acceptance.js').FoundationTerraformAcceptance} FoundationTerraformAcceptance
 * @typedef {import('./terraform-acceptance.js').BootstrapTerraformAcceptancePointer} BootstrapTerraformAcceptancePointer
 * @typedef {import('./terraform-acceptance.js').FoundationTerraformAcceptancePointer} FoundationTerraformAcceptancePointer
 */

/**
 * @typedef {typeof BOOTSTRAP_ACCEPTANCE_KIND | typeof FOUNDATION_ACCEPTANCE_KIND} TerraformAcceptanceKind
 * @typedef {typeof BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND | typeof FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND} TerraformAcceptancePointerKind
 * @typedef {BootstrapTerraformAcceptance | FoundationTerraformAcceptance} TerraformAcceptanceRecord
 * @typedef {{readonly etag: string, readonly versionId: string}} TerraformAcceptanceObservation
 * @typedef {{
 *   readonly publishRecord: (kind: TerraformAcceptanceKind, record: unknown) => unknown | Promise<unknown>;
 *   readonly movePointer: (input: unknown) => unknown | Promise<unknown>;
 * }} TerraformAcceptancePublicationLedger
 * @typedef {{
 *   readonly kind: TerraformAcceptanceKind;
 *   readonly pointerKind: TerraformAcceptancePointerKind;
 *   readonly pointerKey: string;
 *   readonly record: unknown;
 *   readonly expected: TerraformAcceptanceObservation | null;
 *   readonly ledger: TerraformAcceptancePublicationLedger;
 *   readonly expectedTargetKey: string;
 * }} TerraformAcceptancePublicationInput
 * @typedef {{
 *   readonly recordStatus: 'created' | 'idempotent-retry';
 *   readonly recordKey: string;
 *   readonly pointerStatus: 'moved' | 'idempotent-retry';
 *   readonly pointerKey: string;
 *   readonly pointerObservation: TerraformAcceptanceObservation;
 * }} TerraformAcceptancePublicationResult
 * @typedef {{readonly type: 'if-none-match'} | {readonly type: 'if-match', readonly etag: string, readonly versionId: string}} TerraformAcceptancePutCondition
 * @typedef {{
 *   readonly getObject: (input: {readonly key: string, readonly maxBytes: number}) => unknown | Promise<unknown>;
 *   readonly putObject: (input: {readonly key: string, readonly body: string, readonly condition: TerraformAcceptancePutCondition}) => unknown | Promise<unknown>;
 * }} TerraformAcceptanceTransport
 */

import { canonicalRecordJson, deepFreeze, parseS3VersionId, requireString } from './internal.js';
import { resolveAllowedDeploymentTarget } from './index.js';
import { snapshotDataTree, snapshotExactRecord } from './descriptor-snapshot.js';
import {
  assertProxyFreePortData,
  assertUnproxiedPortShell,
  captureExactPortRecord,
  createConditionalObjectLedger,
  invokeExactPort,
} from './conditional-object-ledger.js';
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

const INPUT_KEYS = ['expectedTargetKey', 'expected', 'kind', 'ledger', 'pointerKey', 'pointerKind', 'record'];
const LEDGER_KEYS = ['movePointer', 'publishRecord'];
const RECORD_PUBLICATION_KEYS = ['key', 'kind', 'record', 'recordObservation', 'status'];
const POINTER_CONFLICT_KEYS = ['expected', 'observed', 'pointerKey', 'status'];
const POINTER_MOVEMENT_KEYS = ['pointer', 'pointerKey', 'pointerObservation', 'record', 'recordKey', 'status'];
const OBSERVED_POINTER_KEYS = ['pointer', 'pointerObservation'];
const OBSERVATION_KEYS = ['etag', 'versionId'];
const POINTER_MOVE_REQUEST_KEYS = [
  'acceptanceAttemptId',
  'expected',
  'kind',
  'pipelineExecutionId',
  'pointerKey',
  'recordKey',
];
const POINTER_OBSERVATION_REQUEST_KEYS = ['kind', 'pointerKey'];

export class TerraformAcceptancePointerConflictError extends Error {
  constructor() {
    super('Terraform acceptance pointer changed after review.');
    this.name = 'TerraformAcceptancePointerConflictError';
  }
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function exactKeys(value, keys, label) {
  assertUnproxiedPortShell(value, label);
  try {
    return /** @type {Record<string, unknown>} */ (snapshotExactRecord(value, keys, label));
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function opaqueEtag(value, label) {
  let etag;
  try {
    etag = requireString(value, label);
  } catch (error) {
    throw new Error(`${label} is invalid.`, { cause: error });
  }
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} is invalid.`);
  }
  return etag;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {TerraformAcceptanceObservation}
 */
function admitObservation(value, label) {
  const observation = exactKeys(value, OBSERVATION_KEYS, label);
  return deepFreeze({
    etag: opaqueEtag(observation['etag'], `${label} ETag`),
    versionId: parseS3VersionId(observation['versionId'], `${label} VersionId`),
  });
}

/**
 * @param {unknown} value
 * @returns {TerraformAcceptanceObservation | null}
 */
function admitExpected(value) {
  return value === null ? null : admitObservation(value, 'Terraform acceptance expected pointer');
}

/**
 * @param {TerraformAcceptanceObservation | null} left
 * @param {TerraformAcceptanceObservation | null} right
 * @returns {boolean}
 */
function observationsEqual(left, right) {
  return (
    (left === null && right === null) ||
    (left !== null && right !== null && left.etag === right.etag && left.versionId === right.versionId)
  );
}

/**
 * @param {string} body
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function parseCanonicalBody(body, label) {
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} is not canonical JSON.`, { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || canonicalRecordJson(value) !== body) {
    throw new Error(`${label} is not canonical JSON.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {string} body
 * @param {TerraformAcceptancePointerKind} kind
 * @param {AllowedDeploymentTarget} target
 * @returns {BootstrapTerraformAcceptancePointer | FoundationTerraformAcceptancePointer | undefined}
 */
function tryAdmitTargetPointer(body, kind, target) {
  try {
    return admitTerraformAcceptancePointer(
      kind,
      parseCanonicalBody(body, 'Terraform acceptance current pointer'),
      target.targetKey,
    );
  } catch {
    return undefined;
  }
}

/**
 * Create the Terraform-acceptance ledger over the same exact conditional
 * object-transport contract used by release authority. AWS and filesystem
 * behavior remain outside this package.
 *
 * @param {TerraformAcceptanceTransport} transportValue
 * @param {unknown} coordinateObject
 * @param {unknown} expectedTargetKey
 */
export function createTerraformAcceptanceLedger(transportValue, coordinateObject, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'Terraform acceptance ledger expected target'),
  );
  const conditionalObjects = createConditionalObjectLedger({
    byteLimits: { pointerMaxBytes: 64 * 1024, recordMaxBytes: 8 * 1024 * 1024 },
    coordinateObject,
    transport: transportValue,
  });

  /** @param {unknown} input */
  async function observePointer(input) {
    const request = exactKeys(input, POINTER_OBSERVATION_REQUEST_KEYS, 'Terraform acceptance pointer observation');
    if (
      request['kind'] !== BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND &&
      request['kind'] !== FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND
    ) {
      throw new Error('Terraform acceptance pointer observation kind is not registered.');
    }
    const pointerKey = requireString(request['pointerKey'], 'Terraform acceptance pointer key');
    if (pointerKey !== deriveTerraformAcceptancePointerKey(request['kind'], target.targetKey)) {
      throw new Error('Terraform acceptance pointer key is invalid.');
    }
    const observed = await conditionalObjects.readPointerCoordinates({ key: pointerKey });
    return observed === undefined ? null : deepFreeze({ etag: observed.etag, versionId: observed.versionId });
  }

  /** @param {TerraformAcceptanceKind} kind @param {unknown} body */
  async function publishRecord(kind, body) {
    const record = admitRecord(kind, body, target);
    const key = deriveRecordKey(kind, record, target);
    const canonicalBody = canonicalRecordJson(record);
    const result = await conditionalObjects.publishRecord({ key, body: canonicalBody });
    if (result.status === 'created') {
      return deepFreeze({
        status: /** @type {const} */ ('created'),
        kind,
        key,
        record,
        recordObservation: result.observation,
      });
    }
    if (result.status === 'conflict') {
      throw new Error(`Terraform acceptance record ${key} conflicts with different bytes.`);
    }
    return deepFreeze({
      status: /** @type {const} */ ('idempotent-retry'),
      kind,
      key,
      record,
      recordObservation: result.observation,
    });
  }

  /** @param {TerraformAcceptanceKind} kind @param {unknown} keyValue */
  async function readRecord(kind, keyValue) {
    const key = admitTerraformAcceptanceRecordKey(kind, keyValue, target.targetKey);
    const observed = await conditionalObjects.readRecord({ key });
    if (observed === undefined) {
      throw new Error(`Terraform acceptance record ${key} does not exist.`);
    }
    const record = admitRecord(kind, parseCanonicalBody(observed.body, `Terraform acceptance record ${key}`), target);
    if (deriveRecordKey(kind, record, target) !== key) {
      throw new Error(`Terraform acceptance record ${key} does not match its derived key.`);
    }
    return deepFreeze({
      key,
      record,
      recordObservation: deepFreeze({ etag: observed.etag, versionId: observed.versionId }),
    });
  }

  /** @param {unknown} input */
  async function movePointer(input) {
    const request = exactKeys(input, POINTER_MOVE_REQUEST_KEYS, 'Terraform acceptance pointer move');
    let kind;
    if (request['kind'] === BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND) {
      kind = BOOTSTRAP_ACCEPTANCE_KIND;
    } else if (request['kind'] === FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND) {
      kind = FOUNDATION_ACCEPTANCE_KIND;
    } else {
      throw new Error('Terraform acceptance pointer move kind is not registered.');
    }
    const pointerKind = /** @type {TerraformAcceptancePointerKind} */ (request['kind']);
    const expected = admitExpected(request['expected']);
    const pointerKey = deriveTerraformAcceptancePointerKey(pointerKind, target.targetKey);
    if (request['pointerKey'] !== pointerKey) {
      throw new Error('Terraform acceptance pointer move is detached from its selected record.');
    }
    const selected = await readRecord(kind, request['recordKey']);
    const record = selected.record;
    if (
      request['pipelineExecutionId'] !== record.pipelineExecutionId ||
      request['acceptanceAttemptId'] !== record.acceptanceAttemptId
    ) {
      throw new Error('Terraform acceptance pointer move is detached from its selected record.');
    }
    /** @param {TerraformAcceptanceObservation | null} previous */
    const buildPointer = (previous) =>
      admitTerraformAcceptancePointer(
        pointerKind,
        {
          kind: pointerKind,
          targetKey: record.targetKey,
          recordKey: selected.key,
          pipelineExecutionId: record.pipelineExecutionId,
          acceptanceAttemptId: record.acceptanceAttemptId,
          previous,
          compareAndSwapEvidenceId: `cas/${record.targetContext.root.lane}-acceptance/${record.pipelineExecutionId}/${record.acceptanceAttemptId}`,
        },
        target.targetKey,
      );
    /** @param {Readonly<{body: string, etag: string, versionId: string}> | undefined} current */
    const targetRetry = (current) => {
      if (current === undefined) return undefined;
      const currentPointer = tryAdmitTargetPointer(current.body, pointerKind, target);
      if (
        currentPointer === undefined ||
        currentPointer.recordKey !== selected.key ||
        currentPointer.pipelineExecutionId !== record.pipelineExecutionId ||
        currentPointer.acceptanceAttemptId !== record.acceptanceAttemptId ||
        !observationsEqual(currentPointer.previous, expected)
      ) {
        return undefined;
      }
      return deepFreeze({
        status: /** @type {const} */ ('idempotent-retry'),
        pointerKey,
        pointer: currentPointer,
        pointerObservation: deepFreeze({ etag: current.etag, versionId: current.versionId }),
        recordKey: selected.key,
        record,
      });
    };
    const pointer = buildPointer(expected);
    const result = await conditionalObjects.movePointer({
      key: pointerKey,
      body: canonicalRecordJson(pointer),
      expected,
    });
    if (result.status === 'conflict') {
      const retry = targetRetry(result.observed);
      if (retry !== undefined) return retry;
    }
    if (result.status === 'moved') {
      return deepFreeze({
        status: /** @type {const} */ ('moved'),
        pointerKey,
        pointer,
        pointerObservation: result.observation,
        recordKey: selected.key,
        record,
      });
    }
    if (result.status === 'idempotent-retry') {
      return deepFreeze({
        status: /** @type {const} */ ('idempotent-retry'),
        pointerKey,
        pointer,
        pointerObservation: result.observation,
        recordKey: selected.key,
        record,
      });
    }
    return deepFreeze({
      status: /** @type {const} */ ('conflict'),
      pointerKey,
      expected,
      observed: null,
    });
  }

  return deepFreeze({ observePointer, publishRecord, movePointer });
}

/**
 * @param {unknown} value
 * @returns {TerraformAcceptancePublicationLedger}
 */
function admitLedger(value) {
  const ledger = captureExactPortRecord(value, LEDGER_KEYS, 'Terraform acceptance publication ledger');
  return /** @type {TerraformAcceptancePublicationLedger} */ (ledger);
}

/**
 * @param {unknown} kind
 * @param {unknown} pointerKind
 * @returns {{kind: TerraformAcceptanceKind, pointerKind: TerraformAcceptancePointerKind}}
 */
function admitKindPair(kind, pointerKind) {
  if (kind === BOOTSTRAP_ACCEPTANCE_KIND && pointerKind === BOOTSTRAP_CURRENT_ACCEPTANCE_POINTER_KIND) {
    return { kind, pointerKind };
  }
  if (kind === FOUNDATION_ACCEPTANCE_KIND && pointerKind === FOUNDATION_CURRENT_ACCEPTANCE_POINTER_KIND) {
    return { kind, pointerKind };
  }
  throw new Error('Terraform acceptance record and pointer kinds are not a registered pair.');
}

/**
 * @param {TerraformAcceptanceKind} kind
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {TerraformAcceptanceRecord}
 */
function admitRecord(kind, value, target) {
  return kind === FOUNDATION_ACCEPTANCE_KIND
    ? admitTerraformAcceptanceRecord(FOUNDATION_ACCEPTANCE_KIND, value, target.targetKey)
    : admitTerraformAcceptanceRecord(BOOTSTRAP_ACCEPTANCE_KIND, value, target.targetKey);
}

/**
 * @param {TerraformAcceptanceKind} kind
 * @param {TerraformAcceptanceRecord} record
 * @param {AllowedDeploymentTarget} target
 * @returns {string}
 */
function deriveRecordKey(kind, record, target) {
  return kind === FOUNDATION_ACCEPTANCE_KIND
    ? deriveTerraformAcceptanceRecordKey(FOUNDATION_ACCEPTANCE_KIND, record, target.targetKey)
    : deriveTerraformAcceptanceRecordKey(BOOTSTRAP_ACCEPTANCE_KIND, record, target.targetKey);
}

/**
 * @param {unknown} value
 * @returns {{readonly status: 'conflict', readonly value: Record<string, unknown>} | {readonly status: 'result', readonly value: Record<string, unknown>}}
 */
function admitPointerMovementResult(value) {
  try {
    assertProxyFreePortData(value, 'Terraform acceptance pointer movement');
    const record = /** @type {Record<string, unknown>} */ (
      snapshotDataTree(value, 'Terraform acceptance pointer movement')
    );
    if (record['status'] === 'conflict') {
      return Object.freeze({
        status: /** @type {const} */ ('conflict'),
        value: exactKeys(record, POINTER_CONFLICT_KEYS, 'Terraform acceptance pointer conflict'),
      });
    }
    return Object.freeze({
      status: /** @type {const} */ ('result'),
      value: exactKeys(record, POINTER_MOVEMENT_KEYS, 'Terraform acceptance pointer movement'),
    });
  } catch (error) {
    throw new Error('Terraform acceptance pointer movement is invalid.', { cause: error });
  }
}

/**
 * @param {Record<string, unknown>} conflict
 * @param {TerraformAcceptancePointerKind} pointerKind
 * @param {string} pointerKey
 * @param {TerraformAcceptanceObservation | null} expected
 * @param {AllowedDeploymentTarget} target
 */
function admitPointerConflict(conflict, pointerKind, pointerKey, expected, target) {
  try {
    const conflictExpected = admitExpected(conflict['expected']);
    if (conflict['pointerKey'] !== pointerKey || !observationsEqual(conflictExpected, expected)) {
      throw new Error('Terraform acceptance pointer conflict is detached from the reviewed predecessor.');
    }
    if (conflict['observed'] !== null) {
      const observed = exactKeys(conflict['observed'], OBSERVED_POINTER_KEYS, 'Terraform acceptance observed pointer');
      admitTerraformAcceptancePointer(pointerKind, observed['pointer'], target.targetKey);
      admitObservation(observed['pointerObservation'], 'Terraform acceptance observed pointer observation');
    }
  } catch (error) {
    throw new Error('Terraform acceptance pointer movement is invalid.', { cause: error });
  }
}

/**
 * @param {Record<string, unknown>} movement
 * @param {TerraformAcceptanceKind} kind
 * @param {TerraformAcceptancePointerKind} pointerKind
 * @param {TerraformAcceptanceRecord} record
 * @param {string} pointerKey
 * @param {string} recordKey
 * @param {TerraformAcceptanceObservation | null} expected
 * @param {AllowedDeploymentTarget} target
 * @returns {{readonly pointerStatus: 'moved' | 'idempotent-retry', readonly pointerObservation: TerraformAcceptanceObservation}}
 */
function admitSuccessfulPointerMovement(movement, kind, pointerKind, record, pointerKey, recordKey, expected, target) {
  try {
    const pointerStatus = movement['status'];
    const movedRecordKey = admitTerraformAcceptanceRecordKey(kind, movement['recordKey'], target.targetKey);
    const movedRecord = admitRecord(kind, movement['record'], target);
    const movedPointer = admitTerraformAcceptancePointer(pointerKind, movement['pointer'], target.targetKey);
    const pointerObservation = admitObservation(
      movement['pointerObservation'],
      'Terraform acceptance pointer observation',
    );
    const predecessorMatches = observationsEqual(movedPointer.previous, expected);
    if (
      (pointerStatus !== 'moved' && pointerStatus !== 'idempotent-retry') ||
      movement['pointerKey'] !== pointerKey ||
      movedRecordKey !== recordKey ||
      movedPointer.recordKey !== recordKey ||
      movedPointer.pipelineExecutionId !== record.pipelineExecutionId ||
      movedPointer.acceptanceAttemptId !== record.acceptanceAttemptId ||
      !predecessorMatches ||
      canonicalRecordJson(movedRecord) !== canonicalRecordJson(record)
    ) {
      throw new Error('Terraform acceptance pointer movement is detached from its accepted record.');
    }
    return Object.freeze({
      pointerStatus,
      pointerObservation,
    });
  } catch (error) {
    throw new Error('Terraform acceptance pointer movement is invalid.', { cause: error });
  }
}

/**
 * Publish one already-complete Terraform acceptance and move its one root
 * pointer through an injected ledger. This boundary owns no AWS or CAS
 * transport behavior.
 *
 * @param {TerraformAcceptancePublicationInput} input
 * @returns {Promise<TerraformAcceptancePublicationResult>}
 */
export async function publishTerraformAcceptance(input) {
  const request = exactKeys(input, INPUT_KEYS, 'Terraform acceptance publication');
  const target = resolveAllowedDeploymentTarget(
    requireString(request['expectedTargetKey'], 'Terraform acceptance publication expected target'),
  );
  const { kind, pointerKind } = admitKindPair(request['kind'], request['pointerKind']);
  assertProxyFreePortData(request['record'], 'Terraform acceptance publication record');
  const record = admitRecord(kind, request['record'], target);
  const ledger = admitLedger(request['ledger']);
  const publishRecord = ledger.publishRecord;
  const movePointer = ledger.movePointer;
  const expected = admitExpected(request['expected']);
  const pointerKey = deriveTerraformAcceptancePointerKey(pointerKind, target.targetKey);
  if (request['pointerKey'] !== pointerKey) {
    throw new Error('Terraform acceptance pointer key does not match its admitted root.');
  }
  const expectedRecordKey = deriveRecordKey(kind, record, target);

  const recordPublication = await invokeExactPort(
    publishRecord,
    [kind, record],
    'Terraform acceptance record publication port',
    (value) => exactKeys(value, RECORD_PUBLICATION_KEYS, 'Terraform acceptance record publication'),
  );
  const recordStatus = recordPublication['status'];
  const recordKey = admitTerraformAcceptanceRecordKey(kind, recordPublication['key'], target.targetKey);
  assertProxyFreePortData(recordPublication['record'], 'Terraform acceptance published record');
  const publishedRecord = admitRecord(kind, recordPublication['record'], target);
  admitObservation(recordPublication['recordObservation'], 'Terraform acceptance record observation');
  if (
    (recordStatus !== 'created' && recordStatus !== 'idempotent-retry') ||
    recordPublication['kind'] !== kind ||
    recordKey !== expectedRecordKey ||
    canonicalRecordJson(publishedRecord) !== canonicalRecordJson(record)
  ) {
    throw new Error('Terraform acceptance record publication is invalid.');
  }

  const movementResult = await invokeExactPort(
    movePointer,
    [
      deepFreeze({
        kind: pointerKind,
        pointerKey,
        recordKey,
        pipelineExecutionId: record.pipelineExecutionId,
        acceptanceAttemptId: record.acceptanceAttemptId,
        expected,
      }),
    ],
    'Terraform acceptance pointer movement port',
    admitPointerMovementResult,
  );
  if (movementResult.status === 'conflict') {
    admitPointerConflict(movementResult.value, pointerKind, pointerKey, expected, target);
    throw new TerraformAcceptancePointerConflictError();
  }
  const { pointerStatus, pointerObservation } = admitSuccessfulPointerMovement(
    movementResult.value,
    kind,
    pointerKind,
    record,
    pointerKey,
    recordKey,
    expected,
    target,
  );
  return deepFreeze({
    recordStatus: /** @type {'created' | 'idempotent-retry'} */ (recordStatus),
    recordKey,
    pointerStatus: /** @type {'moved' | 'idempotent-retry'} */ (pointerStatus),
    pointerKey,
    pointerObservation,
  });
}

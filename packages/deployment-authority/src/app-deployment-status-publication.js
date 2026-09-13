import { types } from 'node:util';

import { admitAppCurrentAcceptancePointer, bindAppAcceptanceSelection } from './app-acceptance-ledger.js';
import {
  APP_DEPLOYMENT_STATUS_MAX_BYTES,
  canonicalAppDeploymentStatusJson,
  parseCanonicalAppDeploymentStatus,
  projectAppDeploymentStatus,
} from './app-deployment-status.js';
import { snapshotDataTree, snapshotDenseArray, snapshotExactRecord } from './descriptor-snapshot.js';
import { canonicalRecordJson, deepFreeze, parseS3VersionId, requireString } from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

export const APP_DEPLOYMENT_STATUS_MAX_ATTEMPTS = 5;

/** @typedef {ReturnType<typeof resolveAllowedDeploymentTarget>} AllowedDeploymentTarget */
const CLASSIFICATION_INPUT_KEYS = ['resolution', 'statusRead'];
const HISTORY_RESOLUTION_KEYS = ['pointer', 'pointerKey', 'pointerObservation', 'resolutionType', 'selections'];
const BOUND_SELECTION_KEYS = [
  'acceptance',
  'acceptanceKey',
  'acceptanceObservation',
  'pointer',
  'pointerObservation',
  'selectionType',
  'targetKey',
];
const OBSERVATION_KEYS = ['etag', 'versionId'];
const STATUS_READ_KEYS = ['body', 'etag', 'versionId'];
const PUBLICATION_INPUT_KEYS = ['resolveHistory', 'statusStore'];
const STATUS_STORE_KEYS = ['readStatus', 'writeStatus'];
const WRITTEN_RESULT_KEYS = ['etag', 'status', 'versionId'];
const PRECONDITION_RESULT_KEYS = ['status'];

/**
 * @typedef {{readonly etag: string, readonly versionId: string}} AppDeploymentStatusObjectObservation
 * @typedef {{readonly status: Readonly<Record<string, unknown>>, readonly body: string}} ProjectedAppDeploymentStatus
 * @typedef {{
 *   readonly pointerKey: string;
 *   readonly pointer: import('./app-acceptance-ledger.js').AppCurrentAcceptancePointer;
 *   readonly pointerObservation: AppDeploymentStatusObjectObservation;
 *   readonly projectedStatuses: readonly ProjectedAppDeploymentStatus[];
 *   readonly historyIdentity: string;
 * }} AdmittedAppAcceptanceHistory
 * @typedef {{readonly body: string, readonly etag: string, readonly versionId: string}} AppDeploymentStatusRead
 * @typedef {{
 *   readonly resolveHistory: () => unknown | Promise<unknown>;
 *   readonly statusStore: Readonly<{
 *     readStatus: () => unknown | Promise<unknown>;
 *     writeStatus: (input: unknown) => unknown | Promise<unknown>;
 *   }>;
 * }} AppDeploymentStatusPublicationDependencies
 */

/**
 * Reject proxies recursively without invoking their traps. Functions remain
 * opaque capabilities after the proxy check and are captured exactly once.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {Set<object>} [ancestors]
 */
function rejectProxies(value, label, ancestors = new Set()) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return;
  }
  if (types.isProxy(value)) {
    throw new Error(`${label} must not contain a proxy.`);
  }
  if (typeof value === 'function' || ancestors.has(value)) {
    return;
  }
  ancestors.add(value);
  try {
    let keys;
    try {
      keys = Reflect.ownKeys(value);
    } catch (error) {
      throw new Error(`${label} must contain only inspectable data.`, { cause: error });
    }
    for (const key of keys) {
      let descriptor;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      } catch (error) {
        throw new Error(`${label} must contain only inspectable data.`, { cause: error });
      }
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        rejectProxies(descriptor.value, label, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** @param {unknown} value @param {string} label */
function rejectDirectProxy(value, label) {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null && types.isProxy(value)) {
    throw new Error(`${label} must not be a proxy.`);
  }
}

/**
 * Exact-admit synchronous values before they cross an async return boundary.
 * Exact native promises settle directly so neither an own `then` property on
 * the promise nor a newly added one on its fulfillment value is observed.
 *
 * @template T
 * @param {unknown} value
 * @param {string} label
 * @param {(settled: unknown) => T} admit
 * @returns {Promise<T>}
 */
async function admitPortResult(value, label, admit) {
  rejectDirectProxy(value, label);
  if (!types.isPromise(value)) {
    return admit(value);
  }
  let prototype;
  let constructorDescriptor;
  try {
    prototype = Reflect.getPrototypeOf(value);
    constructorDescriptor = Reflect.getOwnPropertyDescriptor(value, 'constructor');
  } catch (error) {
    throw new Error(`${label} promise must be inspectable.`, { cause: error });
  }
  if (prototype !== Promise.prototype || constructorDescriptor !== undefined) {
    throw new Error(`${label} promise must use the exact native promise shape.`);
  }
  const settled = await value;
  return admit(settled);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {string} label
 */
function exactData(value, keys, label) {
  rejectProxies(value, label);
  return snapshotExactRecord(snapshotDataTree(value, label), keys, label);
}

/** @param {unknown} value @param {string} label */
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
 * @returns {AppDeploymentStatusObjectObservation}
 */
function admitObservation(value, label) {
  const observation = exactData(value, OBSERVATION_KEYS, label);
  return deepFreeze({
    etag: opaqueEtag(observation['etag'], `${label} ETag`),
    versionId: parseS3VersionId(observation['versionId'], `${label} VersionId`),
  });
}

/**
 * @param {AppDeploymentStatusObjectObservation} left
 * @param {AppDeploymentStatusObjectObservation} right
 */
function observationsEqual(left, right) {
  return left.etag === right.etag && left.versionId === right.versionId;
}

/**
 * Re-admit and rebind the complete bounded acceptance history before using
 * any status projection. The first selection is the only publication target;
 * retained selections are comparison authority for an existing status body.
 *
 * @param {unknown} value
 * @param {AllowedDeploymentTarget} target
 * @returns {AdmittedAppAcceptanceHistory}
 */
function admitAcceptanceHistory(value, target) {
  const pointerKey = resolveDeploymentLaneAuthority(target, 'app').names.acceptedDeploymentPointerKey;
  const resolution = exactData(value, HISTORY_RESOLUTION_KEYS, 'App acceptance-history resolution');
  if (resolution['resolutionType'] !== 'app-acceptance-history' || resolution['pointerKey'] !== pointerKey) {
    throw new Error('App acceptance-history resolution is detached from the current pointer.');
  }
  const pointer = admitAppCurrentAcceptancePointer(resolution['pointer'], target.targetKey);
  const pointerObservation = admitObservation(
    resolution['pointerObservation'],
    'App acceptance-history pointer observation',
  );
  const selections = snapshotDenseArray(resolution['selections'], 'App acceptance-history selections');
  if (selections.length !== pointer.history.length) {
    throw new Error('App acceptance-history selections do not match the complete pointer history.');
  }

  /** @type {Readonly<Record<string, unknown>>[]} */
  const reboundSelections = [];
  const projectedStatuses = selections.map((value, index) => {
    const selection = snapshotExactRecord(value, BOUND_SELECTION_KEYS, `App acceptance-history selection ${index}`);
    const rebound = bindAppAcceptanceSelection(
      {
        pointer: selection['pointer'],
        pointerObservation: selection['pointerObservation'],
        recordKey: selection['acceptanceKey'],
        record: selection['acceptance'],
        recordObservation: selection['acceptanceObservation'],
      },
      target.targetKey,
    );
    const expectedSelectionType = index === 0 ? 'current' : 'retained';
    if (
      pointer.history[index] !== rebound.acceptanceKey ||
      rebound.selectionType !== expectedSelectionType ||
      rebound.targetKey !== target.targetKey ||
      canonicalRecordJson(rebound.pointer) !== canonicalRecordJson(pointer) ||
      !observationsEqual(rebound.pointerObservation, pointerObservation) ||
      canonicalRecordJson(rebound) !== canonicalRecordJson(selection)
    ) {
      throw new Error('App acceptance-history selection is detached from its pointer position.');
    }
    reboundSelections.push(rebound);
    const status = projectAppDeploymentStatus(rebound, target.targetKey);
    return deepFreeze({ status, body: canonicalAppDeploymentStatusJson(status, target.targetKey) });
  });
  if (projectedStatuses.length === 0) {
    throw new Error('App acceptance-history resolution has no current selection.');
  }
  const historyIdentity = canonicalRecordJson({
    pointerKey,
    pointer,
    pointerObservation,
    selections: reboundSelections,
  });
  return deepFreeze({
    pointerKey,
    pointer,
    pointerObservation,
    projectedStatuses,
    historyIdentity,
  });
}

/**
 * @param {unknown} value
 * @returns {AppDeploymentStatusRead | undefined}
 */
function admitStatusRead(value) {
  if (value === undefined) {
    return undefined;
  }
  const read = exactData(value, STATUS_READ_KEYS, 'App deployment status read');
  if (
    typeof read['body'] !== 'string' ||
    read['body'].length === 0 ||
    Buffer.byteLength(read['body'], 'utf8') > APP_DEPLOYMENT_STATUS_MAX_BYTES
  ) {
    throw new Error('App deployment status read body is invalid.');
  }
  const observation = admitObservation(
    { etag: read['etag'], versionId: read['versionId'] },
    'App deployment status read observation',
  );
  return deepFreeze({ body: read['body'], ...observation });
}

/**
 * @param {AdmittedAppAcceptanceHistory} history
 * @param {AppDeploymentStatusRead | undefined} statusRead
 * @param {AllowedDeploymentTarget} target
 */
function classifyAdmittedStatus(history, statusRead, target) {
  const current = history.projectedStatuses[0];
  if (current === undefined) {
    throw new Error('App acceptance-history resolution has no current selection.');
  }
  if (statusRead === undefined) {
    return deepFreeze({
      disposition: /** @type {const} */ ('create'),
      status: current.status,
      body: current.body,
      condition: { type: /** @type {const} */ ('if-none-match') },
    });
  }
  const statusObservation = deepFreeze({ etag: statusRead.etag, versionId: statusRead.versionId });
  if (statusRead.body === current.body) {
    return deepFreeze({
      disposition: /** @type {const} */ ('current'),
      status: current.status,
      body: current.body,
      statusObservation,
    });
  }
  try {
    parseCanonicalAppDeploymentStatus(statusRead.body, target.targetKey);
  } catch (error) {
    throw new Error('Existing App deployment status is an authority contradiction.', { cause: error });
  }
  if (history.projectedStatuses.slice(1).some((candidate) => candidate.body === statusRead.body)) {
    return deepFreeze({
      disposition: /** @type {const} */ ('update'),
      status: current.status,
      body: current.body,
      condition: {
        type: /** @type {const} */ ('if-match'),
        etag: statusRead.etag,
        versionId: statusRead.versionId,
      },
    });
  }
  throw new Error('Existing App deployment status is an authority contradiction.');
}

/**
 * Classify one exact status observation against the currently resolved,
 * fully bound acceptance history. This function performs no I/O.
 *
 * @param {unknown} input
 * @param {unknown} expectedTargetKey
 */
export function classifyAppDeploymentStatusPublication(input, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App deployment status expected target'),
  );
  rejectProxies(input, 'App deployment status classification');
  const request = snapshotExactRecord(input, CLASSIFICATION_INPUT_KEYS, 'App deployment status classification');
  const history = admitAcceptanceHistory(request['resolution'], target);
  const statusRead = admitStatusRead(request['statusRead']);
  return classifyAdmittedStatus(history, statusRead, target);
}

/**
 * @param {unknown} input
 * @returns {AppDeploymentStatusPublicationDependencies}
 */
function admitPublicationDependencies(input) {
  rejectProxies(input, 'App deployment status publication dependencies');
  const request = snapshotExactRecord(input, PUBLICATION_INPUT_KEYS, 'App deployment status publication dependencies');
  const statusStore = snapshotExactRecord(request['statusStore'], STATUS_STORE_KEYS, 'App deployment status store');
  const resolveHistory = request['resolveHistory'];
  const readStatus = statusStore['readStatus'];
  const writeStatus = statusStore['writeStatus'];
  if (typeof resolveHistory !== 'function' || typeof readStatus !== 'function' || typeof writeStatus !== 'function') {
    throw new Error('App deployment status publication dependencies are invalid.');
  }
  return Object.freeze({
    resolveHistory: /** @type {() => unknown | Promise<unknown>} */ (resolveHistory),
    statusStore: Object.freeze({
      readStatus: /** @type {() => unknown | Promise<unknown>} */ (readStatus),
      writeStatus: /** @type {(input: unknown) => unknown | Promise<unknown>} */ (writeStatus),
    }),
  });
}

/** @param {unknown} value */
function admitWriteResult(value) {
  rejectProxies(value, 'App deployment status write result');
  const snapshot = snapshotDataTree(value, 'App deployment status write result');
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    !Array.isArray(snapshot) &&
    /** @type {Readonly<Record<string, unknown>>} */ (snapshot)['status'] === 'precondition-failed'
  ) {
    snapshotExactRecord(snapshot, PRECONDITION_RESULT_KEYS, 'App deployment status precondition result');
    return deepFreeze({ status: /** @type {const} */ ('precondition-failed') });
  }
  const result = snapshotExactRecord(snapshot, WRITTEN_RESULT_KEYS, 'App deployment status written result');
  if (result['status'] !== 'written') {
    throw new Error('App deployment status write result is invalid.');
  }
  const observation = admitObservation(
    { etag: result['etag'], versionId: result['versionId'] },
    'App deployment status written observation',
  );
  return deepFreeze({ status: /** @type {const} */ ('written'), ...observation });
}

/**
 * @param {AdmittedAppAcceptanceHistory} left
 * @param {AdmittedAppAcceptanceHistory} right
 */
function samePointerAuthority(left, right) {
  return (
    left.pointerKey === right.pointerKey &&
    canonicalRecordJson(left.pointer) === canonicalRecordJson(right.pointer) &&
    observationsEqual(left.pointerObservation, right.pointerObservation) &&
    left.historyIdentity === right.historyIdentity
  );
}

/**
 * Publish the canonical display projection selected by current App acceptance
 * authority. Every attempt first tries the only safe missing-object operation;
 * status observation is permitted only after that conditional create loses.
 * Repeated full-history observations make every invocation converge on the
 * current head without accepting unrelated bytes.
 *
 * @param {unknown} input
 * @param {unknown} expectedTargetKey
 */
export async function publishCurrentAppDeploymentStatus(input, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App deployment status expected target'),
  );
  const dependencies = admitPublicationDependencies(input);
  const resolveHistory = dependencies.resolveHistory;
  const statusStore = dependencies.statusStore;
  const readStatus = statusStore.readStatus;
  const writeStatus = statusStore.writeStatus;

  async function resolveCurrentHistory() {
    return admitPortResult(
      Reflect.apply(resolveHistory, dependencies, []),
      'App acceptance-history resolution',
      (value) => admitAcceptanceHistory(value, target),
    );
  }

  async function readCurrentStatus() {
    return admitPortResult(Reflect.apply(readStatus, statusStore, []), 'App deployment status read', admitStatusRead);
  }

  for (let attempt = 0; attempt < APP_DEPLOYMENT_STATUS_MAX_ATTEMPTS; attempt += 1) {
    const beforeCreate = await resolveCurrentHistory();
    const current = beforeCreate.projectedStatuses[0];
    if (current === undefined) {
      throw new Error('App acceptance-history resolution has no current selection.');
    }
    const pendingCreate = Reflect.apply(writeStatus, statusStore, [
      deepFreeze({ body: current.body, condition: { type: /** @type {const} */ ('if-none-match') } }),
    ]);
    const createResult = await admitPortResult(pendingCreate, 'App deployment status write result', admitWriteResult);
    if (createResult.status === 'written') {
      const afterCreate = await resolveCurrentHistory();
      if (!samePointerAuthority(beforeCreate, afterCreate)) {
        continue;
      }
      return deepFreeze({
        disposition: /** @type {const} */ ('created'),
        status: current.status,
        statusObservation: deepFreeze({ etag: createResult.etag, versionId: createResult.versionId }),
      });
    }

    const statusRead = await readCurrentStatus();
    const beforeDecision = await resolveCurrentHistory();
    if (!samePointerAuthority(beforeCreate, beforeDecision)) {
      continue;
    }

    const classification = classifyAdmittedStatus(beforeDecision, statusRead, target);
    if (classification.disposition === 'create') {
      continue;
    }
    if (classification.disposition === 'current') {
      const afterDecision = await resolveCurrentHistory();
      if (!samePointerAuthority(beforeDecision, afterDecision)) {
        continue;
      }
      return deepFreeze({
        disposition: /** @type {const} */ ('already-current'),
        status: classification.status,
        statusObservation: classification.statusObservation,
      });
    }

    const pendingUpdate = Reflect.apply(writeStatus, statusStore, [
      deepFreeze({ body: classification.body, condition: classification.condition }),
    ]);
    const result = await admitPortResult(pendingUpdate, 'App deployment status write result', admitWriteResult);
    if (result.status === 'precondition-failed') {
      continue;
    }
    const afterWrite = await resolveCurrentHistory();
    if (!samePointerAuthority(beforeDecision, afterWrite)) {
      continue;
    }
    return deepFreeze({
      disposition: /** @type {const} */ ('updated'),
      status: classification.status,
      statusObservation: deepFreeze({ etag: result.etag, versionId: result.versionId }),
    });
  }
  throw new Error('App deployment status publication did not converge within five attempts.');
}

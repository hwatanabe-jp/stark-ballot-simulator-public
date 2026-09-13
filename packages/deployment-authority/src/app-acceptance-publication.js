import {
  APP_ACCEPTANCE_KIND,
  APP_CURRENT_ACCEPTANCE_POINTER_KIND,
  admitAppAcceptance,
  admitAppAcceptanceRecordKey,
  admitAppCurrentAcceptancePointer,
  admitRetainedAppAcceptance,
  deriveAppAcceptanceRecordKey,
  projectAppAcceptancePointerTransition,
  projectAppAcceptanceGenesisPointer,
} from './app-acceptance-ledger.js';
import {
  assertProxyFreePortData,
  assertUnproxiedPortShell,
  createConditionalObjectLedger,
} from './conditional-object-ledger.js';
import { snapshotExactRecord } from './descriptor-snapshot.js';
import { canonicalRecordJson, deepFreeze, parseS3VersionId, requireString } from './internal.js';
import { resolveAllowedDeploymentTarget, resolveDeploymentLaneAuthority } from './index.js';

const POINTER_MOVE_KEYS = ['currentPointer', 'expected', 'kind', 'pointer', 'pointerKey'];

/** @param {unknown} value @param {readonly string[]} keys @param {string} label */
function exactKeys(value, keys, label) {
  assertUnproxiedPortShell(value, label);
  try {
    return /** @type {Readonly<Record<string, unknown>>} */ (snapshotExactRecord(value, keys, label));
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/** @param {unknown} value @param {string} label */
function opaqueEtag(value, label) {
  const etag = requireString(value, label);
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} is invalid.`);
  }
  return etag;
}

/** @param {unknown} value @param {string} label */
function admitObservation(value, label) {
  const observation = exactKeys(value, ['etag', 'versionId'], label);
  return deepFreeze({
    etag: opaqueEtag(observation['etag'], `${label} ETag`),
    versionId: parseS3VersionId(observation['versionId'], `${label} VersionId`),
  });
}

/** @param {unknown} value @param {string} label */
function parseCanonicalBody(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must use canonical JSON bytes.`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must use canonical JSON bytes.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || canonicalRecordJson(parsed) !== value) {
    throw new Error(`${label} must use canonical JSON bytes.`);
  }
  return parsed;
}

/** @param {unknown} value */
function admitKind(value) {
  if (value !== APP_ACCEPTANCE_KIND) throw new Error('App acceptance record kind is not registered.');
  return APP_ACCEPTANCE_KIND;
}

/** @param {unknown} value */
function admitPointerKind(value) {
  if (value !== APP_CURRENT_ACCEPTANCE_POINTER_KIND) {
    throw new Error('App acceptance pointer kind is not registered.');
  }
  return APP_CURRENT_ACCEPTANCE_POINTER_KIND;
}

/** @param {unknown} value @param {import('./index.js').AllowedDeploymentTarget} target */
function admitPointerKey(value, target) {
  const currentPointerKey = resolveDeploymentLaneAuthority(target, 'app').names.acceptedDeploymentPointerKey;
  if (value !== currentPointerKey) throw new Error('App acceptance pointer key is not registered.');
  return currentPointerKey;
}

/**
 * Create the sole permanent App-acceptance ledger over the shared conditional
 * object engine. It admits only the target pointer and record shapes. Pointer
 * transitions require existing accepted history. Explicit production genesis
 * uses the same current key and conditional engine with first-create only.
 *
 * @param {unknown} transport
 * @param {unknown} expectedTargetKey
 */
export function createAppAcceptanceLedger(transport, expectedTargetKey) {
  const target = resolveAllowedDeploymentTarget(
    requireString(expectedTargetKey, 'App acceptance ledger expected target'),
  );
  const conditionalObjects = createConditionalObjectLedger({
    byteLimits: { pointerMaxBytes: 64 * 1024, recordMaxBytes: 8 * 1024 * 1024 },
    coordinateObject: null,
    transport,
  });

  /** @param {unknown} kindValue @param {unknown} value */
  async function preflightRecordPublication(kindValue, value) {
    const kind = admitKind(kindValue);
    assertProxyFreePortData(value, 'App acceptance publication record');
    const record = admitRetainedAppAcceptance(value, target.targetKey);
    return deepFreeze({ kind, key: deriveAppAcceptanceRecordKey(record, target.targetKey), record });
  }

  /** @param {unknown} kindValue @param {unknown} value */
  async function publishRecord(kindValue, value) {
    const preflight = await preflightRecordPublication(kindValue, value);
    const body = canonicalRecordJson(preflight.record);
    const result = await conditionalObjects.publishRecord({ key: preflight.key, body });
    if (result.status === 'conflict') {
      throw new Error(`App acceptance record ${preflight.key} conflicts with different bytes.`);
    }
    return deepFreeze({
      status: /** @type {'created' | 'idempotent-retry'} */ (result.status),
      ...preflight,
      recordObservation: result.observation,
    });
  }

  /** @param {unknown} keyValue */
  async function readRecord(keyValue) {
    const key = admitAppAcceptanceRecordKey(keyValue, target.targetKey);
    const observed = await conditionalObjects.readRecord({ key });
    if (observed === undefined) throw new Error(`App acceptance record ${key} does not exist.`);
    const record = admitRetainedAppAcceptance(
      parseCanonicalBody(observed.body, `App acceptance record ${key}`),
      target.targetKey,
    );
    if (deriveAppAcceptanceRecordKey(record, target.targetKey) !== key) {
      throw new Error(`App acceptance record ${key} does not match its derived key.`);
    }
    return deepFreeze({
      recordKey: key,
      record,
      recordObservation: deepFreeze({ etag: observed.etag, versionId: observed.versionId }),
    });
  }

  /** @param {unknown} pointerKeyValue */
  async function resolveCurrentHistory(pointerKeyValue) {
    const pointerKey = admitPointerKey(pointerKeyValue, target);
    const observed = await conditionalObjects.readPointer({ key: pointerKey });
    if (observed === undefined) throw new Error('App current acceptance pointer does not exist.');
    const pointer = admitAppCurrentAcceptancePointer(
      parseCanonicalBody(observed.body, 'App current acceptance pointer'),
      target.targetKey,
    );
    const records = [];
    for (const key of pointer.history) {
      const resolved = await readRecord(key);
      if (key === pointer.headKey) admitAppAcceptance(resolved.record, target.targetKey);
      records.push(resolved);
    }
    return deepFreeze({
      pointerKey,
      pointer,
      pointerObservation: deepFreeze({ etag: observed.etag, versionId: observed.versionId }),
      records: deepFreeze(records),
    });
  }

  /** @param {unknown} input */
  async function movePointer(input) {
    const request = exactKeys(input, POINTER_MOVE_KEYS, 'App acceptance pointer movement');
    admitPointerKind(request['kind']);
    const pointerKey = admitPointerKey(request['pointerKey'], target);
    assertProxyFreePortData(request['currentPointer'], 'App acceptance current pointer');
    assertProxyFreePortData(request['pointer'], 'App acceptance proposed pointer');
    if (request['currentPointer'] === null || request['expected'] === null) {
      if (request['currentPointer'] !== null || request['expected'] !== null || target.environmentId !== 'main') {
        throw new Error('App genesis requires explicit null current authority and observation for production.');
      }
      const pointer = admitAppCurrentAcceptancePointer(request['pointer'], target.targetKey);
      const proposedHead = await readRecord(pointer.headKey);
      const proposed = projectAppAcceptanceGenesisPointer(proposedHead.record, target.targetKey);
      if (canonicalRecordJson(pointer) !== canonicalRecordJson(proposed)) {
        throw new Error('App genesis pointer does not match its complete initial acceptance.');
      }
      const result = await conditionalObjects.movePointer({
        key: pointerKey,
        body: canonicalRecordJson(pointer),
        expected: null,
      });
      if (result.status === 'moved' || result.status === 'idempotent-retry') {
        return deepFreeze({ status: result.status, pointerKey, pointer, pointerObservation: result.observation });
      }
      const observed =
        result.observed === undefined
          ? null
          : deepFreeze({
              pointer: admitAppCurrentAcceptancePointer(
                parseCanonicalBody(result.observed.body, 'Conflicting App current acceptance pointer'),
                target.targetKey,
              ),
              pointerObservation: { etag: result.observed.etag, versionId: result.observed.versionId },
            });
      return deepFreeze({ status: /** @type {const} */ ('conflict'), pointerKey, expected: null, observed });
    }
    const currentPointer = admitAppCurrentAcceptancePointer(request['currentPointer'], target.targetKey);
    const pointer = admitAppCurrentAcceptancePointer(request['pointer'], target.targetKey);
    const expected = admitObservation(request['expected'], 'App acceptance expected pointer');
    const proposed = projectAppAcceptancePointerTransition(
      {
        currentPointer,
        currentPointerObservation: expected,
        nextRecordKey: pointer.headKey,
      },
      target.targetKey,
    );
    if (canonicalRecordJson(proposed) !== canonicalRecordJson(pointer)) {
      throw new Error('App acceptance pointer movement is not the exact next transition.');
    }
    const currentHead = await readRecord(currentPointer.headKey);
    admitAppAcceptance(currentHead.record, target.targetKey);
    const proposedHead = await readRecord(pointer.headKey);
    admitAppAcceptance(proposedHead.record, target.targetKey);

    const observedCurrent = await conditionalObjects.readPointer({ key: pointerKey });
    if (observedCurrent === undefined) {
      return deepFreeze({ status: /** @type {const} */ ('conflict'), pointerKey, expected, observed: null });
    }
    const observedPointer = admitAppCurrentAcceptancePointer(
      parseCanonicalBody(observedCurrent.body, 'Observed App current acceptance pointer'),
      target.targetKey,
    );
    const observedPointerObservation = admitObservation(
      { etag: observedCurrent.etag, versionId: observedCurrent.versionId },
      'Observed App current acceptance pointer',
    );
    if (canonicalRecordJson(observedPointer) === canonicalRecordJson(pointer)) {
      return deepFreeze({
        status: /** @type {const} */ ('idempotent-retry'),
        pointerKey,
        pointer,
        pointerObservation: observedPointerObservation,
      });
    }
    if (
      observedPointerObservation.etag !== expected.etag ||
      observedPointerObservation.versionId !== expected.versionId ||
      canonicalRecordJson(observedPointer) !== canonicalRecordJson(currentPointer)
    ) {
      return deepFreeze({
        status: /** @type {const} */ ('conflict'),
        pointerKey,
        expected,
        observed: deepFreeze({ pointer: observedPointer, pointerObservation: observedPointerObservation }),
      });
    }

    const result = await conditionalObjects.movePointer({
      key: pointerKey,
      body: canonicalRecordJson(pointer),
      expected,
    });
    if (result.status === 'moved' || result.status === 'idempotent-retry') {
      return deepFreeze({ status: result.status, pointerKey, pointer, pointerObservation: result.observation });
    }
    if (result.observed === undefined) {
      return deepFreeze({ status: /** @type {const} */ ('conflict'), pointerKey, expected, observed: null });
    }
    const conflictPointer = admitAppCurrentAcceptancePointer(
      parseCanonicalBody(result.observed.body, 'Conflicting App current acceptance pointer'),
      target.targetKey,
    );
    return deepFreeze({
      status: /** @type {const} */ ('conflict'),
      pointerKey,
      expected,
      observed: deepFreeze({
        pointer: conflictPointer,
        pointerObservation: deepFreeze({ etag: result.observed.etag, versionId: result.observed.versionId }),
      }),
    });
  }

  return deepFreeze({ movePointer, preflightRecordPublication, publishRecord, readRecord, resolveCurrentHistory });
}

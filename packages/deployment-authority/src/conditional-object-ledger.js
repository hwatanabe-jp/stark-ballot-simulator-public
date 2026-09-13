import { types as utilTypes } from 'node:util';
import { snapshotExactRecord } from './descriptor-snapshot.js';
import { parseS3VersionId, requireString } from './internal.js';

/**
 * @typedef {{readonly etag: string, readonly versionId: string}} ObjectCoordinates
 * @typedef {ObjectCoordinates & {readonly body: string}} ObjectObservation
 * @typedef {{
 *   readonly getObject: (input: {readonly key: string, readonly maxBytes: number}) => unknown;
 *   readonly putObject: (input: {readonly key: string, readonly body: string, readonly condition: unknown}) => unknown;
 * }} ConditionalObjectTransport
 */

const INERT_PORT_RECEIVER = Object.freeze(Object.create(null));
const INPUT_KEYS = ['byteLimits', 'coordinateObject', 'transport'];
const BYTE_LIMIT_KEYS = ['pointerMaxBytes', 'recordMaxBytes'];
const TRANSPORT_KEYS = ['getObject', 'putObject'];
const RECORD_REQUEST_KEYS = ['body', 'key'];
const READ_REQUEST_KEYS = ['key'];
const POINTER_REQUEST_KEYS = ['body', 'expected', 'key'];
const OBJECT_KEYS = ['body', 'etag', 'versionId'];
const PUT_PRECONDITION_KEYS = ['status'];
const PUT_WRITTEN_KEYS = ['etag', 'status', 'versionId'];
const MAX_PORT_DATA_NODES = 65_536;
const MAX_PORT_DATA_DEPTH = 256;

/** @param {unknown} value @param {string} label */
function rejectProxy(value, label) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  /** @type {object | null} */
  let current = value;
  while (current !== null) {
    if (utilTypes.isProxy(current)) {
      throw new Error(
        current === value ? `${label} must not be a proxy.` : `${label} must not use a proxied prototype.`,
      );
    }
    current = Reflect.getPrototypeOf(current);
  }
}

/**
 * Reject direct, nested, and prototype proxies before descriptor-based data
 * admission can execute any proxy trap. This is opt-in so established domain
 * snapshot behavior remains unchanged outside new injected authority ports.
 *
 * @param {unknown} value
 * @param {string} label
 */
export function assertProxyFreePortData(value, label) {
  const pending = [{ depth: 0, value }];
  const observed = new Set();
  let nodeCount = 0;
  let propertyCount = 0;
  while (pending.length > 0) {
    const pendingValue = pending.pop();
    if (pendingValue === undefined) continue;
    const { depth, value: current } = pendingValue;
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null) continue;
    rejectProxy(current, label);
    if (typeof current === 'function' || observed.has(current)) continue;
    if (utilTypes.isArrayBufferView(current)) {
      throw new Error(`${label} must not contain a byte view.`);
    }
    if (depth > MAX_PORT_DATA_DEPTH) throw new Error(`${label} is too deep.`);
    observed.add(current);
    nodeCount += 1;
    if (nodeCount > MAX_PORT_DATA_NODES) throw new Error(`${label} is too large.`);
    if (Array.isArray(current)) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(current, 'length');
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, 'value') ||
        typeof lengthDescriptor.value !== 'number' ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value >= MAX_PORT_DATA_NODES
      ) {
        throw new Error(`${label} is too large.`);
      }
    }
    const keys = Reflect.ownKeys(current);
    propertyCount += keys.length;
    if (propertyCount > MAX_PORT_DATA_NODES) throw new Error(`${label} is too large.`);
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        pending.push({ depth: depth + 1, value: descriptor.value });
      }
    }
  }
}

/** @param {unknown} value @param {string} label */
export function assertUnproxiedPortShell(value, label) {
  rejectProxy(value, label);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {string} label
 * @returns {Readonly<Record<string, unknown>>}
 */
function exactRecord(value, keys, label) {
  rejectProxy(value, label);
  try {
    return snapshotExactRecord(value, keys, label);
  } catch (error) {
    throw new Error(`${label} must use the exact current shape.`, { cause: error });
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {(...args: unknown[]) => unknown}
 */
function exactFunction(value, label) {
  rejectProxy(value, label);
  if (typeof value !== 'function') throw new Error(`${label} must be a function.`);
  return /** @type {(...args: unknown[]) => unknown} */ (value);
}

/** @param {Readonly<Record<string, unknown>>} fields @returns {Readonly<Record<string, unknown>>} */
function inertRecord(fields) {
  const record = Object.create(null);
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(record, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  return Object.freeze(record);
}

/** @param {unknown} value @param {string} label @returns {string} */
function opaqueEtag(value, label) {
  const etag = requireString(value, label);
  if (etag.trim() !== etag || /\s/u.test(etag) || Buffer.byteLength(etag, 'utf8') > 1024) {
    throw new Error(`${label} is invalid.`);
  }
  return etag;
}

/** @param {unknown} value @param {string} label @returns {ObjectCoordinates} */
function observation(value, label) {
  const record = exactRecord(value, ['etag', 'versionId'], label);
  return Object.freeze({
    etag: opaqueEtag(record['etag'], `${label} ETag`),
    versionId: parseS3VersionId(record['versionId'], `${label} VersionId`),
  });
}

/**
 * @param {unknown} value
 * @param {number} maximumBytes
 * @param {string} label
 * @returns {ObjectObservation}
 */
function objectObservation(value, maximumBytes, label) {
  const record = exactRecord(value, OBJECT_KEYS, label);
  if (
    typeof record['body'] !== 'string' ||
    Buffer.byteLength(record['body'], 'utf8') === 0 ||
    Buffer.byteLength(record['body'], 'utf8') > maximumBytes
  ) {
    throw new Error(`${label} body is empty or oversized.`);
  }
  return Object.freeze({
    body: record['body'],
    ...observation({ etag: record['etag'], versionId: record['versionId'] }, label),
  });
}

/**
 * @param {unknown} value
 * @returns {Readonly<{status: 'precondition-failed'} | ({status: 'written'} & ObjectCoordinates)>}
 */
function putResult(value) {
  const statusDescriptor =
    typeof value === 'object' && value !== null && !utilTypes.isProxy(value)
      ? Reflect.getOwnPropertyDescriptor(value, 'status')
      : undefined;
  if (
    statusDescriptor !== undefined &&
    Object.hasOwn(statusDescriptor, 'value') &&
    statusDescriptor.value === 'precondition-failed'
  ) {
    exactRecord(value, PUT_PRECONDITION_KEYS, 'Conditional object put precondition result');
    return Object.freeze({ status: 'precondition-failed' });
  }
  const result = exactRecord(value, PUT_WRITTEN_KEYS, 'Conditional object put result');
  if (result['status'] !== 'written') throw new Error('Conditional object put status is invalid.');
  return Object.freeze({
    status: 'written',
    ...observation({ etag: result['etag'], versionId: result['versionId'] }, 'Conditional object write'),
  });
}

/**
 * @template T
 * @param {Promise<unknown>} promise
 * @param {(value: unknown) => T} admit
 * @returns {Promise<T>}
 */
async function settleNativePromise(promise, admit) {
  return admit(await promise);
}

/**
 * @template T
 * @param {unknown} value
 * @param {string} label
 * @param {(value: unknown) => T} admit
 * @returns {Promise<T>}
 */
function settlePortResult(value, label, admit) {
  rejectProxy(value, label);
  if (!utilTypes.isPromise(value)) return Promise.resolve(admit(value));
  if (Reflect.getPrototypeOf(value) !== Promise.prototype || Reflect.ownKeys(value).length !== 0) {
    throw new Error(`${label} promise shell is not admitted.`);
  }
  return settleNativePromise(value, admit);
}

/**
 * Capture one exact injected port record without invoking accessors or proxy
 * traps, and reject proxied functions before they can receive authority.
 *
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @param {string} label
 */
export function captureExactPortRecord(value, keys, label) {
  const record = exactRecord(value, keys, label);
  /** @type {Record<string, unknown>} */
  const ports = {};
  for (const portKey of keys) {
    ports[portKey] = exactFunction(record[portKey], `${label} ${portKey}`);
  }
  return Object.freeze(ports);
}

/**
 * Invoke one captured port with no sibling-capability receiver and settle only
 * an exact native Promise shell or a synchronously admitted result.
 *
 * @template T
 * @param {unknown} port
 * @param {readonly unknown[]} args
 * @param {string} label
 * @param {(value: unknown) => T} admit
 * @returns {Promise<T>}
 */
export function invokeExactPort(port, args, label, admit) {
  const result = Reflect.apply(exactFunction(port, label), INERT_PORT_RECEIVER, [...args]);
  return settlePortResult(result, `${label} result`, admit);
}

/** @param {unknown} value @param {string} label @returns {string} */
function key(value, label) {
  const admitted = requireString(value, label);
  if (Buffer.byteLength(admitted, 'utf8') > 1024 || admitted.startsWith('/') || admitted.includes('..')) {
    throw new Error(`${label} is invalid.`);
  }
  return admitted;
}

/** @param {unknown} value @param {number} maximumBytes @param {string} label @returns {string} */
function boundedBody(value, maximumBytes, label) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new Error(`${label} is empty or oversized.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {number} */
function byteLimit(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 8 * 1024 * 1024) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/**
 * The sole raw conditional object publication boundary. Domain owners retain
 * record and pointer admission; this core owns bounded observation, exact-byte
 * create retries, and compare-and-swap transport behavior.
 */
/** @param {unknown} input */
export function createConditionalObjectLedger(input) {
  const request = exactRecord(input, INPUT_KEYS, 'Conditional object ledger input');
  const byteLimits = exactRecord(request['byteLimits'], BYTE_LIMIT_KEYS, 'Conditional object ledger byte limits');
  const recordMaxBytes = byteLimit(byteLimits['recordMaxBytes'], 'Conditional object record byte limit');
  const pointerMaxBytes = byteLimit(byteLimits['pointerMaxBytes'], 'Conditional object pointer byte limit');
  const transport = captureExactPortRecord(request['transport'], TRANSPORT_KEYS, 'Conditional object ledger transport');
  const coordinateObject =
    request['coordinateObject'] === null
      ? null
      : exactFunction(request['coordinateObject'], 'Conditional object coordinate port');
  const getObject = transport['getObject'];
  const putObject = transport['putObject'];

  /**
   * @param {string} admittedKey
   * @param {number} maximumBytes
   * @param {string} label
   * @returns {Promise<ObjectObservation | undefined>}
   */
  async function observe(admittedKey, maximumBytes, label) {
    return invokeExactPort(
      getObject,
      [inertRecord({ key: admittedKey, maxBytes: maximumBytes })],
      label,
      /** @returns {ObjectObservation | undefined} */ (value) =>
        value === undefined ? undefined : objectObservation(value, maximumBytes, label),
    );
  }

  /** @param {unknown} value */
  async function publishRecord(value) {
    const publication = exactRecord(value, RECORD_REQUEST_KEYS, 'Conditional object record publication');
    const admittedKey = key(publication['key'], 'Conditional object record key');
    const body = boundedBody(publication['body'], recordMaxBytes, 'Conditional object record body');
    const result = await invokeExactPort(
      putObject,
      [inertRecord({ key: admittedKey, body, condition: inertRecord({ type: 'if-none-match' }) })],
      'Conditional object record put',
      putResult,
    );
    if (result.status === 'written') {
      return Object.freeze({
        status: 'created',
        observation: Object.freeze({ etag: result.etag, versionId: result.versionId }),
      });
    }
    const existing = await observe(admittedKey, recordMaxBytes, 'Conditional object record observation');
    if (existing === undefined || existing.body !== body) {
      return Object.freeze({ status: 'conflict', observed: existing });
    }
    return Object.freeze({
      status: 'idempotent-retry',
      observation: Object.freeze({ etag: existing.etag, versionId: existing.versionId }),
    });
  }

  /** @param {unknown} value */
  async function readRecord(value) {
    const read = exactRecord(value, READ_REQUEST_KEYS, 'Conditional object record read');
    return observe(key(read['key'], 'Conditional object record key'), recordMaxBytes, 'Conditional object record');
  }

  /** @param {unknown} value */
  async function readPointer(value) {
    const read = exactRecord(value, READ_REQUEST_KEYS, 'Conditional object pointer read');
    return observe(key(read['key'], 'Conditional object pointer key'), pointerMaxBytes, 'Conditional object pointer');
  }

  /** @param {unknown} value */
  async function readPointerCoordinates(value) {
    if (coordinateObject === null) {
      throw new Error('Conditional object coordinate port is not installed.');
    }
    const read = exactRecord(value, READ_REQUEST_KEYS, 'Conditional object pointer coordinate read');
    const admittedKey = key(read['key'], 'Conditional object pointer key');
    return invokeExactPort(
      coordinateObject,
      [inertRecord({ key: admittedKey })],
      'Conditional object pointer coordinate observation',
      /** @returns {ObjectCoordinates | undefined} */ (observed) =>
        observed === undefined ? undefined : observation(observed, 'Conditional object pointer coordinates'),
    );
  }

  /** @param {unknown} value */
  async function movePointer(value) {
    const movement = exactRecord(value, POINTER_REQUEST_KEYS, 'Conditional object pointer movement');
    const admittedKey = key(movement['key'], 'Conditional object pointer key');
    const body = boundedBody(movement['body'], pointerMaxBytes, 'Conditional object pointer body');
    const expected =
      movement['expected'] === null ? null : observation(movement['expected'], 'Conditional object expected pointer');
    const condition =
      expected === null
        ? inertRecord({ type: 'if-none-match' })
        : inertRecord({
            type: 'if-match',
            etag: expected.etag,
            versionId: expected.versionId,
          });
    const result = await invokeExactPort(
      putObject,
      [inertRecord({ key: admittedKey, body, condition })],
      'Conditional object pointer put',
      putResult,
    );
    if (result.status === 'written') {
      return Object.freeze({
        status: 'moved',
        observation: Object.freeze({ etag: result.etag, versionId: result.versionId }),
      });
    }
    const existing = await observe(admittedKey, pointerMaxBytes, 'Conditional object pointer observation');
    if (existing !== undefined && existing.body === body) {
      return Object.freeze({
        status: 'idempotent-retry',
        observation: Object.freeze({ etag: existing.etag, versionId: existing.versionId }),
      });
    }
    return Object.freeze({ status: 'conflict', expected, observed: existing });
  }

  return Object.freeze({ movePointer, publishRecord, readPointer, readPointerCoordinates, readRecord });
}

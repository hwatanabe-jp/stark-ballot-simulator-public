import { hasDenseArrayOwnKeys } from './internal.js';
import { types } from 'node:util';

// Only a tree whose own data and every descendant are immutable can retain this
// proof between admissions. Mutable shells and byte arrays are always revisited.
const proxyFreeImmutableTrees = new WeakSet();

/**
 * Reject proxies before invoking any descriptor or prototype traps. This does
 * not admit a schema: callers still capture and validate the exact data shape.
 * @param {unknown} value
 * @param {string} label
 * @param {Set<object>} ancestors
 * @returns {boolean} whether the entire inspected tree is immutable
 */
export function rejectProxyTree(value, label, ancestors = new Set()) {
  if (typeof value !== 'object' || value === null) return true;
  if (types.isProxy(value)) throw new Error(`${label} must not contain a Proxy.`);
  if (value instanceof Uint8Array) return false;
  if (proxyFreeImmutableTrees.has(value)) return true;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let immutable = Object.isFrozen(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        immutable = false;
      } else {
        // Do not short-circuit: even mutable trees must inspect every child.
        const childImmutable = rejectProxyTree(descriptor.value, label, ancestors);
        immutable = immutable && childImmutable;
      }
    }
    if (immutable) proxyFreeImmutableTrees.add(value);
    return immutable;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Capture one plain record through its own data descriptors. The returned
 * record never reads through the source object's property access path.
 *
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @param {string} label
 * @returns {Readonly<Record<string, unknown>>}
 */
export function snapshotExactRecord(value, expectedKeys, label) {
  let descriptors;
  try {
    descriptors = captureRecordDescriptors(value, label);
  } catch (error) {
    throw new Error(`${label} must use the exact enumerable data shape.`, { cause: error });
  }
  const actualKeys = [...descriptors.keys()].sort();
  const expected = [...expectedKeys].sort();
  if (
    new Set(expected).size !== expected.length ||
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must use the exact enumerable data shape.`);
  }
  return freezeRecord(descriptors, (entry) => entry);
}

/**
 * Capture one exact dense array through its indexed data descriptors.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {readonly unknown[]}
 */
export function snapshotDenseArray(value, label) {
  const entries = captureArrayEntries(value, label);
  return Object.freeze(entries);
}

/**
 * Recursively capture canonical authority data into detached, deeply frozen
 * plain records and dense arrays. Uint8Array values become detached byte
 * copies; callers may consume those copies without re-reading the source.
 * Functions, accessors, hidden/symbol data, cycles, and other non-plain
 * objects are outside this boundary.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown}
 */
export function snapshotDataTree(value, label) {
  return snapshotData(value, label, new Set());
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Map<string, unknown>}
 */
function captureRecordDescriptors(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object with enumerable data properties.`);
  }
  const ownKeys = capturePlainRecordKeys(value, label);

  const descriptors = new Map();
  for (const key of ownKeys) {
    const descriptor = captureOwnDescriptor(value, key, `${label} must contain only enumerable data properties.`);
    if (typeof key !== 'string' || !isEnumerableDataDescriptor(descriptor)) {
      throw new Error(`${label} must contain only enumerable data properties.`);
    }
    descriptors.set(key, descriptor.value);
  }
  return descriptors;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {unknown[]}
 */
function captureArrayEntries(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must use a dense indexed data shape.`);
  }
  let ownKeys;
  let lengthDescriptor;
  try {
    ownKeys = Reflect.ownKeys(value);
    lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  } catch (error) {
    throw new Error(`${label} must use a dense indexed data shape.`, { cause: error });
  }
  const length = admitArrayLengthDescriptor(lengthDescriptor, label);
  if (!hasDenseArrayOwnKeys(ownKeys, length)) {
    throw new Error(`${label} must use a dense indexed data shape.`);
  }

  const entries = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = captureOwnDescriptor(value, String(index), `${label} must use a dense indexed data shape.`);
    if (!isEnumerableDataDescriptor(descriptor)) {
      throw new Error(`${label} must use a dense indexed data shape.`);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

/**
 * @param {Map<string, unknown>} descriptors
 * @param {(value: unknown, key: string) => unknown} mapValue
 * @returns {Readonly<Record<string, unknown>>}
 */
function freezeRecord(descriptors, mapValue) {
  /** @type {Record<string, unknown>} */
  const snapshot = {};
  for (const [key, value] of descriptors) {
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: mapValue(value, key),
    });
  }
  return Object.freeze(snapshot);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {Set<object>} ancestors
 * @returns {unknown}
 */
function snapshotData(value, label, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} contains an unsupported value.`);
  }
  return snapshotObject(value, label, ancestors);
}

const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  TYPED_ARRAY_PROTOTYPE === null
    ? undefined
    : Reflect.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteLength')?.get;
const TYPED_ARRAY_BUFFER_GETTER =
  TYPED_ARRAY_PROTOTYPE === null ? undefined : Reflect.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')?.get;

/**
 * @param {Uint8Array} value
 * @param {string} label
 * @returns {Uint8Array}
 */
function snapshotBytes(value, label) {
  const { byteLength, ownKeys } = captureByteArrayMetadata(value, label);
  for (let index = 0; index < byteLength; index += 1) {
    const key = String(index);
    const descriptor = captureOwnDescriptor(value, key, `${label} byte array is invalid.`);
    if (ownKeys[index] !== key || !isEnumerableDataDescriptor(descriptor)) {
      throw new Error(`${label} byte array is invalid.`);
    }
  }
  const snapshot = new Uint8Array(byteLength);
  try {
    Reflect.apply(Uint8Array.prototype.set, snapshot, [value]);
  } catch (error) {
    throw new Error(`${label} byte array is invalid.`, { cause: error });
  }
  return snapshot;
}

/** Copy indexed data properties without invoking accessors; callers own bounds and error policy.
 * @param {unknown[]} value @param {number} length @param {string} errorMessage
 * @returns {unknown[]}
 */
export function copyArrayDataEntries(value, length, errorMessage) {
  const entries = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!isEnumerableDataDescriptor(descriptor)) {
      throw new Error(errorMessage);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

/** @param {PropertyDescriptor|undefined} descriptor @returns {descriptor is PropertyDescriptor} */
export function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
}

/** Read only own, enumerable data; accessors are never invoked.
 * @param {object} value @param {PropertyKey} key @param {string} errorMessage @returns {unknown}
 */
export function requireEnumerableDataProperty(value, key, errorMessage) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!isEnumerableDataDescriptor(descriptor)) throw new Error(errorMessage);
  return descriptor.value;
}

/** @param {object} value @param {PropertyKey} key @param {string} errorMessage */
function captureOwnDescriptor(value, key, errorMessage) {
  try {
    return Reflect.getOwnPropertyDescriptor(value, key);
  } catch (error) {
    throw new Error(errorMessage, { cause: error });
  }
}

/** @param {PropertyDescriptor|undefined} lengthDescriptor @param {string} label @returns {number} */
function admitArrayLengthDescriptor(lengthDescriptor, label) {
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new Error(`${label} must use a dense indexed data shape.`);
  }
  return lengthDescriptor.value;
}

/** @param {Uint8Array} value @param {string} label @returns {{byteLength:number,ownKeys:(string|symbol)[]}} */
function captureByteArrayMetadata(value, label) {
  if (TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined || TYPED_ARRAY_BUFFER_GETTER === undefined) {
    throw new Error(`${label} byte array is invalid.`);
  }
  let byteLength;
  let buffer;
  let ownKeys;
  try {
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    ownKeys = Reflect.ownKeys(value);
  } catch (error) {
    throw new Error(`${label} byte array is invalid.`, { cause: error });
  }
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer) ||
    ownKeys.length !== byteLength
  ) {
    throw new Error(`${label} byte array is invalid.`);
  }
  return { byteLength, ownKeys };
}

/** @param {object} value @param {string} label @param {Set<object>} ancestors @returns {unknown} */
function snapshotObject(value, label, ancestors) {
  if (ancestors.has(value)) {
    throw new Error(`${label} must not contain a cycle.`);
  }
  ancestors.add(value);
  try {
    if (value instanceof Uint8Array) {
      return snapshotBytes(value, label);
    }
    if (Array.isArray(value)) {
      const entries = captureArrayEntries(value, label).map((entry, index) =>
        snapshotData(entry, `${label}[${index}]`, ancestors),
      );
      return Object.freeze(entries);
    }
    const descriptors = captureRecordDescriptors(value, label);
    return freezeRecord(descriptors, (entry, key) => snapshotData(entry, `${label}.${key}`, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

/** @param {object} value @param {string} label */
function capturePlainRecordKeys(value, label) {
  let prototype;
  let ownKeys;
  try {
    prototype = Reflect.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch (error) {
    throw new Error(`${label} must be an object with enumerable data properties.`, { cause: error });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} contains an unsupported object.`);
  }

  return ownKeys;
}

/** Admit array shape without reading any element or accessor.
 * @param {unknown} value @param {string} notArrayMessage @param {string} invalidShapeMessage
 */
export function admitArrayOwnMetadata(value, notArrayMessage, invalidShapeMessage = notArrayMessage) {
  if (!Array.isArray(value)) throw new Error(notArrayMessage);
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) throw new Error(invalidShapeMessage);
  return { array: value, ownKeys };
}

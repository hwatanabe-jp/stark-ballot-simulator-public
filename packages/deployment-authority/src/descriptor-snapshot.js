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

  const descriptors = new Map();
  for (const key of ownKeys) {
    let descriptor;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch (error) {
      throw new Error(`${label} must contain only enumerable data properties.`, { cause: error });
    }
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
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
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new Error(`${label} must use a dense indexed data shape.`);
  }
  const length = lengthDescriptor.value;
  if (
    ownKeys.length !== length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' || (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)),
    )
  ) {
    throw new Error(`${label} must use a dense indexed data shape.`);
  }

  const entries = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    } catch (error) {
      throw new Error(`${label} must use a dense indexed data shape.`, { cause: error });
    }
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
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
  for (let index = 0; index < byteLength; index += 1) {
    const key = String(index);
    let descriptor;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch (error) {
      throw new Error(`${label} byte array is invalid.`, { cause: error });
    }
    if (
      ownKeys[index] !== key ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
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

import { types } from 'node:util';

const TYPED_ARRAY_PROTOTYPE = Reflect.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  TYPED_ARRAY_PROTOTYPE === null
    ? undefined
    : Reflect.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteLength')?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  TYPED_ARRAY_PROTOTYPE === null
    ? undefined
    : Reflect.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteOffset')?.get;
const TYPED_ARRAY_BUFFER_GETTER =
  TYPED_ARRAY_PROTOTYPE === null ? undefined : Reflect.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Reflect.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;

/**
 * Captures one untrusted byte array without walking its indexed properties.
 *
 * @param {unknown} value
 * @param {{label: string, maxBytes: number}} bounds
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function snapshotBoundedBytes(value, bounds) {
  const { label, maxBytes } = bounds;
  if (
    types.isProxy(value) ||
    !types.isUint8Array(value) ||
    TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined ||
    TYPED_ARRAY_BYTE_OFFSET_GETTER === undefined ||
    TYPED_ARRAY_BUFFER_GETTER === undefined ||
    ARRAY_BUFFER_BYTE_LENGTH_GETTER === undefined
  ) {
    throw new Error(`${label} must be a byte array.`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (types.isProxy(prototype) || (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)) {
    throw new Error(`${label} must use the exact byte-array shell.`);
  }
  /** @type {unknown} */
  let byteLength;
  /** @type {unknown} */
  let byteOffset;
  /** @type {unknown} */
  let buffer;
  /** @type {unknown} */
  let bufferByteLength;
  try {
    byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
    buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
  } catch (error) {
    throw new Error(`${label} must be a byte array.`, { cause: error });
  }
  if (types.isSharedArrayBuffer(buffer)) {
    throw new Error(`${label} must not use shared memory.`);
  }
  try {
    bufferByteLength = Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, buffer, []);
  } catch (error) {
    throw new Error(`${label} must be a byte array.`, { cause: error });
  }
  if (
    typeof byteLength !== 'number' ||
    typeof byteOffset !== 'number' ||
    typeof bufferByteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(bufferByteLength) ||
    byteLength === 0 ||
    byteLength > maxBytes ||
    byteOffset < 0 ||
    bufferByteLength < byteOffset + byteLength
  ) {
    throw new Error(`${label} byte length is invalid.`);
  }
  const snapshot = new Uint8Array(byteLength);
  try {
    Reflect.apply(Uint8Array.prototype.set, snapshot, [value]);
  } catch (error) {
    throw new Error(`${label} must be a byte array.`, { cause: error });
  }
  return snapshot;
}

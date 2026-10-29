import {
  isNonArrayObject,
  hasExactOwnKeys,
  isNonNegativeSafeInteger,
} from '@stark-ballot/validation/unknown-value-guards';

const ROOT_KEYS = new Set(['timestamp', 'root', 'treeSize']);
const SIGNED_ROOT_KEYS = new Set([...ROOT_KEYS, 'signature']);

function hasRootSnapshotShape(value: unknown): value is Record<string, unknown> {
  return isNonArrayObject(value) && (hasExactOwnKeys(value, ROOT_KEYS) || hasExactOwnKeys(value, SIGNED_ROOT_KEYS));
}

/** Admit common persisted fields; callers bind root encoding and tree size to their own evidence. */
export function parseRootSnapshotFields(value: unknown) {
  if (!hasRootSnapshotShape(value)) {
    return undefined;
  }
  const { timestamp, root, treeSize, signature } = value;
  if (
    !isNonNegativeSafeInteger(timestamp) ||
    typeof root !== 'string' ||
    (signature !== undefined && typeof signature !== 'string')
  ) {
    return undefined;
  }
  return { timestamp, root, treeSize, signature };
}

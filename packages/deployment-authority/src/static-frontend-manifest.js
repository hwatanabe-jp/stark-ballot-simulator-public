import { createHash } from 'node:crypto';
import { parseSha256, requireExactKeys } from './internal.js';
import { snapshotDataTree } from './descriptor-snapshot.js';

export const MAXIMUM_NODE_COUNT = 20_000;
const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_TOTAL_BYTES = 512 * 1024 * 1024;
const MAXIMUM_PATH_BYTES = 1_024;
const CONTENT_IDENTITY_DOMAIN = Buffer.from('stark-ballot-static-frontend-content\0', 'utf8');

/** @param {number} value */
function uint64(value) {
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(value));
  return frame;
}

/** @param {unknown} value @param {string} label */
function sha256(value, label) {
  return parseSha256(value, label);
}

/** @param {unknown} value @param {string} label */
export function contentPath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAXIMUM_PATH_BYTES ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.endsWith('/') ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function safeNonnegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** @param {unknown} currentBytesValue @param {unknown} nextBytesValue */
export function admitStaticFrontendAggregateBytes(currentBytesValue, nextBytesValue) {
  const currentBytes = safeNonnegativeInteger(currentBytesValue, 'Static frontend current byte count');
  const nextBytes = safeNonnegativeInteger(nextBytesValue, 'Static frontend next-file byte count');
  const totalBytes = currentBytes + nextBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAXIMUM_TOTAL_BYTES) {
    throw new Error('Static frontend content exceeds its total byte bound.');
  }
  return totalBytes;
}

/** @param {unknown} currentBytesValue @param {unknown} observedFileBytesValue */
export function admitStaticFrontendFileReadMaximum(currentBytesValue, observedFileBytesValue) {
  const currentBytes = safeNonnegativeInteger(currentBytesValue, 'Static frontend current byte count');
  const observedFileBytes = safeNonnegativeInteger(observedFileBytesValue, 'Static frontend observed file byte count');
  if (observedFileBytes > MAXIMUM_FILE_BYTES) {
    throw new Error('Static frontend content file exceeds its byte bound.');
  }
  admitStaticFrontendAggregateBytes(currentBytes, observedFileBytes);
  return Math.max(1, Math.min(MAXIMUM_FILE_BYTES, MAXIMUM_TOTAL_BYTES - currentBytes));
}

/**
 * @param {readonly Readonly<{byteLength: number, contentSha256: string, path: string}>[]} entries
 */
export function deriveDigestEntryIdentity(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAXIMUM_NODE_COUNT) {
    throw new Error('Static frontend content entries are invalid.');
  }
  const admitted = entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Static frontend content entry ${index} is invalid.`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== 3 || keys[0] !== 'byteLength' || keys[1] !== 'contentSha256' || keys[2] !== 'path') {
      throw new Error(`Static frontend content entry ${index} is invalid.`);
    }
    const byteLength = safeNonnegativeInteger(entry.byteLength, `Static frontend content entry ${index} byte length`);
    if (byteLength > MAXIMUM_FILE_BYTES) {
      throw new Error(`Static frontend content entry ${index} exceeds its file byte bound.`);
    }
    return Object.freeze({
      byteLength,
      contentSha256: sha256(entry.contentSha256, `Static frontend content entry ${index} SHA-256`),
      path: contentPath(entry.path, `Static frontend content entry ${index} path`),
    });
  });
  admitted.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (new Set(admitted.map((entry) => entry.path)).size !== admitted.length) {
    throw new Error('Static frontend content contains duplicate paths.');
  }
  let totalBytes = 0;
  const hash = createHash('sha256');
  hash.update(CONTENT_IDENTITY_DOMAIN);
  hash.update(uint64(admitted.length));
  for (const entry of admitted) {
    totalBytes = admitStaticFrontendAggregateBytes(totalBytes, entry.byteLength);
    const pathBytes = Buffer.from(entry.path, 'utf8');
    hash.update(uint64(pathBytes.length));
    hash.update(pathBytes);
    hash.update(uint64(entry.byteLength));
    hash.update(Buffer.from(entry.contentSha256, 'hex'));
  }
  return Object.freeze({ fileCount: admitted.length, sha256: hash.digest('hex'), totalBytes });
}

/** @param {unknown} value @param {string} label */
function contentIdentity(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const record = /** @type {Readonly<Record<string, unknown>>} */ (value);
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'fileCount' || keys[1] !== 'sha256' || keys[2] !== 'totalBytes') {
    throw new Error(`${label} is invalid.`);
  }
  const { fileCount, totalBytes } = contentIdentitySize(record, label);
  return Object.freeze({ fileCount, sha256: sha256(record['sha256'], `${label} SHA-256`), totalBytes });
}

/** @param {unknown} firstValue @param {unknown} secondValue */
export function admitMatchingStaticFrontendContentIdentities(firstValue, secondValue) {
  const first = contentIdentity(firstValue, 'Static frontend first content identity');
  const second = contentIdentity(secondValue, 'Static frontend second content identity');
  if (
    first.fileCount !== second.fileCount ||
    first.sha256 !== second.sha256 ||
    first.totalBytes !== second.totalBytes
  ) {
    throw new Error('Static frontend content changed around deployment.');
  }
  return first;
}

/** @param {unknown} value */
export function admitStaticFrontendManifest(value) {
  const input = requireExactKeys(
    snapshotDataTree(value, 'Frontend manifest'),
    ['files', 'fileCount', 'sha256', 'totalBytes'],
    'Frontend manifest',
  );
  if (!Array.isArray(input['files'])) throw new Error('Frontend manifest files missing.');
  const files = /** @type {readonly {byteLength:number,contentSha256:string,path:string}[]} */ (input['files']);
  const identity = deriveDigestEntryIdentity(files);
  admitMatchingStaticFrontendContentIdentities(identity, {
    fileCount: input['fileCount'],
    sha256: input['sha256'],
    totalBytes: input['totalBytes'],
  });
  return Object.freeze({ files: Object.freeze(files.map((entry) => Object.freeze({ ...entry }))), ...identity });
}

/** @param {Readonly<Record<string,unknown>>} record @param {string} label */
function contentIdentitySize(record, label) {
  const fileCount = safeNonnegativeInteger(record['fileCount'], `${label} file count`);
  const totalBytes = safeNonnegativeInteger(record['totalBytes'], `${label} total bytes`);
  if (fileCount < 1 || fileCount > MAXIMUM_NODE_COUNT || totalBytes > MAXIMUM_TOTAL_BYTES) {
    throw new Error(`${label} is invalid.`);
  }
  return { fileCount, totalBytes };
}

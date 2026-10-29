import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** @param {Uint8Array} value */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @returns {value is string} */
export function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isSafeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.split('/').includes('..')
  );
}

/** @typedef {{path:string,sha256:string,mode:'0644'|'0755',size:number}} InstalledAssetFile */

/** @param {unknown} value @param {number} maximumBytes @returns {value is number} */
function isAssetSize(value, maximumBytes) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximumBytes;
}

/** @param {unknown} value @param {number} [maximumBytes] @returns {value is InstalledAssetFile} */
export function isInstalledAssetFile(value, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (!isRecord(value)) return false;
  const candidate = value;
  return (
    Object.keys(candidate).sort().join('\0') === 'mode\0path\0sha256\0size' &&
    isSafeRelativePath(candidate['path']) &&
    isSha256(candidate['sha256']) &&
    (candidate['mode'] === '0644' || candidate['mode'] === '0755') &&
    isAssetSize(candidate['size'], maximumBytes)
  );
}

/** @param {string} root @param {(reason:'symbolic-link'|'unsupported-entry')=>Error} invalidEntry @param {string} [relativeDirectory] @returns {Promise<string[]>} */
export async function listAssetFiles(root, invalidEntry, relativeDirectory = '') {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw invalidEntry('symbolic-link');
    if (entry.isDirectory()) files.push(...(await listAssetFiles(root, invalidEntry, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
    else throw invalidEntry('unsupported-entry');
  }
  return files.sort();
}

/** @param {readonly string[]} actual @param {readonly InstalledAssetFile[]} files @param {()=>Error} invalidInventory */
export function assertAssetFileInventory(actual, files, invalidInventory) {
  const expected = [...files.map((file) => file.path), 'installation.json'].sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index]))
    throw invalidInventory();
}

/**
 * @param {string} root @param {readonly InstalledAssetFile[]} files
 * @param {(recordedMode:'0644'|'0755',actualMode:number)=>boolean} modeCompatible
 * @param {(reason:'TYPE'|'SIZE'|'MODE'|'HASH')=>Error} invalidFile
 */
export async function validateInstalledAssetFiles(root, files, modeCompatible, invalidFile) {
  for (const file of files) {
    const absolutePath = path.join(root, file.path);
    const details = await lstat(absolutePath);
    if (!details.isFile() || details.isSymbolicLink()) throw invalidFile('TYPE');
    if (details.size !== file.size) throw invalidFile('SIZE');
    if (!modeCompatible(file.mode, details.mode)) throw invalidFile('MODE');
    if (sha256(await readFile(absolutePath)) !== file.sha256) throw invalidFile('HASH');
  }
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {readonly InstalledAssetFile[]} files */
export function hasUniqueOrderedAssetPaths(files) {
  return (
    new Set(files.map((file) => file.path)).size === files.length &&
    !files.some((file, index) => index > 0 && (files[index - 1]?.path.localeCompare(file.path) ?? -1) >= 0)
  );
}

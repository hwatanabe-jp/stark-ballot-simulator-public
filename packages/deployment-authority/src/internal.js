import { createHash } from 'node:crypto';

const SOURCE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GROUPED_LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_ID_PATTERN = /^[0-9]{12}$/u;

/**
 * Freeze admitted acyclic records and arrays, including children of a frozen
 * shell. Callable ports pass through unchanged.
 *
 * @template T
 * @param {T} value
 * @returns {import('./canonical-json-value.js').ReadonlyData<T>}
 */
export function deepFreeze(value) {
  if (typeof value !== 'object' || value === null) {
    return /** @type {import('./canonical-json-value.js').ReadonlyData<T>} */ (value);
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return /** @type {import('./canonical-json-value.js').ReadonlyData<T>} */ (Object.freeze(value));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isPlainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
export function requireRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
export function requireExactKeys(value, expectedKeys, label) {
  const record = requireRecord(value, label);
  const ownKeys = Reflect.ownKeys(record);
  const actual = [];
  let admitsOnlyEnumerableStringDataProperties = true;
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      admitsOnlyEnumerableStringDataProperties = false;
      continue;
    }
    actual.push(key);
  }
  actual.sort();
  const expected = [...expectedKeys].sort();
  if (
    !admitsOnlyEnumerableStringDataProperties ||
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return record;
}

/**
 * Admit first-publication evidence for an independently selected S3 object.
 * Terraform Plan creates versioned `${key}.tflock` siblings before state exists.
 * With '.' grouping after the exact prefix, those suffixes consume one result;
 * the exact state key itself still appears as a Version or DeleteMarker.
 * Callers capture the complete observation with snapshotDataTree before entry.
 *
 * @param {unknown} value
 * @param {Readonly<{bucket: string, key: string, allowStateLockSuffix: boolean}>} scope
 * @param {string} label
 */
export function assertNeverPublishedS3Object(value, scope, label) {
  const input = requireExactKeys(value, ['versioning', 'versions'], label);
  const versioning = requireRecord(input['versioning'], `${label} bucket versioning`);
  const versions = requireRecord(input['versions'], `${label} object versions`);
  const groupedSuffix =
    scope.allowStateLockSuffix &&
    Array.isArray(versions['CommonPrefixes']) &&
    versions['CommonPrefixes'].length === 1 &&
    isPlainRecord(versions['CommonPrefixes'][0]) &&
    Object.keys(versions['CommonPrefixes'][0]).length === 1 &&
    versions['CommonPrefixes'][0]['Prefix'] === `${scope.key}.`;
  if (
    versioning['Status'] !== 'Enabled' ||
    versions['Name'] !== scope.bucket ||
    versions['Prefix'] !== scope.key ||
    versions['MaxKeys'] !== 1 ||
    versions['IsTruncated'] !== false ||
    (scope.allowStateLockSuffix
      ? versions['Delimiter'] !== '.'
      : Object.hasOwn(versions, 'Delimiter') && versions['Delimiter'] !== '') ||
    ['KeyMarker', 'VersionIdMarker', 'NextKeyMarker', 'NextVersionIdMarker', 'NextToken', 'ContinuationToken'].some(
      (name) => Object.hasOwn(versions, name) && versions[name] !== '',
    ) ||
    (Object.hasOwn(versions, 'EncodingType') &&
      versions['EncodingType'] !== '' &&
      versions['EncodingType'] !== 'url') ||
    ['Versions', 'DeleteMarkers'].some(
      (name) => Object.hasOwn(versions, name) && (!Array.isArray(versions[name]) || versions[name].length !== 0),
    ) ||
    (Object.hasOwn(versions, 'CommonPrefixes') &&
      (!Array.isArray(versions['CommonPrefixes']) || (versions['CommonPrefixes'].length !== 0 && !groupedSuffix)))
  ) {
    throw new Error(`${label} requires enabled versioning and a complete empty inventory for its exact object.`);
  }
}

/** @param {string} value @returns {boolean} */
export function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

/** @param {unknown} value @param {string} label @param {RegExp | undefined} [pattern] @returns {string} */
export function requireString(value, label, pattern) {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @returns {string} */
export function requireGroupedLowercaseUuid(value, label) {
  return requireString(value, label, GROUPED_LOWERCASE_UUID_PATTERN);
}

/** @param {string} value @returns {string} */
export function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * @param {unknown} value
 * @param {Set<object>} ancestors
 * @param {number | undefined} [indentationDepth]
 * @returns {string}
 */
function serializeCanonical(value, ancestors, indentationDepth) {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('canonical JSON numbers must be finite');
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new Error('canonical JSON integers must be safe');
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new Error('canonical JSON does not admit undefined values');
    case 'object': {
      if (ancestors.has(value)) {
        throw new Error('canonical JSON does not admit circular values');
      }
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const ownKeys = Reflect.ownKeys(value);
          const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
          if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) {
            throw new Error('canonical JSON arrays must contain only dense indexed data properties');
          }
          const length = lengthDescriptor.value;
          /** @type {unknown[]} */
          const entries = [];
          for (let index = 0; index < length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (descriptor === undefined) {
              throw new Error('canonical JSON does not admit sparse arrays');
            }
            if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
              throw new Error('canonical JSON arrays must contain only dense indexed data properties');
            }
            entries.push(descriptor.value);
          }
          if (
            ownKeys.length !== length + 1 ||
            ownKeys.some(
              (key) =>
                typeof key !== 'string' ||
                (key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)),
            )
          ) {
            throw new Error('canonical JSON arrays must contain only dense indexed data properties');
          }
          const nextIndentationDepth = indentationDepth === undefined ? undefined : indentationDepth + 1;
          const serializedEntries = entries.map((entry) => serializeCanonical(entry, ancestors, nextIndentationDepth));
          if (indentationDepth === undefined || serializedEntries.length === 0) {
            return `[${serializedEntries.join(',')}]`;
          }
          const entryIndentation = '  '.repeat(indentationDepth + 1);
          const closingIndentation = '  '.repeat(indentationDepth);
          return `[\n${entryIndentation}${serializedEntries.join(`,\n${entryIndentation}`)}\n${closingIndentation}]`;
        }
        const record = requireRecord(value, 'canonical JSON value');
        /** @type {[string, unknown][]} */
        const entries = Reflect.ownKeys(record).map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(record, key);
          if (
            typeof key !== 'string' ||
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !Object.hasOwn(descriptor, 'value')
          ) {
            throw new Error('canonical JSON records must contain only enumerable string-keyed data properties');
          }
          return [key, descriptor.value];
        });
        entries.sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0));
        const nextIndentationDepth = indentationDepth === undefined ? undefined : indentationDepth + 1;
        const separator = indentationDepth === undefined ? ':' : ': ';
        const serializedEntries = entries.map(
          ([key, entry]) =>
            `${JSON.stringify(key)}${separator}${serializeCanonical(entry, ancestors, nextIndentationDepth)}`,
        );
        if (indentationDepth === undefined || serializedEntries.length === 0) {
          return `{${serializedEntries.join(',')}}`;
        }
        const entryIndentation = '  '.repeat(indentationDepth + 1);
        const closingIndentation = '  '.repeat(indentationDepth);
        return `{\n${entryIndentation}${serializedEntries.join(`,\n${entryIndentation}`)}\n${closingIndentation}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new Error(`canonical JSON does not admit ${typeof value} values`);
  }
}

/** @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  return serializeCanonical(value, new Set());
}

/** @param {unknown} value @returns {string} */
export function canonicalJsonSha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * @param {unknown} value
 * @param {string} sha256Field
 * @param {unknown} expectedSha256
 * @param {string} label
 * @returns {string}
 */
export function validateCanonicalSha256Binding(value, sha256Field, expectedSha256, label) {
  const record = requireRecord(value, label);
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const sha256Descriptor = descriptors[sha256Field];
  if (
    sha256Descriptor === undefined ||
    sha256Descriptor.enumerable !== true ||
    !Object.hasOwn(sha256Descriptor, 'value')
  ) {
    throw new Error(`${label} ${sha256Field} is invalid`);
  }
  const boundSha256 = parseSha256(sha256Descriptor.value, `${label} ${sha256Field}`);
  const admittedExpectedSha256 = parseSha256(expectedSha256, `${label} expected SHA-256`);
  delete descriptors[sha256Field];
  const payload = Object.defineProperties({}, descriptors);
  if (canonicalJsonSha256(payload) !== boundSha256) {
    throw new Error(`${label} ${sha256Field} does not match its canonical body`);
  }
  if (boundSha256 !== admittedExpectedSha256) {
    throw new Error(`${label} ${sha256Field} does not match the expected SHA-256`);
  }
  return boundSha256;
}

/** @param {unknown} value @returns {string} */
export function canonicalRecordJson(value) {
  return `${serializeCanonical(value, new Set(), 0)}\n`;
}

/** @param {unknown} value @param {string} [label] @returns {string} */
export function parseFullSourceSha(value, label = 'source SHA') {
  if (typeof value !== 'string' || !SOURCE_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full 40- or 64-character lowercase source SHA`);
  }
  return value;
}

/** @param {unknown} value @param {string} [label] @returns {string} */
export function parseGitCommitSha(value, label = 'source SHA') {
  if (typeof value !== 'string' || !GIT_COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a full 40-character lowercase Git SHA.`);
  }
  return value;
}

/** @param {unknown} value @param {string} [label] @returns {string} */
export function parseSha256(value, label = 'SHA-256') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

/** @param {unknown} value @param {string} [label] @returns {string} */
export function parseImageDigest(value, label = 'image digest') {
  if (typeof value !== 'string' || !value.startsWith('sha256:')) {
    throw new Error(`${label} must be a lowercase sha256 image digest`);
  }
  return `sha256:${parseSha256(value.slice('sha256:'.length), label)}`;
}

/** @param {unknown} value @param {string} [label] @returns {string} */
export function parseS3VersionId(value, label = 'S3 VersionId') {
  if (value === 'null') {
    throw new Error(`${label} must not be the literal S3 VersionId "null"`);
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    /\s/u.test(value) ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${label} must be a valid opaque S3 VersionId`);
  }
  return value;
}

/**
 * @typedef {{ readonly key: string, readonly versionId: string, readonly sha256: string }} ImmutableObjectReference
 */

/** @param {unknown} value @returns {ImmutableObjectReference} */
export function parseImmutableObjectReference(value) {
  const record = requireExactKeys(value, ['key', 'sha256', 'versionId'], 'immutable object reference');
  const key = requireString(record['key'], 'immutable object key');
  if (Buffer.byteLength(key, 'utf8') > 1024 || key.startsWith('/') || key.includes('..')) {
    throw new Error('immutable object key is invalid');
  }
  const versionId = parseS3VersionId(record['versionId'], 'immutable object VersionId');
  const sha256 = parseSha256(record['sha256'], 'immutable object SHA-256');
  return deepFreeze({ key, versionId, sha256 });
}

/** @param {unknown} value @returns {void} */
export function assertMatchingSourcePins(value) {
  const record = requireExactKeys(
    value,
    ['requestedSourceSha', 'resolvedSourceSha', 'sourceActionSourceSha'],
    'source pin comparison',
  );
  const requested = parseGitCommitSha(record['requestedSourceSha'], 'requested source SHA');
  const sourceAction = parseGitCommitSha(record['sourceActionSourceSha'], 'Source action source SHA');
  const resolved = parseGitCommitSha(record['resolvedSourceSha'], 'resolved source SHA');
  if (requested !== sourceAction || requested !== resolved) {
    throw new Error('requested, Source action, and resolved source SHAs must match exactly');
  }
}

/**
 * @typedef {{ readonly partition: 'aws', readonly accountId: string, readonly region: string, readonly repository: string }} DigestPinnedImagePolicy
 * @typedef {DigestPinnedImagePolicy & { readonly digest: string, readonly imageUri: string }} DigestPinnedImageReference
 */

/** @param {unknown} value @param {DigestPinnedImagePolicy} policy @returns {DigestPinnedImageReference} */
export function parseDigestPinnedImageReference(value, policy) {
  const imageUri = requireString(value, 'image reference');
  const exactPolicy = requireExactKeys(
    policy,
    ['accountId', 'partition', 'region', 'repository'],
    'digest-pinned image policy',
  );
  if (exactPolicy['partition'] !== 'aws') {
    throw new Error('image reference must be the exact authorized digest-pinned ECR repository');
  }
  const accountId = requireString(exactPolicy['accountId'], 'image account ID', ACCOUNT_ID_PATTERN);
  const region = requireString(exactPolicy['region'], 'image region');
  const repository = requireString(exactPolicy['repository'], 'image repository');
  const prefix = `${accountId}.dkr.ecr.${region}.amazonaws.com/${repository}@`;
  const digest = imageUri.startsWith(prefix) ? imageUri.slice(prefix.length) : '';
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest) || imageUri !== `${prefix}${digest}`) {
    throw new Error('image reference must be the exact authorized digest-pinned ECR repository');
  }
  return deepFreeze({
    partition: 'aws',
    accountId,
    region,
    repository,
    digest,
    imageUri,
  });
}

/** @param {unknown} value @returns {'create' | 'idempotent-retry'} */
export function classifyImmutablePublication(value) {
  const record = requireExactKeys(value, ['observedSha256', 'proposedSha256'], 'immutable publication input');
  const proposedSha256 = parseSha256(record['proposedSha256'], 'proposed object SHA-256');
  if (record['observedSha256'] === undefined) {
    return 'create';
  }
  const observedSha256 = parseSha256(record['observedSha256'], 'observed object SHA-256');
  if (observedSha256 === proposedSha256) {
    return 'idempotent-retry';
  }
  throw new Error('immutable publication conflicts with existing bytes');
}

/** @param {unknown} value @returns {void} */
export function assertPointerCompareAndSwap(value) {
  const record = requireExactKeys(
    value,
    ['expectedVersionOrEtag', 'observedVersionOrEtag'],
    'pointer compare-and-swap input',
  );
  const expected = requireString(record['expectedVersionOrEtag'], 'expected pointer version or ETag');
  const observed = requireString(record['observedVersionOrEtag'], 'observed pointer version or ETag');
  if (expected !== observed) {
    throw new Error('mutable pointer changed after review');
  }
}

/**
 * @template {string} TContext
 * @template TNames, TPolicy, TProject, TRoot, TSource, TTarget
 * @param {{
 *   contextType: TContext,
 *   names: TNames,
 *   policy: TPolicy,
 *   project: TProject,
 *   root: TRoot,
 *   source: TSource,
 *   target: TTarget,
 *   targetConfigurationSha256: string,
 * }} input
 */
export function assembleDeploymentContext({
  contextType,
  names,
  policy,
  project,
  root,
  source,
  target,
  targetConfigurationSha256,
}) {
  return deepFreeze({
    contextType,
    project,
    target,
    root,
    source,
    names,
    policy,
    targetConfigurationSha256,
  });
}

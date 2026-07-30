const checksumPattern = /^[0-9a-f]{64}$/;
const gitShaPattern = /^[0-9a-f]{40}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;
const imageIdPattern = /^0x[0-9a-f]{64}$/;
const methodVersionPattern = /^[0-9]+$/;

export class ImageIdMappingValidationError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ImageIdMappingValidationError';
  }
}

export class ImageIdVariantResolutionError extends Error {
  /**
   * @param {import('./image-id-mapping.js').ImageIdVariantResolutionReason} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = 'ImageIdVariantResolutionError';
    this.reason = reason;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new ImageIdMappingValidationError(`${label} must be an object.`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} keys
 * @param {string} label
 */
function requireExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ImageIdMappingValidationError(`${label} must contain only the semantic contract keys.`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {RegExp} [pattern]
 * @returns {string}
 */
function requireString(value, label, pattern) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new ImageIdMappingValidationError(`${label} is invalid.`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {readonly string[]}
 */
function requireStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new ImageIdMappingValidationError(`${label} must be a unique string array.`);
  }
  return [...value];
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireTimestamp(value, label) {
  const timestamp = requireString(value, label, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new ImageIdMappingValidationError(`${label} must be an ISO-8601 UTC timestamp.`);
  }
  return timestamp;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} label
 * @returns {import('./image-id-mapping.js').LocalGuestBuildProvenance}
 */
function parseLocalGuestBuildProvenance(value, label) {
  requireExactKeys(
    value,
    [
      'evidenceType',
      'compiledAt',
      'buildProfile',
      'hostRustVersion',
      'hostRustCommit',
      'risc0Version',
      'risc0Commit',
      'guestToolchain',
      'guestToolchainCommit',
      'guestElfSha256',
      'guestProgramBinarySha256',
      'hostBinarySha256',
      'zkvmCargoLockSha256',
    ],
    label,
  );
  return {
    evidenceType: 'local-guest-build',
    compiledAt: requireTimestamp(value['compiledAt'], `${label} compiledAt`),
    buildProfile: requireString(value['buildProfile'], `${label} buildProfile`),
    hostRustVersion: requireString(value['hostRustVersion'], `${label} hostRustVersion`),
    hostRustCommit: requireString(value['hostRustCommit'], `${label} hostRustCommit`, gitShaPattern),
    risc0Version: requireString(value['risc0Version'], `${label} risc0Version`),
    risc0Commit: requireString(value['risc0Commit'], `${label} risc0Commit`, gitShaPattern),
    guestToolchain: requireString(value['guestToolchain'], `${label} guestToolchain`),
    guestToolchainCommit: requireString(value['guestToolchainCommit'], `${label} guestToolchainCommit`, gitShaPattern),
    guestElfSha256: requireString(value['guestElfSha256'], `${label} guestElfSha256`, checksumPattern),
    guestProgramBinarySha256: requireString(
      value['guestProgramBinarySha256'],
      `${label} guestProgramBinarySha256`,
      checksumPattern,
    ),
    hostBinarySha256: requireString(value['hostBinarySha256'], `${label} hostBinarySha256`, checksumPattern),
    zkvmCargoLockSha256: requireString(value['zkvmCargoLockSha256'], `${label} zkvmCargoLockSha256`, checksumPattern),
  };
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} label
 * @returns {import('./image-id-mapping.js').AcceptedProverReleaseProvenance}
 */
function parseAcceptedProverReleaseProvenance(value, label) {
  requireExactKeys(
    value,
    [
      'evidenceType',
      'sourceSha',
      'proverImageDigest',
      'candidateMetadataSha256',
      'releaseRecordSha256',
      'toolchainArtifactRecordSha256',
    ],
    label,
  );
  return {
    evidenceType: 'accepted-prover-release',
    sourceSha: requireString(value['sourceSha'], `${label} sourceSha`, gitShaPattern),
    proverImageDigest: requireString(value['proverImageDigest'], `${label} proverImageDigest`, imageDigestPattern),
    candidateMetadataSha256: requireString(
      value['candidateMetadataSha256'],
      `${label} candidateMetadataSha256`,
      checksumPattern,
    ),
    releaseRecordSha256: requireString(value['releaseRecordSha256'], `${label} releaseRecordSha256`, checksumPattern),
    toolchainArtifactRecordSha256: requireString(
      value['toolchainArtifactRecordSha256'],
      `${label} toolchainArtifactRecordSha256`,
      checksumPattern,
    ),
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {import('./image-id-mapping.js').ImageIdProvenance}
 */
function parseProvenance(value, label) {
  const record = requireRecord(value, label);
  if (record['evidenceType'] === 'local-guest-build') {
    return parseLocalGuestBuildProvenance(record, label);
  }
  if (record['evidenceType'] === 'accepted-prover-release') {
    return parseAcceptedProverReleaseProvenance(record, label);
  }
  throw new ImageIdMappingValidationError(`${label} evidenceType is invalid.`);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {import('./image-id-mapping.js').ImageIdVariantAuthority}
 */
function parseVariant(value, label) {
  const record = requireRecord(value, label);
  if (record['state'] === 'unconfirmed') {
    requireExactKeys(record, ['state', 'requiredEvidence'], `${label} unconfirmed variant`);
    if (record['requiredEvidence'] !== 'accepted-prover-release') {
      throw new ImageIdMappingValidationError(`${label} requiredEvidence is invalid.`);
    }
    return {
      state: 'unconfirmed',
      requiredEvidence: 'accepted-prover-release',
    };
  }
  if (record['state'] === 'confirmed') {
    requireExactKeys(record, ['state', 'imageId', 'provenance'], `${label} confirmed variant`);
    return {
      state: 'confirmed',
      imageId: requireString(record['imageId'], `${label} imageId`, imageIdPattern),
      provenance: parseProvenance(record['provenance'], `${label} provenance`),
    };
  }
  throw new ImageIdMappingValidationError(`${label} state is invalid.`);
}

/**
 * @param {unknown} value
 * @param {string} methodKey
 * @returns {import('./image-id-mapping.js').ImageIdMethodMapping}
 */
function parseMethodMapping(value, methodKey) {
  const label = `ImageID method mapping ${methodKey}`;
  const record = requireRecord(value, label);
  requireExactKeys(record, ['methodVersion', 'variants', 'description', 'features'], label);
  const methodVersion = record['methodVersion'];
  if (
    typeof methodVersion !== 'number' ||
    !Number.isSafeInteger(methodVersion) ||
    methodVersion < 1 ||
    methodVersion !== Number(methodKey)
  ) {
    throw new ImageIdMappingValidationError(`${label} methodVersion is inconsistent.`);
  }
  const variants = requireRecord(record['variants'], `${label} variants`);
  requireExactKeys(variants, ['default', 'x86_64'], `${label} variants`);
  return {
    methodVersion,
    variants: {
      default: parseVariant(variants['default'], `${label} default`),
      x86_64: parseVariant(variants['x86_64'], `${label} x86_64`),
    },
    description: requireString(record['description'], `${label} description`),
    features: requireStringArray(record['features'], `${label} features`),
  };
}

/**
 * Parse the one supported semantic ImageID mapping contract. Predecessor flat
 * fields are rejected rather than normalized.
 *
 * @param {unknown} value
 * @returns {import('./image-id-mapping.js').ImageIdMapping}
 */
export function parseImageIdMapping(value) {
  const record = requireRecord(value, 'ImageID mapping');
  requireExactKeys(record, ['mappingType', 'mappings', 'current', 'deprecated', 'metadata'], 'ImageID mapping');
  if (record['mappingType'] !== 'image-id-mapping') {
    throw new ImageIdMappingValidationError('ImageID mapping mappingType is invalid.');
  }
  const current = requireString(record['current'], 'ImageID mapping current', methodVersionPattern);
  const rawMappings = requireRecord(record['mappings'], 'ImageID mappings');
  /** @type {Record<string, import('./image-id-mapping.js').ImageIdMethodMapping>} */
  const mappings = {};
  for (const [methodKey, methodMapping] of Object.entries(rawMappings)) {
    if (!methodVersionPattern.test(methodKey)) {
      throw new ImageIdMappingValidationError(`ImageID method mapping key ${methodKey} is invalid.`);
    }
    mappings[methodKey] = parseMethodMapping(methodMapping, methodKey);
  }
  if (!Object.hasOwn(mappings, current)) {
    throw new ImageIdMappingValidationError('ImageID mapping current method is missing.');
  }
  const deprecated = requireStringArray(record['deprecated'], 'ImageID mapping deprecated');
  if (deprecated.some((methodKey) => !methodVersionPattern.test(methodKey) || methodKey === current)) {
    throw new ImageIdMappingValidationError('ImageID mapping deprecated method list is invalid.');
  }
  const metadata = requireRecord(record['metadata'], 'ImageID mapping metadata');
  requireExactKeys(metadata, ['lastUpdated', 'purpose', 'notes'], 'ImageID mapping metadata');
  return {
    mappingType: 'image-id-mapping',
    mappings,
    current,
    deprecated,
    metadata: {
      lastUpdated: requireTimestamp(metadata['lastUpdated'], 'ImageID mapping metadata lastUpdated'),
      purpose: requireString(metadata['purpose'], 'ImageID mapping metadata purpose'),
      notes: requireString(metadata['notes'], 'ImageID mapping metadata notes'),
    },
  };
}

/**
 * @param {import('./image-id-mapping.js').ImageIdMapping} mapping
 * @param {number | undefined} methodVersion
 * @param {import('./image-id-mapping.js').ImageIdVariant} variant
 * @returns {import('./image-id-mapping.js').ConfirmedImageIdVariant}
 */
export function resolveConfirmedImageIdVariant(mapping, methodVersion, variant) {
  const methodKey = methodVersion === undefined ? mapping.current : String(methodVersion);
  const method = mapping.mappings[methodKey];
  if (!method) {
    throw new ImageIdVariantResolutionError('unknown_method', `Unknown method version: ${methodKey}`);
  }
  const authority = method.variants[variant];
  if (authority.state === 'unconfirmed') {
    throw new ImageIdVariantResolutionError(
      'variant_unconfirmed',
      `Expected ImageID variant ${variant} is unconfirmed for method version ${methodKey}`,
    );
  }
  return authority;
}

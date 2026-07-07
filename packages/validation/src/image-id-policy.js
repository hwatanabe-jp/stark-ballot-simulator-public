/**
 * Shared ImageID selection policy.
 *
 * The current contract resolves expected ImageIDs from
 * `methodVersion + explicit variant`. Callers may override the final
 * ImageID via `EXPECTED_IMAGE_ID`, but variant selection itself must not
 * silently depend on caller-specific runtime heuristics.
 */

/**
 * @typedef {'default' | 'x86_64'} ImageIdVariant
 */

/**
 * Supported explicit ImageID mapping variants.
 *
 * @type {readonly ImageIdVariant[]}
 */
export const IMAGE_ID_VARIANTS = ['default', 'x86_64'];

/**
 * @param {unknown} value
 * @returns {value is ImageIdVariant}
 */
export function isImageIdVariant(value) {
  return typeof value === 'string' && IMAGE_ID_VARIANTS.includes(/** @type {ImageIdVariant} */ (value));
}

/**
 * Resolve the configured ImageID variant, failing closed on unsupported values.
 *
 * @param {unknown} value
 * @param {ImageIdVariant} [fallback]
 * @returns {ImageIdVariant}
 */
export function resolveConfiguredImageIdVariant(value, fallback = 'default') {
  if (value === undefined || value === null || `${value}`.trim().length === 0) {
    return fallback;
  }

  const trimmed = `${value}`.trim();
  if (!isImageIdVariant(trimmed)) {
    throw new Error(`Unsupported ImageID variant: ${trimmed}`);
  }

  return trimmed;
}

/**
 * @param {{ current?: unknown }} mapping
 * @param {number | undefined} version
 * @returns {string}
 */
function getVersionKey(mapping, version) {
  if (typeof version === 'number') {
    return String(version);
  }
  if (typeof mapping?.current === 'string' && mapping.current.length > 0) {
    return mapping.current;
  }
  throw new Error('ImageID mapping does not define a current method version');
}

/**
 * @param {ImageIdVariant} variant
 * @returns {'expectedImageID' | 'expectedImageID_x86_64'}
 */
function getVariantField(variant) {
  return variant === 'x86_64' ? 'expectedImageID_x86_64' : 'expectedImageID';
}

/**
 * Resolve the expected ImageID from the versioned public mapping.
 *
 * @param {import('./image-id-policy').ImageIdMappingLike} mapping
 * @param {number} [version]
 * @param {ImageIdVariant} [variant]
 * @returns {string}
 */
export function resolveExpectedImageIdFromMapping(mapping, version, variant = 'default') {
  const resolvedVariant = resolveConfiguredImageIdVariant(variant);
  const versionKey = getVersionKey(mapping, version);
  const versionMapping = mapping?.mappings?.[versionKey];

  if (!versionMapping || typeof versionMapping !== 'object') {
    throw new Error(`Unknown method version: ${versionKey}`);
  }

  if (Array.isArray(versionMapping.supportedVariants) && !versionMapping.supportedVariants.includes(resolvedVariant)) {
    throw new Error(`Expected ImageID variant ${resolvedVariant} is not active for method version ${versionKey}`);
  }

  const field = getVariantField(resolvedVariant);
  const value = versionMapping[field];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  throw new Error(`Expected ImageID variant ${resolvedVariant} is not available for method version ${versionKey}`);
}

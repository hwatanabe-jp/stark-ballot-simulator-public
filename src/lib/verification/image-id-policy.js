/**
 * Shared ImageID selection policy.
 *
 * The current contract resolves expected ImageIDs from
 * `methodVersion + explicit variant`. Callers may override the final
 * ImageID via `EXPECTED_IMAGE_ID`, but variant selection itself must not
 * silently depend on caller-specific runtime heuristics.
 */

export const IMAGE_ID_VARIANTS = ['default', 'x86_64'];

export function isImageIdVariant(value) {
  return typeof value === 'string' && IMAGE_ID_VARIANTS.includes(value);
}

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

function getVersionKey(mapping, version) {
  if (typeof version === 'number') {
    return String(version);
  }
  if (typeof mapping?.current === 'string' && mapping.current.length > 0) {
    return mapping.current;
  }
  throw new Error('ImageID mapping does not define a current method version');
}

function getVariantField(variant) {
  return variant === 'x86_64' ? 'expectedImageID_x86_64' : 'expectedImageID';
}

export function resolveExpectedImageIdFromMapping(mapping, version, variant = 'default') {
  const resolvedVariant = resolveConfiguredImageIdVariant(variant);
  const versionKey = getVersionKey(mapping, version);
  const versionMapping = mapping?.mappings?.[versionKey];

  if (!versionMapping || typeof versionMapping !== 'object') {
    throw new Error(`Unknown method version: ${versionKey}`);
  }

  const field = getVariantField(resolvedVariant);
  const value = versionMapping[field];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  throw new Error(`Expected ImageID variant ${resolvedVariant} is not available for method version ${versionKey}`);
}

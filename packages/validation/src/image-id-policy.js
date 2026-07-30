/**
 * Shared ImageID selection policy.
 *
 * The current contract resolves expected ImageIDs from
 * `methodVersion + explicit variant`. Callers may override the final
 * ImageID via `EXPECTED_IMAGE_ID`, but variant selection itself must not
 * silently depend on caller-specific runtime heuristics.
 */

import { parseImageIdMapping, resolveConfirmedImageIdVariant } from './image-id-mapping.js';

/** @typedef {import('./image-id-mapping.js').ImageIdVariant} ImageIdVariant */

/** @type {readonly ImageIdVariant[]} */
export const IMAGE_ID_VARIANTS = ['default', 'x86_64'];

/**
 * @param {unknown} value
 * @returns {value is ImageIdVariant}
 */
export function isImageIdVariant(value) {
  return typeof value === 'string' && IMAGE_ID_VARIANTS.includes(/** @type {ImageIdVariant} */ (value));
}

/**
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
 * @param {unknown} mapping
 * @param {number} [version]
 * @param {ImageIdVariant} [variant]
 * @returns {string}
 */
export function resolveExpectedImageIdFromMapping(mapping, version, variant = 'default') {
  const resolvedVariant = resolveConfiguredImageIdVariant(variant);
  const parsed = parseImageIdMapping(mapping);
  return resolveConfirmedImageIdVariant(parsed, version, resolvedVariant).imageId;
}

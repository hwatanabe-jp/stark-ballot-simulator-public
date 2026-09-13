/**
 * ImageID Verifier Implementation
 *
 * Provides expected ImageID mapping resolution. Cryptographic receipt verification is owned by
 * verifier-service, which calls RISC Zero Receipt::verify(expected_image_id).
 */

import {
  resolveExpectedImageIdFromMapping,
  type ImageIdMapping,
  type ImageIdVariant,
} from '@stark-ballot/validation/image-id-policy';
import {
  ImageIdMappingValidationError,
  ImageIdVariantResolutionError,
} from '@stark-ballot/validation/image-id-mapping';

export class ImageIdResolutionError extends Error {
  readonly reason: 'mapping_unavailable' | 'mapping_missing' | 'variant_unavailable' | 'variant_unconfirmed';

  constructor(
    reason: 'mapping_unavailable' | 'mapping_missing' | 'variant_unavailable' | 'variant_unconfirmed',
    message: string,
  ) {
    super(message);
    this.reason = reason;
    this.name = 'ImageIdResolutionError';
  }
}

/**
 * Get the expected ImageID for a given method version
 * @param mapping - ImageID mapping loaded by the runtime edge
 * @param version - Method version (defaults to current)
 */
export function getExpectedImageId(
  mapping: ImageIdMapping,
  version?: number,
  variant: ImageIdVariant = 'default',
): string {
  try {
    return resolveExpectedImageIdFromMapping(mapping, version, variant);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ImageIdVariantResolutionError && error.reason === 'unknown_method') {
      throw new ImageIdResolutionError('mapping_missing', message);
    }
    if (error instanceof ImageIdVariantResolutionError && error.reason === 'variant_unconfirmed') {
      throw new ImageIdResolutionError('variant_unconfirmed', message);
    }
    if (error instanceof ImageIdMappingValidationError) {
      throw new ImageIdResolutionError('mapping_unavailable', message);
    }
    throw new ImageIdResolutionError('variant_unavailable', message);
  }
}

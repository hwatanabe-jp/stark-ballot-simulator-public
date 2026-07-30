import { resolveConfiguredImageIdVariant } from './image-id-policy.js';
import { getExpectedImageId } from './image-id-verifier';
import { logger } from '@stark-ballot/verification/shared/logger';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import type { ImageIdMapping } from './image-id-types';

export const DEFAULT_POC_IMAGE_ID = '0x08aa256ee9120045bbdbe2152723ff657cf1cd7329cba46715954d183caa84de';

export type ImageIdMappingLoader = () => ImageIdMapping | Promise<ImageIdMapping>;

export async function resolveExpectedImageId(
  methodVersion?: number,
  options: {
    explicitImageId?: string;
    legacyExpectedImageIdPoc?: string;
    variant?: unknown;
    loadImageIdMapping?: ImageIdMappingLoader;
  } = {},
): Promise<string> {
  const explicit = options.explicitImageId;
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  if (options.legacyExpectedImageIdPoc && options.legacyExpectedImageIdPoc.length > 0) {
    logger.warn('legacy_image_id_override_ignored');
  }

  if (methodVersion !== undefined && methodVersion !== CURRENT_METHOD_VERSION) {
    throw new Error(`Unsupported method version: ${methodVersion}`);
  }

  const variant =
    options.variant === undefined
      ? resolveConfiguredImageIdVariant(undefined)
      : resolveConfiguredImageIdVariant(options.variant);

  if (!options.loadImageIdMapping) {
    throw new Error('ImageID mapping loader is required');
  }

  const mapping = await options.loadImageIdMapping();
  return getExpectedImageId(mapping, methodVersion, variant);
}

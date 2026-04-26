import { resolveConfiguredImageIdVariant, type ImageIdVariant } from './image-id-policy.js';
import { getExpectedImageId } from './image-id-verifier';
import { logger } from '@/lib/utils/logger';
import { CURRENT_METHOD_VERSION } from '@/lib/zkvm/types';

export const DEFAULT_POC_IMAGE_ID = '0xfa42cd07e70484a943d40f530b9b001392f215a0404398d63c710cef9b30f4b4';

export async function resolveExpectedImageId(
  methodVersion?: number,
  options: { variant?: ImageIdVariant } = {},
): Promise<string> {
  const explicit = process.env.EXPECTED_IMAGE_ID;
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  if (process.env.EXPECTED_IMAGEID_POC && process.env.EXPECTED_IMAGEID_POC.length > 0) {
    logger.warn('[ImageID] EXPECTED_IMAGEID_POC is deprecated; ignoring legacy override');
  }

  if (methodVersion !== undefined && methodVersion !== CURRENT_METHOD_VERSION) {
    throw new Error(`Unsupported method version: ${methodVersion}`);
  }

  const variant = options.variant ?? resolveConfiguredImageIdVariant(process.env.EXPECTED_IMAGE_ID_VARIANT);
  return getExpectedImageId(methodVersion, variant);
}

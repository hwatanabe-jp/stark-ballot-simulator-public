import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  resolveConfiguredImageIdVariant,
  resolveExpectedImageIdFromMapping,
} from '@stark-ballot/validation/image-id-policy';
import { loadPublicImageIdMapping } from '../image-id-mapping';

export const DEFAULT_POC_IMAGE_ID = '0x08aa256ee9120045bbdbe2152723ff657cf1cd7329cba46715954d183caa84de';

export async function resolveMockImageId(methodVersion: number = CURRENT_METHOD_VERSION): Promise<string> {
  const explicit = process.env['EXPECTED_IMAGE_ID'];
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  if (methodVersion !== CURRENT_METHOD_VERSION) {
    throw new Error(`Unsupported method version: ${methodVersion}`);
  }

  const variant = resolveConfiguredImageIdVariant(process.env['EXPECTED_IMAGE_ID_VARIANT']);
  const mapping = await loadPublicImageIdMapping();
  return resolveExpectedImageIdFromMapping(mapping, methodVersion, variant);
}

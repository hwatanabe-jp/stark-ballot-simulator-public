import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';
import {
  resolveConfiguredImageIdVariant,
  resolveExpectedImageIdFromMapping,
} from '@stark-ballot/validation/image-id-policy';
import { loadPublicImageIdMapping } from '../image-id-mapping';

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

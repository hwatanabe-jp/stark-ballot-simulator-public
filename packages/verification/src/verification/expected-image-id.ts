import { resolveConfiguredImageIdVariant, type ImageIdMapping } from '@stark-ballot/validation/image-id-policy';
import { getExpectedImageId } from './image-id-verifier';
import { CURRENT_METHOD_VERSION } from '@stark-ballot/zkvm-contract/zkvm/types';

export type ImageIdMappingLoader = () => ImageIdMapping | Promise<ImageIdMapping>;

export async function resolveExpectedImageId(
  methodVersion?: number,
  options: {
    explicitImageId?: string;
    variant?: unknown;
    loadImageIdMapping?: ImageIdMappingLoader;
  } = {},
): Promise<string> {
  const explicit = options.explicitImageId;
  if (explicit && explicit.length > 0) {
    return explicit;
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

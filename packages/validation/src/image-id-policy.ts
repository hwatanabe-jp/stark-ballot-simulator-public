import { parseImageIdMapping, resolveConfirmedImageIdVariant, type ImageIdVariant } from './image-id-mapping.js';

export type { ImageIdMapping, ImageIdVariant } from './image-id-mapping.js';

export const IMAGE_ID_VARIANTS = ['default', 'x86_64'] as const;

export function isImageIdVariant(value: unknown): value is ImageIdVariant {
  return typeof value === 'string' && IMAGE_ID_VARIANTS.includes(value as ImageIdVariant);
}

export function resolveConfiguredImageIdVariant(value: unknown, fallback: ImageIdVariant = 'default'): ImageIdVariant {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== 'string') {
    throw new Error('Unsupported ImageID variant value');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  if (!isImageIdVariant(trimmed)) {
    throw new Error(`Unsupported ImageID variant: ${trimmed}`);
  }

  return trimmed;
}

export function resolveExpectedImageIdFromMapping(
  mapping: unknown,
  version?: number,
  variant: ImageIdVariant = 'default',
): string {
  const resolvedVariant = resolveConfiguredImageIdVariant(variant);
  const parsed = parseImageIdMapping(mapping);
  return resolveConfirmedImageIdVariant(parsed, version, resolvedVariant).imageId;
}

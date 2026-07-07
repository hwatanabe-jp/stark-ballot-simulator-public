export type ImageIdVariant = 'default' | 'x86_64';

export interface ImageIdMappingLike {
  mappings: {
    [version: string]: {
      expectedImageID?: string;
      expectedImageID_x86_64?: string;
      supportedVariants?: string[];
    };
  };
  current?: string;
}

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

function getVersionKey(mapping: ImageIdMappingLike, version: number | undefined): string {
  if (typeof version === 'number') {
    return String(version);
  }
  if (typeof mapping.current === 'string' && mapping.current.length > 0) {
    return mapping.current;
  }
  throw new Error('ImageID mapping does not define a current method version');
}

function getVariantField(variant: ImageIdVariant): 'expectedImageID' | 'expectedImageID_x86_64' {
  return variant === 'x86_64' ? 'expectedImageID_x86_64' : 'expectedImageID';
}

export function resolveExpectedImageIdFromMapping(
  mapping: ImageIdMappingLike,
  version?: number,
  variant: ImageIdVariant = 'default',
): string {
  const resolvedVariant = resolveConfiguredImageIdVariant(variant);
  const versionKey = getVersionKey(mapping, version);
  const versionMapping = mapping.mappings[versionKey];

  if (!versionMapping) {
    throw new Error(`Unknown method version: ${versionKey}`);
  }

  if (Array.isArray(versionMapping.supportedVariants) && !versionMapping.supportedVariants.includes(resolvedVariant)) {
    throw new Error(`Expected ImageID variant ${resolvedVariant} is not active for method version ${versionKey}`);
  }

  const value = versionMapping[getVariantField(resolvedVariant)];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  throw new Error(`Expected ImageID variant ${resolvedVariant} is not available for method version ${versionKey}`);
}

import type { ImageIdMapping } from './image-id-types';

export type ImageIdVariant = 'default' | 'x86_64';

export declare const IMAGE_ID_VARIANTS: readonly ImageIdVariant[];

export declare function isImageIdVariant(value: unknown): value is ImageIdVariant;

export declare function resolveConfiguredImageIdVariant(value: unknown, fallback?: ImageIdVariant): ImageIdVariant;

export declare function resolveExpectedImageIdFromMapping(
  mapping: ImageIdMapping,
  version?: number,
  variant?: ImageIdVariant,
): string;

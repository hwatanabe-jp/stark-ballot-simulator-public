import type { ImageIdVariant } from './image-id-mapping.js';

export type { ImageIdMapping, ImageIdVariant } from './image-id-mapping.js';

export declare const IMAGE_ID_VARIANTS: readonly ImageIdVariant[];

export declare function isImageIdVariant(value: unknown): value is ImageIdVariant;

export declare function resolveConfiguredImageIdVariant(value: unknown, fallback?: ImageIdVariant): ImageIdVariant;

export declare function resolveExpectedImageIdFromMapping(
  mapping: unknown,
  version?: number,
  variant?: ImageIdVariant,
): string;

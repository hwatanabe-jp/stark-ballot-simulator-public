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

export declare const IMAGE_ID_VARIANTS: readonly ImageIdVariant[];

export declare function isImageIdVariant(value: unknown): value is ImageIdVariant;

export declare function resolveConfiguredImageIdVariant(value: unknown, fallback?: ImageIdVariant): ImageIdVariant;

export declare function resolveExpectedImageIdFromMapping(
  mapping: ImageIdMappingLike,
  version?: number,
  variant?: ImageIdVariant,
): string;

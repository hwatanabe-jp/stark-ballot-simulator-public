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

export {
  IMAGE_ID_VARIANTS,
  isImageIdVariant,
  resolveConfiguredImageIdVariant,
  resolveExpectedImageIdFromMapping,
} from '@stark-ballot/validation/image-id-policy';

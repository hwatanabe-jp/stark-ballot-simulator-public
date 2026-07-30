/**
 * ImageID Verifier Implementation
 *
 * Provides expected ImageID mapping resolution and mapping-source
 * consistency checks. Cryptographic receipt verification is owned by
 * verifier-service, which calls RISC Zero Receipt::verify(expected_image_id).
 */

import { resolveExpectedImageIdFromMapping, type ImageIdVariant } from './image-id-policy.js';
import {
  ImageIdMappingValidationError,
  ImageIdVariantResolutionError,
} from '@stark-ballot/validation/image-id-mapping';
import type { ImageIdMapping, MultiSourceVerificationResult } from './image-id-types';

export class ImageIdResolutionError extends Error {
  constructor(
    public readonly reason: 'mapping_unavailable' | 'mapping_missing' | 'variant_unavailable' | 'variant_unconfirmed',
    message: string,
  ) {
    super(message);
    this.name = 'ImageIdResolutionError';
  }
}

/**
 * Get the expected ImageID for a given method version
 * @param mapping - ImageID mapping loaded by the runtime edge
 * @param version - Method version (defaults to current)
 */
export function getExpectedImageId(
  mapping: ImageIdMapping,
  version?: number,
  variant: ImageIdVariant = 'default',
): string {
  try {
    return resolveExpectedImageIdFromMapping(mapping, version, variant);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ImageIdVariantResolutionError && error.reason === 'unknown_method') {
      throw new ImageIdResolutionError('mapping_missing', message);
    }
    if (error instanceof ImageIdVariantResolutionError && error.reason === 'variant_unconfirmed') {
      throw new ImageIdResolutionError('variant_unconfirmed', message);
    }
    if (error instanceof ImageIdMappingValidationError) {
      throw new ImageIdResolutionError('mapping_unavailable', message);
    }
    throw new ImageIdResolutionError('variant_unavailable', message);
  }
}

/**
 * Verify ImageID from multiple sources for enhanced security
 * by checking that configured mapping documents agree.
 */
export async function verifyFromMultipleSources(
  sources: readonly {
    id: string;
    load: () => ImageIdMapping | Promise<ImageIdMapping>;
  }[],
): Promise<MultiSourceVerificationResult> {
  const mappings: ImageIdMapping[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    try {
      mappings.push(await source.load());
    } catch (error) {
      errors.push(`Error loading from ${source.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Check if we got at least 2 sources
  if (mappings.length < 2) {
    return {
      verified: false,
      sourcesChecked: sources.length,
      consensus: false,
      error: 'Insufficient sources available',
      discrepancies: errors,
    };
  }

  // Check for consensus
  const firstMapping = JSON.stringify(mappings[0]);
  let consensus = true;
  const discrepancies: string[] = [];

  for (let i = 1; i < mappings.length; i++) {
    const currentMapping = JSON.stringify(mappings[i]);
    if (currentMapping !== firstMapping) {
      consensus = false;
      discrepancies.push(`Discrepancy detected between source 0 and source ${i}`);
    }
  }

  if (!consensus) {
    return {
      verified: false,
      sourcesChecked: mappings.length,
      consensus: false,
      error: 'Discrepancy detected between sources',
      discrepancies,
    };
  }

  return {
    verified: true,
    sourcesChecked: mappings.length,
    consensus: true,
  };
}

/**
 * Reset verifier state. Retained as a no-op for tests and hot reload callers.
 */
export function resetImageIdVerifierState(): void {
  // No concrete runtime state is owned by the verification package.
}

export const clearCache = resetImageIdVerifierState;

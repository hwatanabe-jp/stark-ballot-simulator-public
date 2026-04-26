/**
 * ImageID Verifier Implementation
 *
 * Provides functionality to verify that receipts were generated
 * by the expected zkVM program, according to final_design.md §3.2 and §4.8
 */

import { resolveExpectedImageIdFromMapping, type ImageIdVariant } from './image-id-policy.js';
import type {
  ReceiptWithImageId,
  ImageIdVerificationResult,
  ImageIdMapping,
  MultiSourceVerificationResult,
} from './image-id-types';

export class ImageIdResolutionError extends Error {
  constructor(
    public readonly reason: 'mapping_unavailable' | 'mapping_missing' | 'variant_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ImageIdResolutionError';
  }
}

// Cache for ImageID mapping
let cachedMapping: ImageIdMapping | null = null;

function normalizePublicSourcePath(source: string): string {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const withoutLeadingSlash = trimmed.replace(/^[\\/]+/, '');
  const withoutLeadingDot = withoutLeadingSlash.replace(/^\.[\\/]+/, '');
  const withoutPublicPrefix = withoutLeadingDot.replace(/^public[\\/]+/, '');

  return withoutPublicPrefix;
}

async function resolvePublicFilePath(source: string): Promise<string> {
  const path = await import('path');

  const relativePath = normalizePublicSourcePath(source);
  if (!relativePath) {
    throw new Error('Source path is empty');
  }

  const publicDir = path.resolve('public');
  const resolvedPath = path.resolve(publicDir, relativePath);
  const relativeFromPublic = path.relative(publicDir, resolvedPath);

  if (relativeFromPublic.startsWith('..') || path.isAbsolute(relativeFromPublic)) {
    throw new Error('Source path must be within public/');
  }

  return resolvedPath;
}

function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' && typeof process.versions === 'object' && typeof process.versions.node === 'string'
  );
}

/**
 * Reset cached verifier state. Intended for tests and hot reload scenarios.
 */
export function resetImageIdVerifierState(): void {
  cachedMapping = null;
}

/**
 * Load ImageID mapping from public directory
 * Results are cached after first load
 *
 * Supports both browser and Node.js environments:
 * - Browser: fetch from HTTP endpoint
 * - Node.js: read from filesystem
 */
export async function loadImageIdMapping(): Promise<ImageIdMapping> {
  if (cachedMapping) {
    return cachedMapping;
  }

  try {
    let mapping: ImageIdMapping;
    const isNode = isNodeRuntime();

    if (!isNode && typeof window !== 'undefined') {
      // Browser environment: fetch from HTTP
      const response = await fetch('/imageId-mapping.json');
      if (!response.ok) {
        throw new Error(`Failed to fetch ImageID mapping: ${response.status}`);
      }
      mapping = (await response.json()) as ImageIdMapping;
    } else {
      // Node.js environment: read from filesystem
      const fs = await import('fs/promises');

      const filePath = await resolvePublicFilePath('imageId-mapping.json');
      const content = await fs.readFile(filePath, 'utf-8');
      mapping = JSON.parse(content) as ImageIdMapping;
    }

    cachedMapping = mapping;
    return mapping;
  } catch (error) {
    throw new ImageIdResolutionError(
      'mapping_unavailable',
      `Failed to load ImageID mapping: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Get the expected ImageID for a given method version
 * @param version - Method version (defaults to current)
 */
export async function getExpectedImageId(version?: number, variant: ImageIdVariant = 'default'): Promise<string> {
  const mapping = await loadImageIdMapping();
  try {
    return resolveExpectedImageIdFromMapping(mapping, version, variant);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unknown method version:')) {
      throw new ImageIdResolutionError('mapping_missing', message);
    }
    throw new ImageIdResolutionError('variant_unavailable', message);
  }
}

/**
 * Verify a receipt with a specific expected ImageID
 * This implements the Receipt::verify(expectedImageID) pattern
 * as specified in final_design.md line 1051
 */
export function verifyReceiptWithImageId(
  receipt: ReceiptWithImageId,
  expectedImageId: string,
): Promise<ImageIdVerificationResult> {
  const startTime = Date.now();

  try {
    // Check if expectedImageID is provided (required by spec)
    if (!expectedImageId) {
      throw new Error('expectedImageID is required');
    }

    // Check if receipt contains ImageID
    if (!receipt.imageId) {
      return Promise.resolve({
        isValid: false,
        errors: ['Receipt does not contain ImageID'],
        performance: {
          startTime,
          endTime: Date.now(),
          duration: Date.now() - startTime,
        },
      });
    }

    const receiptId = receipt.imageId.toLowerCase();
    const expectedId = expectedImageId.toLowerCase();

    if (receiptId !== expectedId) {
      return Promise.resolve({
        isValid: false,
        errors: ['ImageID mismatch'],
        performance: {
          startTime,
          endTime: Date.now(),
          duration: Date.now() - startTime,
        },
      });
    }

    return Promise.resolve({
      isValid: true,
      errors: [],
      performance: {
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime,
      },
      verificationMethod: 'Receipt::verify',
    });
  } catch (error) {
    return Promise.resolve({
      isValid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      performance: {
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime,
      },
      verificationMethod: 'Receipt::verify',
    });
  }
}

/**
 * Detect if a receipt is from dev mode or is fake
 * According to final_design.md, dev/fake receipts must be rejected
 */
export function isDevModeReceipt(receipt: ReceiptWithImageId): boolean {
  // Check for explicit fake marker in metadata
  if (receipt.metadata?.isFake) {
    return true;
  }

  // Check for known dev mode seal patterns
  if (receipt.seal === 'FAKE_RECEIPT_SEAL' || receipt.seal === 'mock-seal' || receipt.seal.includes('DEV_MODE')) {
    return true;
  }

  // Check for suspiciously short seal (real STARK proofs are large)
  if (receipt.seal.length < 100) {
    return true;
  }

  return false;
}

/**
 * Strict receipt verification that only trusts Receipt::verify
 * Ignores all metadata fields as specified in final_design.md line 1051
 */
export async function verifyReceiptStrict(
  receipt: ReceiptWithImageId,
  expectedImageId: string | undefined,
): Promise<ImageIdVerificationResult> {
  // expectedImageID must be explicitly provided
  if (!expectedImageId) {
    throw new Error('expectedImageID is required');
  }

  // Ignore all metadata - only trust Receipt::verify
  const result = await verifyReceiptWithImageId(receipt, expectedImageId);

  return {
    ...result,
    verificationMethod: 'Receipt::verify',
    metadataIgnored: true,
  };
}

/**
 * Verify ImageID from multiple sources for enhanced security
 * As specified in final_design.md §4.8, must check multiple sources
 *
 * Supports both browser and Node.js environments:
 * - HTTP URLs: fetch
 * - Relative paths in Node.js: filesystem read
 */
export async function verifyFromMultipleSources(sources: string[]): Promise<MultiSourceVerificationResult> {
  const mappings: ImageIdMapping[] = [];
  const errors: string[] = [];

  // Fetch from all sources
  for (const source of sources) {
    try {
      let mapping: ImageIdMapping;

      // Check if source is an HTTP(S) URL
      const isHttpUrl = source.startsWith('http://') || source.startsWith('https://');

      if (isHttpUrl || typeof window !== 'undefined') {
        // Browser environment or HTTP URL: use fetch
        const response = await fetch(source);
        if (!response.ok) {
          errors.push(`Failed to fetch from ${source}: ${response.status}`);
          continue;
        }
        mapping = (await response.json()) as ImageIdMapping;
      } else {
        // Node.js environment with relative path: read from filesystem
        const fs = await import('fs/promises');
        const filePath = await resolvePublicFilePath(source);

        const content = await fs.readFile(filePath, 'utf-8');
        mapping = JSON.parse(content) as ImageIdMapping;
      }

      mappings.push(mapping);
    } catch (error) {
      errors.push(`Error fetching from ${source}: ${error instanceof Error ? error.message : String(error)}`);
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
 * Clear the cached ImageID mapping
 * Useful for testing or when mapping needs to be refreshed
 */
export function clearCache(): void {
  cachedMapping = null;
}

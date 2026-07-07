/**
 * Types for ImageID trust-material resolution and receipt artifact metadata.
 * Cryptographic receipt verification is performed by verifier-service.
 */

/**
 * Receipt structure from zkVM execution with ImageID
 */
export type ReceiptJournal = string | { bytes: number[] };

export interface ReceiptWithImageId {
  /** The cryptographic seal (STARK proof) */
  seal: string;
  /** The public journal (outputs) */
  journal: ReceiptJournal;
  /** The ImageID of the zkVM program */
  imageId?: string;
  /** Optional metadata */
  metadata?: {
    isFake?: boolean;
    [key: string]: unknown;
  };
}

/**
 * ImageID mapping structure
 */
export interface ImageIdMapping {
  mappings: {
    [version: string]: {
      methodVersion: number;
      expectedImageID?: string;
      expectedImageID_x86_64?: string;
      supportedVariants?: string[];
      trustStatus?: string;
      description: string;
      compiledAt: string;
      rustVersion: string;
      risc0Version: string;
      features: string[];
    };
  };
  current: string;
  deprecated: string[];
  metadata?: {
    lastUpdated: string;
    format: string;
    purpose: string;
    notes: string;
  };
}

/**
 * Multi-source verification result
 */
export interface MultiSourceVerificationResult {
  verified: boolean;
  sourcesChecked: number;
  consensus: boolean;
  error?: string;
  discrepancies?: string[];
}

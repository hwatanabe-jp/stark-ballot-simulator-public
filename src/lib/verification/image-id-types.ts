/**
 * Types for ImageID verification functionality
 * According to final_design.md §3.2 and §4.8
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
 * Result of ImageID verification
 */
export interface ImageIdVerificationResult {
  /** Whether the verification succeeded */
  isValid: boolean;
  /** Any errors encountered during verification */
  errors?: string[];
  /** Performance metrics */
  performance?: {
    startTime: number;
    endTime: number;
    duration: number;
  };
  /** Verification method used (should be 'Receipt::verify') */
  verificationMethod?: string;
  /** Whether metadata was ignored (for strict verification) */
  metadataIgnored?: boolean;
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

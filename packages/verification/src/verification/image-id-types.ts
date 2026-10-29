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

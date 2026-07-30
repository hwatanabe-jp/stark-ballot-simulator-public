export type ImageIdVariant = 'default' | 'x86_64';
export type ImageIdVariantResolutionReason = 'unknown_method' | 'variant_unconfirmed';

export interface UnconfirmedImageIdVariant {
  readonly state: 'unconfirmed';
  readonly requiredEvidence: 'accepted-prover-release';
}

export interface LocalGuestBuildProvenance {
  readonly evidenceType: 'local-guest-build';
  readonly compiledAt: string;
  readonly buildProfile: string;
  readonly hostRustVersion: string;
  readonly hostRustCommit: string;
  readonly risc0Version: string;
  readonly risc0Commit: string;
  readonly guestToolchain: string;
  readonly guestToolchainCommit: string;
  readonly guestElfSha256: string;
  readonly guestProgramBinarySha256: string;
  readonly hostBinarySha256: string;
  readonly zkvmCargoLockSha256: string;
}

export interface AcceptedProverReleaseProvenance {
  readonly evidenceType: 'accepted-prover-release';
  readonly sourceSha: string;
  readonly proverImageDigest: string;
  readonly candidateMetadataSha256: string;
  readonly releaseRecordSha256: string;
  readonly toolchainArtifactRecordSha256: string;
}

export type ImageIdProvenance = LocalGuestBuildProvenance | AcceptedProverReleaseProvenance;

export interface ConfirmedImageIdVariant {
  readonly state: 'confirmed';
  readonly imageId: string;
  readonly provenance: ImageIdProvenance;
}

export type ImageIdVariantAuthority = ConfirmedImageIdVariant | UnconfirmedImageIdVariant;

export interface ImageIdMethodMapping {
  readonly methodVersion: number;
  readonly variants: Readonly<Record<ImageIdVariant, ImageIdVariantAuthority>>;
  readonly description: string;
  readonly features: readonly string[];
}

export interface ImageIdMapping {
  readonly mappingType: 'image-id-mapping';
  readonly mappings: Readonly<Record<string, ImageIdMethodMapping>>;
  readonly current: string;
  readonly deprecated: readonly string[];
  readonly metadata: {
    readonly lastUpdated: string;
    readonly purpose: string;
    readonly notes: string;
  };
}

export class ImageIdMappingValidationError extends Error {}

export class ImageIdVariantResolutionError extends Error {
  public readonly reason: ImageIdVariantResolutionReason;
  public constructor(reason: ImageIdVariantResolutionReason, message: string);
}

export function parseImageIdMapping(value: unknown): ImageIdMapping;

export function resolveConfirmedImageIdVariant(
  mapping: ImageIdMapping,
  methodVersion: number | undefined,
  variant: ImageIdVariant,
): ConfirmedImageIdVariant;

declare const zkvmIdentifierBrand: unique symbol;

export type ZkvmIdentifier<Name extends string> = string & {
  readonly [zkvmIdentifierBrand]: Name;
};

export type ElectionId = ZkvmIdentifier<'ElectionId'>;
export type LogId = ZkvmIdentifier<'LogId'>;
export type ImageId = ZkvmIdentifier<'ImageId'>;
export type InputCommitment = ZkvmIdentifier<'InputCommitment'>;
export type VoteCommitment = ZkvmIdentifier<'VoteCommitment'>;
export type Randomness32 = ZkvmIdentifier<'Randomness32'>;
export type BulletinRoot = ZkvmIdentifier<'BulletinRoot'>;
export type ElectionConfigHash = ZkvmIdentifier<'ElectionConfigHash'>;
export type SthDigest = ZkvmIdentifier<'SthDigest'>;
export type SeenBitmapRoot = ZkvmIdentifier<'SeenBitmapRoot'>;
export type IncludedBitmapRoot = ZkvmIdentifier<'IncludedBitmapRoot'>;
export type MerkleNodeHash = ZkvmIdentifier<'MerkleNodeHash'>;

function brandIdentifier<Name extends string>(value: string): ZkvmIdentifier<Name> {
  return value as ZkvmIdentifier<Name>;
}

function asHex32Identifier<Name extends string>(value: string, fieldName: string): ZkvmIdentifier<Name> {
  if (!/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return brandIdentifier<Name>(value);
}

export function asElectionId(value: string): ElectionId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('electionId must be a UUID');
  }
  return brandIdentifier<'ElectionId'>(value);
}

export function asLogId(value: string): LogId {
  return asHex32Identifier<'LogId'>(value, 'logId');
}

export function asImageId(value: string): ImageId {
  return asHex32Identifier<'ImageId'>(value, 'imageId');
}

export function asInputCommitment(value: string): InputCommitment {
  return asHex32Identifier<'InputCommitment'>(value, 'inputCommitment');
}

export function asVoteCommitment(value: string): VoteCommitment {
  return asHex32Identifier<'VoteCommitment'>(value, 'commitment');
}

export function asRandomness32(value: string): Randomness32 {
  return asHex32Identifier<'Randomness32'>(value, 'random');
}

export function asBulletinRoot(value: string): BulletinRoot {
  const root = asHex32Identifier<'BulletinRoot'>(value, 'bulletinRoot');
  if (/^0x0{64}$/i.test(root)) {
    throw new Error('bulletinRoot must be non-zero');
  }
  return root;
}

export function asElectionConfigHash(value: string): ElectionConfigHash {
  return asHex32Identifier<'ElectionConfigHash'>(value, 'electionConfigHash');
}

export function asSthDigest(value: string): SthDigest {
  return asHex32Identifier<'SthDigest'>(value, 'sthDigest');
}

export function asSeenBitmapRoot(value: string): SeenBitmapRoot {
  return asHex32Identifier<'SeenBitmapRoot'>(value, 'seenBitmapRoot');
}

export function asIncludedBitmapRoot(value: string): IncludedBitmapRoot {
  return asHex32Identifier<'IncludedBitmapRoot'>(value, 'includedBitmapRoot');
}

export function asMerkleNodeHash(value: string): MerkleNodeHash {
  return asHex32Identifier<'MerkleNodeHash'>(value, 'merklePath node');
}

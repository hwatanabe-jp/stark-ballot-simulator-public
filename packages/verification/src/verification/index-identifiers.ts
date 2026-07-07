declare const verificationIndexBrand: unique symbol;

export type VerificationIndex<Name extends string> = number & {
  readonly [verificationIndexBrand]: Name;
};

export type VoteIndex = VerificationIndex<'VoteIndex'>;
export type BulletinIndex = VerificationIndex<'BulletinIndex'>;
export type LeafIndex = VerificationIndex<'LeafIndex'>;

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function brandIndex<Name extends string>(value: number): VerificationIndex<Name> {
  return value as VerificationIndex<Name>;
}

export function asVoteIndex(value: number): VoteIndex {
  assertNonNegativeSafeInteger(value, 'voteIndex');
  return brandIndex<'VoteIndex'>(value);
}

export function asBulletinIndex(value: number): BulletinIndex {
  assertNonNegativeSafeInteger(value, 'bulletinIndex');
  return brandIndex<'BulletinIndex'>(value);
}

export function asLeafIndex(value: number): LeafIndex {
  assertNonNegativeSafeInteger(value, 'leafIndex');
  return brandIndex<'LeafIndex'>(value);
}

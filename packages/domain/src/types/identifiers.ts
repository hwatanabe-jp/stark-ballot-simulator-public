declare const domainIdentifierBrand: unique symbol;
declare const domainNumberIdentifierBrand: unique symbol;

export type DomainIdentifier<Name extends string> = string & {
  readonly [domainIdentifierBrand]: Name;
};

export type DomainNumberIdentifier<Name extends string> = number & {
  readonly [domainNumberIdentifierBrand]: Name;
};

export type SessionId = DomainIdentifier<'SessionId'>;
export type CapabilityToken = DomainIdentifier<'CapabilityToken'>;
export type VoteIndex = DomainNumberIdentifier<'VoteIndex'>;
export type BulletinIndex = DomainNumberIdentifier<'BulletinIndex'>;
export type LeafIndex = DomainNumberIdentifier<'LeafIndex'>;

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9-]+$/;

function assertNonEmptyString(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function assertSafeSegment(value: string, label: string): void {
  assertNonEmptyString(value, label);
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, or hyphens`);
  }
}

function brandIdentifier<Name extends string>(value: string): DomainIdentifier<Name> {
  return value as DomainIdentifier<Name>;
}

function brandNumberIdentifier<Name extends string>(value: number): DomainNumberIdentifier<Name> {
  return value as DomainNumberIdentifier<Name>;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function asSessionId(value: string): SessionId {
  assertSafeSegment(value, 'sessionId');
  return brandIdentifier<'SessionId'>(value);
}

export function parseSessionId(value: unknown): SessionId | undefined {
  return typeof value === 'string' && SAFE_SEGMENT_PATTERN.test(value)
    ? brandIdentifier<'SessionId'>(value)
    : undefined;
}

export function asCapabilityToken(value: string): CapabilityToken {
  assertNonEmptyString(value, 'capabilityToken');
  return brandIdentifier<'CapabilityToken'>(value);
}

export function parseCapabilityToken(value: unknown): CapabilityToken | undefined {
  return typeof value === 'string' && value.length > 0 ? brandIdentifier<'CapabilityToken'>(value) : undefined;
}

export function asVoteIndex(value: number): VoteIndex {
  assertNonNegativeSafeInteger(value, 'voteIndex');
  return brandNumberIdentifier<'VoteIndex'>(value);
}

export function asBulletinIndex(value: number): BulletinIndex {
  assertNonNegativeSafeInteger(value, 'bulletinIndex');
  return brandNumberIdentifier<'BulletinIndex'>(value);
}

export function asLeafIndex(value: number): LeafIndex {
  assertNonNegativeSafeInteger(value, 'leafIndex');
  return brandNumberIdentifier<'LeafIndex'>(value);
}

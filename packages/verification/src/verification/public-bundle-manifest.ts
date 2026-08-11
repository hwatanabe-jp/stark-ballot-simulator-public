import publicBundleManifestJson from './public-bundle-manifest.json';

export type PublicBundleMode = 'sync' | 'async';

export interface PublicBundleModeManifest {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export interface PublicBundleManifest {
  readonly requiredInAllModes: readonly string[];
  readonly modes: Readonly<Record<PublicBundleMode, PublicBundleModeManifest>>;
  readonly neverPublic: readonly string[];
}

export interface PublicBundlePolicy {
  readonly mode: PublicBundleMode;
  readonly requiredMembers: readonly string[];
  readonly optionalMembers: readonly string[];
  readonly knownPublicMembers: readonly string[];
  readonly neverPublicMembers: readonly string[];
}

const MANIFEST_KEYS = ['requiredInAllModes', 'modes', 'neverPublic'] as const;
const MODE_KEYS = ['sync', 'async'] as const;
const MODE_MANIFEST_KEYS = ['required', 'optional'] as const;
const CANONICAL_MEMBER_PATTERN = /^[a-z0-9][a-z0-9-]*\.json$/;

function failManifest(reason: string): never {
  throw new Error(`Invalid public bundle manifest: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[], label: string): void {
  const actualKeys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    failManifest(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function parseMembers(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    failManifest(`${label} must be an array`);
  }

  const members = value.map((member, index) => {
    if (typeof member !== 'string' || !CANONICAL_MEMBER_PATTERN.test(member)) {
      failManifest(`${label}[${index}] must be a canonical root JSON filename`);
    }
    return member;
  });

  return Object.freeze(members);
}

function parseModeManifest(value: unknown, mode: PublicBundleMode): PublicBundleModeManifest {
  if (!isRecord(value)) {
    failManifest(`modes.${mode} must be an object`);
  }
  assertExactKeys(value, MODE_MANIFEST_KEYS, `modes.${mode}`);
  return Object.freeze({
    required: parseMembers(value['required'], `modes.${mode}.required`),
    optional: parseMembers(value['optional'], `modes.${mode}.optional`),
  });
}

function assertUniqueMembership(manifest: PublicBundleManifest): void {
  const publicMemberships = [
    ...manifest.requiredInAllModes,
    ...manifest.modes.sync.required,
    ...manifest.modes.sync.optional,
    ...manifest.modes.async.required,
    ...manifest.modes.async.optional,
  ];
  const publicMembersByCase = new Set<string>();
  for (const member of publicMemberships) {
    const caseKey = member.toLocaleLowerCase('en-US');
    if (publicMembersByCase.has(caseKey)) {
      failManifest(`public member is duplicated or case-conflicting: ${member}`);
    }
    publicMembersByCase.add(caseKey);
  }

  const privateMembersByCase = new Set<string>();
  for (const member of manifest.neverPublic) {
    const caseKey = member.toLocaleLowerCase('en-US');
    if (privateMembersByCase.has(caseKey)) {
      failManifest(`never-public member is duplicated or case-conflicting: ${member}`);
    }
    if (publicMembersByCase.has(caseKey)) {
      failManifest(`member cannot be both public and never-public: ${member}`);
    }
    privateMembersByCase.add(caseKey);
  }
}

export function parsePublicBundleManifest(value: unknown): PublicBundleManifest {
  if (!isRecord(value)) {
    failManifest('root must be an object');
  }
  assertExactKeys(value, MANIFEST_KEYS, 'root');
  const modesValue = value['modes'];
  if (!isRecord(modesValue)) {
    failManifest('modes must be an object');
  }
  assertExactKeys(modesValue, MODE_KEYS, 'modes');

  const manifest: PublicBundleManifest = Object.freeze({
    requiredInAllModes: parseMembers(value['requiredInAllModes'], 'requiredInAllModes'),
    modes: Object.freeze({
      sync: parseModeManifest(modesValue['sync'], 'sync'),
      async: parseModeManifest(modesValue['async'], 'async'),
    }),
    neverPublic: parseMembers(value['neverPublic'], 'neverPublic'),
  });
  assertUniqueMembership(manifest);
  return manifest;
}

export const PUBLIC_BUNDLE_MANIFEST = parsePublicBundleManifest(publicBundleManifestJson);

function collectKnownPublicMembers(manifest: PublicBundleManifest): readonly string[] {
  return Object.freeze([
    ...manifest.requiredInAllModes,
    ...manifest.modes.sync.required,
    ...manifest.modes.sync.optional,
    ...manifest.modes.async.required,
    ...manifest.modes.async.optional,
  ]);
}

export function resolvePublicBundlePolicy(mode: PublicBundleMode): PublicBundlePolicy {
  const modeManifest = PUBLIC_BUNDLE_MANIFEST.modes[mode];
  return Object.freeze({
    mode,
    requiredMembers: Object.freeze([...PUBLIC_BUNDLE_MANIFEST.requiredInAllModes, ...modeManifest.required]),
    optionalMembers: Object.freeze([...modeManifest.optional]),
    knownPublicMembers: collectKnownPublicMembers(PUBLIC_BUNDLE_MANIFEST),
    neverPublicMembers: Object.freeze([...PUBLIC_BUNDLE_MANIFEST.neverPublic]),
  });
}

export const RETIRED_PUBLIC_BOUNDARY_KEYS = new Set<string>([
  'missingIndices',
  'invalidIndices',
  'countedIndices',
  'excludedCount',
  'verificationBundleUrl',
  'verificationReportUrl',
  's3BundleUrl',
  's3BundleExpiresAt',
  's3BundleKey',
  's3ReportKey',
  's3UploadedAt',
  'refreshS3',
  'proofMode',
] as const);

export const PRIVATE_LOCATOR_KEYS = new Set<string>([
  'bundleMetadata',
  'bundleUrl',
  'reportUrl',
  'bundleKey',
  'reportKey',
  'signedUrl',
  'presignedUrl',
  'presignedURL',
  'rawS3Url',
  'rawS3URL',
] as const);

export const PRIVATE_OPENING_KEYS = new Set<string>(['random', 'rand'] as const);

export const PRIVATE_ARTIFACT_NAMES = new Set<string>([
  'input.json',
  'verification.json',
  'included-bitmap.json',
  'seen-bitmap.json',
] as const);

const STACK_LIKE_TEXT_PATTERN = /(?:^|\n)\s+at\s+.+:\d+:\d+|traceback \(most recent call last\):/i;
const RAW_PATH_PATTERN = /(?:^|\s)(?:\/(?:tmp|var|private)\/|[a-z]:\\)/i;
const RAW_S3_URL_PATTERN = /(?:s3:\/\/|https?:\/\/[^\s]+\.s3[.-][^\s]*amazonaws\.com)/i;
const SIGNED_URL_TEXT_PATTERN = /\b(?:presigned|signed url|x-amz-signature=|x-amz-credential=|awsaccesskeyid=)/i;
const PRIVATE_S3_KEY_PATTERN = /\bsessions\/[^/\s]+\/[^/\s]+\/(?:bundle\.zip|verification\.json)\b/i;
const CAPABILITY_TOKEN_MATERIAL_PATTERN = /\bv1\.[A-Za-z0-9_-]{8,}\.[a-f0-9]{64}\b/i;

export interface PublicBoundaryScanOptions {
  allowedCapabilityTokenPaths?: ReadonlySet<string>;
}

const DEFAULT_ALLOWED_CAPABILITY_TOKEN_PATHS = new Set<string>();

export function formatPublicBoundaryPath(segments: string[]): string {
  return segments.reduce((acc, seg) => {
    if (seg === '[]') {
      return `${acc}[]`;
    }
    if (!acc) {
      return seg;
    }
    return `${acc}.${seg}`;
  }, '');
}

export function collectRetiredPublicBoundaryPaths(value: unknown, base: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectRetiredPublicBoundaryPaths(entry, [...base, '[]']));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  return Object.keys(record).flatMap((key) => {
    const path = [...base, key];
    const nested = collectRetiredPublicBoundaryPaths(record[key], path);
    return RETIRED_PUBLIC_BOUNDARY_KEYS.has(key) ? [formatPublicBoundaryPath(path), ...nested] : nested;
  });
}

export function collectPublicBoundaryViolationPaths(
  value: unknown,
  base: string[] = [],
  options: PublicBoundaryScanOptions = {},
): string[] {
  if (typeof value === 'string') {
    return containsPrivateBoundaryText(value) ? [formatPublicBoundaryPath(base)] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectPublicBoundaryViolationPaths(entry, [...base, '[]'], options));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const allowedCapabilityTokenPaths = options.allowedCapabilityTokenPaths ?? DEFAULT_ALLOWED_CAPABILITY_TOKEN_PATHS;
  const record = value as Record<string, unknown>;
  return Object.keys(record).flatMap((key) => {
    const path = [...base, key];
    const formatted = formatPublicBoundaryPath(path);
    const nested = collectPublicBoundaryViolationPaths(record[key], path, options);
    const violations: string[] = [];

    if (PRIVATE_LOCATOR_KEYS.has(key)) {
      violations.push(formatted);
    }
    if (PRIVATE_OPENING_KEYS.has(key)) {
      violations.push(formatted);
    }
    if (isPrivateArtifactName(key)) {
      violations.push(formatted);
    }
    if (key === 'capabilityToken' && !allowedCapabilityTokenPaths.has(formatted)) {
      violations.push(formatted);
    }
    if (isContextualLocatorTimestamp(key, path, record)) {
      violations.push(formatted);
    }

    return [...violations, ...nested];
  });
}

function isPrivateArtifactName(value: string): boolean {
  return PRIVATE_ARTIFACT_NAMES.has(value.toLowerCase());
}

function isContextualLocatorTimestamp(key: string, path: string[], record: Record<string, unknown>): boolean {
  if (key !== 'uploadedAt' && key !== 'expiresAt') {
    return false;
  }
  const lowerPath = path.map((segment) => segment.toLowerCase());
  const isLocatorPath = lowerPath.some(
    (segment) =>
      segment.includes('s3') ||
      segment.includes('bundle') ||
      segment.includes('report') ||
      segment.includes('verifier') ||
      segment.includes('verification'),
  );
  if (isLocatorPath) {
    return true;
  }

  return Object.keys(record).some((siblingKey) => {
    if (siblingKey === key) {
      return false;
    }
    return PRIVATE_LOCATOR_KEYS.has(siblingKey) || RETIRED_PUBLIC_BOUNDARY_KEYS.has(siblingKey);
  });
}

function containsPrivateBoundaryText(value: string): boolean {
  const lowered = value.toLowerCase();
  return (
    Array.from(PRIVATE_ARTIFACT_NAMES).some((artifactName) => lowered.includes(artifactName)) ||
    STACK_LIKE_TEXT_PATTERN.test(value) ||
    RAW_PATH_PATTERN.test(value) ||
    RAW_S3_URL_PATTERN.test(value) ||
    SIGNED_URL_TEXT_PATTERN.test(value) ||
    PRIVATE_S3_KEY_PATTERN.test(value) ||
    CAPABILITY_TOKEN_MATERIAL_PATTERN.test(value)
  );
}

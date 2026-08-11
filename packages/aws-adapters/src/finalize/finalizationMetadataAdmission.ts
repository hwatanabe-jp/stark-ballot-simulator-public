import type { AwsVerificationDeliveryMetadataInput } from './finalizationDeliveryMetadataStore';
import type { AwsFinalizationBundleMetadata, AwsFinalizationRuntimeMetadata } from './finalizationRuntimeStore';

const BUNDLE_METADATA_KEYS = new Set(['s3BundleKey', 's3UploadedAtMs']);
const DELIVERY_METADATA_KEYS = new Set(['s3BundleKey', 's3ReportKey', 's3UploadedAtMs', 'verificationWorkQueuedAtMs']);
const RUNTIME_METADATA_KEYS = new Set(['stepFunctionsArn', 'bundleMetadata']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalNonEmptyString(value: Record<string, unknown>, key: string): string | undefined | null {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function optionalTimestamp(value: Record<string, unknown>, key: string): number | undefined | null {
  const candidate = value[key];
  if (candidate === undefined) {
    return undefined;
  }
  return isNonNegativeSafeInteger(candidate) ? candidate : null;
}

export function parseAwsFinalizationBundleMetadata(value: unknown): AwsFinalizationBundleMetadata | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, BUNDLE_METADATA_KEYS)) {
    return undefined;
  }
  const s3BundleKey = optionalNonEmptyString(value, 's3BundleKey');
  const s3UploadedAtMs = optionalTimestamp(value, 's3UploadedAtMs');
  if (s3BundleKey === null || s3UploadedAtMs === null) {
    return undefined;
  }
  return {
    ...(s3BundleKey === undefined ? {} : { s3BundleKey }),
    ...(s3UploadedAtMs === undefined ? {} : { s3UploadedAtMs }),
  };
}

export function parseRequiredAwsFinalizationBundleMetadata(
  value: unknown,
): Required<AwsFinalizationBundleMetadata> | undefined {
  const metadata = parseAwsFinalizationBundleMetadata(value);
  return metadata?.s3BundleKey !== undefined && metadata.s3UploadedAtMs !== undefined
    ? {
        s3BundleKey: metadata.s3BundleKey,
        s3UploadedAtMs: metadata.s3UploadedAtMs,
      }
    : undefined;
}

export function parseAwsVerificationDeliveryMetadata(value: unknown): AwsVerificationDeliveryMetadataInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, DELIVERY_METADATA_KEYS)) {
    return undefined;
  }
  const s3BundleKey = optionalNonEmptyString(value, 's3BundleKey');
  const s3ReportKey = optionalNonEmptyString(value, 's3ReportKey');
  const s3UploadedAtMs = optionalTimestamp(value, 's3UploadedAtMs');
  const verificationWorkQueuedAtMs = optionalTimestamp(value, 'verificationWorkQueuedAtMs');
  if (s3BundleKey === null || s3ReportKey === null || s3UploadedAtMs === null || verificationWorkQueuedAtMs === null) {
    return undefined;
  }
  return {
    ...(s3BundleKey === undefined ? {} : { s3BundleKey }),
    ...(s3ReportKey === undefined ? {} : { s3ReportKey }),
    ...(s3UploadedAtMs === undefined ? {} : { s3UploadedAtMs }),
    ...(verificationWorkQueuedAtMs === undefined ? {} : { verificationWorkQueuedAtMs }),
  };
}

export function parseAwsFinalizationRuntimeMetadata(value: unknown): AwsFinalizationRuntimeMetadata | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, RUNTIME_METADATA_KEYS)) {
    return undefined;
  }
  const stepFunctionsArn = optionalNonEmptyString(value, 'stepFunctionsArn');
  const bundleMetadata =
    value['bundleMetadata'] === undefined ? undefined : parseAwsFinalizationBundleMetadata(value['bundleMetadata']);
  if (stepFunctionsArn === null || (value['bundleMetadata'] !== undefined && bundleMetadata === undefined)) {
    return undefined;
  }
  return {
    ...(stepFunctionsArn === undefined ? {} : { stepFunctionsArn }),
    ...(bundleMetadata === undefined ? {} : { bundleMetadata }),
  };
}

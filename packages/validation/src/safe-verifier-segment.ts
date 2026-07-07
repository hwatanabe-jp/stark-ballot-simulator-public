export const SAFE_VERIFIER_SEGMENT_PATTERN = /^[A-Za-z0-9-]+$/;

export function isSafeVerifierSegment(value: string): boolean {
  return SAFE_VERIFIER_SEGMENT_PATTERN.test(value);
}

export function assertSafeVerifierSegment(value: string, label: string): void {
  if (!isSafeVerifierSegment(value)) {
    throw new Error(`${label} must be a safe single path segment`);
  }
}

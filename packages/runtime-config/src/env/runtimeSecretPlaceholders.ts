export const UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER = '<value will be resolved during runtime>';

export function isUnresolvedRuntimeSecretPlaceholder(value: string | undefined | null): boolean {
  return value?.trim() === UNRESOLVED_RUNTIME_SECRET_PLACEHOLDER;
}

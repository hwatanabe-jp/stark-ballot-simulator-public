export const AMPLIFY_RUNTIME_SECRET_PLACEHOLDER = '<value will be resolved during runtime>';

export function isUnresolvedAmplifySecret(value: string | undefined | null): boolean {
  return value?.trim() === AMPLIFY_RUNTIME_SECRET_PLACEHOLDER;
}

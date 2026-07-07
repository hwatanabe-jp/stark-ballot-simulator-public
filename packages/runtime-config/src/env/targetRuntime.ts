export function isTargetAwsRuntime(): boolean {
  return process.env['TARGET_AWS_RUNTIME'] === '1';
}

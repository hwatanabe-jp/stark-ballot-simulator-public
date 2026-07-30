export type RuntimeConfigName = Uppercase<string>;

const RUNTIME_CONFIG_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export class RuntimeConfigValidationError extends Error {
  readonly invalidNames: readonly RuntimeConfigName[];

  constructor(
    invalidNames: readonly RuntimeConfigName[],
    cause?: unknown,
    message = 'Runtime configuration validation failed',
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RuntimeConfigValidationError';
    this.invalidNames = [
      ...new Set(invalidNames.filter((name) => typeof name === 'string' && RUNTIME_CONFIG_NAME_PATTERN.test(name))),
    ];
  }
}

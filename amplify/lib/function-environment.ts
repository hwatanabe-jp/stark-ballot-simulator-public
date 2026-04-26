import { secret } from '@aws-amplify/backend';

export type AmplifySecretRef = ReturnType<typeof secret>;
export type AmplifyFunctionEnvironmentValue = string | AmplifySecretRef | undefined;

export interface AmplifyFunctionEnvironmentTarget {
  addEnvironment: (key: string, value: string | AmplifySecretRef) => void;
}

export interface ResolveSecretBackedEnvOptions {
  required?: boolean;
}

export function resolveSecretBackedEnv(
  key: string,
  options: ResolveSecretBackedEnvOptions = {},
): string | AmplifySecretRef | undefined {
  const required = options.required ?? true;

  if (!required) {
    return undefined;
  }

  return secret(key);
}

export function addFunctionEnvironments(
  target: AmplifyFunctionEnvironmentTarget,
  entries: Record<string, AmplifyFunctionEnvironmentValue>,
): void {
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string') {
      if (value.length > 0) {
        target.addEnvironment(key, value);
      }
      continue;
    }

    if (value) {
      target.addEnvironment(key, value);
    }
  }
}

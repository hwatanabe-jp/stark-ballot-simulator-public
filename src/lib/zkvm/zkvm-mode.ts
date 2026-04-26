import { shouldUseMockZkVM } from './mock-executor';

export interface ZkvmModeFlags {
  envUseMock: boolean;
  useMock: boolean;
  devMode: boolean;
  forceDevMode: boolean;
  insecure: boolean;
}

export const INSECURE_ZKVM_MODE_MESSAGE =
  'Insecure zkVM mode is not allowed in production. Disable USE_MOCK_ZKVM, RISC0_DEV_MODE, and FORCE_DEV_MODE, or set ALLOW_INSECURE_ZKVM=true for CI/tests only.';

export interface ZkvmModeOptions {
  useMock?: boolean;
}

export function resolveZkvmMode(options: ZkvmModeOptions = {}): ZkvmModeFlags {
  const envUseMock = process.env.USE_MOCK_ZKVM === 'true';
  const forceDevMode = process.env.FORCE_DEV_MODE === 'true';
  const devMode = process.env.RISC0_DEV_MODE === '1' || forceDevMode;
  const useMock = options.useMock ?? shouldUseMockZkVM();
  const insecure = envUseMock || useMock || devMode;

  return {
    envUseMock,
    useMock,
    devMode,
    forceDevMode,
    insecure,
  };
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function allowInsecureZkvmInProduction(): boolean {
  return process.env.ALLOW_INSECURE_ZKVM === 'true';
}

export function getZkvmModeViolation(mode: ZkvmModeFlags): string | null {
  if (!mode.insecure) {
    return null;
  }

  if (isProductionEnv() && !allowInsecureZkvmInProduction()) {
    return INSECURE_ZKVM_MODE_MESSAGE;
  }

  return null;
}

export function assertZkvmModeAllowed(mode: ZkvmModeFlags): void {
  const violation = getZkvmModeViolation(mode);
  if (violation) {
    throw new Error(violation);
  }
}

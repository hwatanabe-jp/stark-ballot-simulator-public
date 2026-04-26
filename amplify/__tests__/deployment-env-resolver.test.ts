/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  assertRequiredDeploymentEnvVars,
  resolveDeploymentEnv,
  type DeploymentEnv,
} from '../lib/deployment-env-resolver';

describe('resolveDeploymentEnv', () => {
  it.each<[string, NodeJS.ProcessEnv, DeploymentEnv]>([
    ['main from AWS_BRANCH', { AWS_BRANCH: 'main' }, 'main'],
    ['develop from AWS_BRANCH', { AWS_BRANCH: 'develop' }, 'develop'],
    ['main alias from AWS_BRANCH', { AWS_BRANCH: 'production' }, 'main'],
    ['develop alias from AWS_BRANCH', { AWS_BRANCH: 'dev' }, 'develop'],
    ['ignores conflicting ENV_NAME marker', { AWS_BRANCH: 'develop', ENV_NAME: 'production' }, 'develop'],
    ['ignores conflicting AMPLIFY_BRANCH marker', { AWS_BRANCH: 'main', AMPLIFY_BRANCH: 'develop' }, 'main'],
    [
      'ignores unsupported optional markers',
      { AWS_BRANCH: 'main', AMPLIFY_BRANCH: 'feature/security-fix', ENV_NAME: 'unexpected' },
      'main',
    ],
  ])('%s', (_label, env, expected) => {
    expect(resolveDeploymentEnv(env)).toBe(expected);
  });

  it('throws when AWS_BRANCH is missing', () => {
    expect(() => resolveDeploymentEnv({ AMPLIFY_BRANCH: 'develop', ENV_NAME: 'develop' })).toThrow(
      /missing required deployment environment variables/i,
    );
  });

  it('throws when AWS_BRANCH is unsupported', () => {
    expect(() => resolveDeploymentEnv({ AWS_BRANCH: 'feature/security-fix' })).toThrow(
      /unsupported deployment environment marker/i,
    );
  });
});

describe('assertRequiredDeploymentEnvVars', () => {
  it('passes when AWS_BRANCH is present', () => {
    expect(() =>
      assertRequiredDeploymentEnvVars({
        AWS_BRANCH: 'develop',
      }),
    ).not.toThrow();
  });

  it('throws when AWS_BRANCH is missing', () => {
    expect(() =>
      assertRequiredDeploymentEnvVars({
        AMPLIFY_BRANCH: 'develop',
        ENV_NAME: 'develop',
      }),
    ).toThrow(/missing required deployment environment variables/i);
  });

  it('treats blank AWS_BRANCH as missing', () => {
    expect(() =>
      assertRequiredDeploymentEnvVars({
        AWS_BRANCH: ' ',
        ENV_NAME: 'develop',
      }),
    ).toThrow(/missing required deployment environment variables/i);
  });
});

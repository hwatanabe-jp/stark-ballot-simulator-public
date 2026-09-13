import { expect, it, vi } from 'vitest';
import { productionConfigurationFixture } from './test-support/deployment-target-fixtures.js';

it('selects only the reviewed target matching the running build and AWS caller', async () => {
  const { configuration } = productionConfigurationFixture();
  vi.resetModules();
  vi.doMock('../deployment-targets.json', () => ({ default: configuration }));
  try {
    const authority = await import('./index.js');
    for (const targetKey of ['stark-dev/develop', 'stark-prod/main']) {
      const target = authority.resolveAllowedDeploymentTarget(targetKey);
      for (const [lane, projectKey, roleKey] of [
        ['bootstrap', 'terraformPlanProject', 'terraformPlanRole'],
        ['bootstrap', 'terraformApplyProject', 'terraformApplyRole'],
        ['bootstrap', 'smokeProject', 'terraformSmokeRole'],
        ['foundation', 'terraformPlanProject', 'terraformPlanRole'],
        ['prover', 'foundationSigningResolverProject', 'foundationSigningResolverRole'],
        ['app', 'appExecutionAuthorityProject', 'appExecutionAuthorityRole'],
        ['app', 'appDeploymentStatusPublisherProject', 'appDeploymentStatusPublisherRole'],
        ['toolchain', 'toolchainCandidateProject', 'toolchainCandidateRole'],
        ['prover', 'proverCandidateProject', 'proverCandidateRole'],
      ] as const) {
        const names = authority.resolveDeploymentLaneAuthority(target, lane).names;
        const project = names[projectKey];
        const role = names[roleKey];
        const buildId = `${project}:11111111-2222-3333-4444-555555555555`;
        const input = {
          lane,
          projectKey,
          roleKey,
          region: target.region,
          buildId,
          buildArn: `arn:${target.partition}:codebuild:${target.region}:${target.accountId}:build/${buildId}`,
          callerIdentity: {
            Account: target.accountId,
            Arn: `arn:${target.partition}:sts::${target.accountId}:assumed-role/${role}/codebuild-session`,
            UserId: ['AROA', 'ABCDEFGHIJKLMNOPQ', ':codebuild-session'].join(''),
          },
        };
        expect(authority.resolveCodeBuildDeploymentTarget(input)).toEqual(target);
        expect(Object.isFrozen(authority.resolveCodeBuildDeploymentTarget(input))).toBe(true);
        const other = authority.resolveAllowedDeploymentTarget(
          targetKey === 'stark-dev/develop' ? 'stark-prod/main' : 'stark-dev/develop',
        );
        for (const detached of [
          { ...input, region: 'us-east-1' },
          { ...input, buildId: `${project}:not-a-build-id` },
          { ...input, buildId: `${project}-other:11111111-2222-3333-4444-555555555555` },
          { ...input, buildArn: input.buildArn.replace(target.accountId, other.accountId) },
          { ...input, projectKey: 'unknownProject' },
          { ...input, roleKey: 'unknownRole' },
          { ...input, callerIdentity: { ...input.callerIdentity, Account: other.accountId } },
          {
            ...input,
            callerIdentity: {
              ...input.callerIdentity,
              Arn: input.callerIdentity.Arn.replace(target.accountId, other.accountId),
            },
          },
          {
            ...input,
            callerIdentity: {
              ...input.callerIdentity,
              Arn: input.callerIdentity.Arn.replace(`/${role}/`, '/other-role/'),
            },
          },
          { ...input, callerIdentity: { ...input.callerIdentity, UserId: 'AROATEST:another-session' } },
          { ...input, targetKey: other.targetKey },
        ])
          expect(() => authority.resolveCodeBuildDeploymentTarget(detached)).toThrow();
        for (const userId of [
          'A:codebuild-session',
          'AROATEST:codebuild-session',
          'AKIAABCDEFGHIJKLMNOPQ:codebuild-session',
          input.callerIdentity.UserId.replace('codebuild-session', 'other-session'),
        ]) {
          expect(() =>
            authority.resolveCodeBuildDeploymentTarget({
              ...input,
              callerIdentity: { ...input.callerIdentity, UserId: userId },
            }),
          ).toThrow();
        }
        if (target.environmentId === 'main') {
          expect(() => authority.resolveCodeBuildDeploymentTarget({ ...input, lane: 'static-fast' })).toThrow();
        }
      }
    }
  } finally {
    vi.doUnmock('../deployment-targets.json');
    vi.resetModules();
  }
});

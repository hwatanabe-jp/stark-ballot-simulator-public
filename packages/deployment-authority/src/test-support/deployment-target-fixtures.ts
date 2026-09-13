import deploymentTargetConfiguration from '../../deployment-targets.json' with { type: 'json' };

interface MutableTargetFixture {
  accountId: string;
  accountLabel: string;
  artifactNamespace: string;
  environmentId: string;
  environmentTier: string;
  operatorPermissionSetName: string;
  lanes: Record<
    string,
    {
      backendKey: string;
      names: Record<string, string>;
      scope: string;
      stateIdentity: string;
    }
  >;
  productionPolicy?: { bootstrapApprovalAction: string; foundationPublicSubnetException: string };
  projectId: string;
  region: string;
  repository: string;
  repositoryUrl: string;
  resourcePrefix: string;
  sharedNames: Record<string, string | Record<string, string>>;
  sourceBranch: string;
  stateNamespace: string;
  targetKey: string;
}

interface MutableConfigurationFixture {
  allowedTargets: Record<string, MutableTargetFixture>;
}

export function cloneDeploymentTargetConfiguration(): unknown {
  return structuredClone(deploymentTargetConfiguration);
}

export function mutableDeploymentTargetConfiguration(): MutableConfigurationFixture {
  return cloneDeploymentTargetConfiguration() as MutableConfigurationFixture;
}

export function productionConfigurationFixture(): {
  configuration: MutableConfigurationFixture;
  development: MutableTargetFixture;
  production: MutableTargetFixture;
} {
  const configuration = mutableDeploymentTargetConfiguration();
  const development = configuration.allowedTargets['stark-dev/develop'];
  if (development === undefined) throw new Error('Missing development fixture.');
  const production = JSON.parse(
    JSON.stringify(development)
      .replaceAll('stark-dev', 'stark-prod')
      .replaceAll('stark_dev', 'stark_prod')
      .replaceAll('develop', 'main')
      .replaceAll(development.accountId, '111111111111'),
  ) as MutableTargetFixture;
  production.environmentTier = 'production';
  production.productionPolicy = {
    bootstrapApprovalAction: 'ApproveBootstrapApply',
    foundationPublicSubnetException: 'accepted-for-production-prover-egress',
  };
  delete production.lanes['static-fast'];
  for (const key of Object.keys(production.sharedNames)) {
    if (key.startsWith('appStaticFast')) delete production.sharedNames[key];
  }
  configuration.allowedTargets['stark-prod/main'] = production;
  return { configuration, development, production };
}

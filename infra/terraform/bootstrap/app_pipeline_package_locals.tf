locals {
  app_codebuild_release_resolution_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{variables.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SELECTED_ACCEPTANCE_KEY"
      value = "#{variables.SelectedAcceptanceKey}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_RELEASE_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
  ])
  app_signature_preflight_plan_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{variables.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_REQUESTED_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_PROVER_IMAGE_URI"
      value = "#{ReleaseResolution.ProverImageUri}"
      type  = "PLAINTEXT"
    },
  ])
  app_signature_preflight_apply_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{variables.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_REQUESTED_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_PROVER_IMAGE_URI"
      value = "#{ReleaseResolution.ProverImageUri}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
  ])
  app_signature_preflight_invoke_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{variables.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_REQUESTED_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PREFLIGHT_PROVER_IMAGE_URI"
      value = "#{ReleaseResolution.ProverImageUri}"
      type  = "PLAINTEXT"
    },
  ])
  app_codebuild_deployment_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{PlanAppState.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_DYNAMODB_RECOVERY_PHASE"
      value = "#{variables.DynamoDbRecoveryPhase}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_EXECUTION_AUTHORITY_SHA256"
      value = "#{PlanAppState.AppExecutionAuthoritySha256}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SOURCE_SHA"
      value = "#{PlanAppState.AppSourceSha}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_DEPLOYMENT_ID"
      value = "#{PlanAppState.DeploymentId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_STATIC_FAST_MODE"
      value = "false"
      type  = "PLAINTEXT"
    },
  ])
  app_codebuild_plan_env_variables = jsonencode(concat(
    [
      {
        name  = "APP_DEPLOYMENT_MODE"
        value = "#{variables.DeploymentMode}"
        type  = "PLAINTEXT"
      },
      {
        name  = "APP_DYNAMODB_RECOVERY_PHASE"
        value = "#{variables.DynamoDbRecoveryPhase}"
        type  = "PLAINTEXT"
      },
      {
        name  = "APP_PIPELINE_EXECUTION_ID"
        value = "#{codepipeline.PipelineExecutionId}"
        type  = "PLAINTEXT"
      },
    ],
    [
      {
        name  = "DynamoDbRecoveryManifestKey"
        value = "#{variables.DynamoDbRecoveryManifestKey}"
        type  = "PLAINTEXT"
      },
      {
        name  = "DynamoDbRecoveryManifestVersionId"
        value = "#{variables.DynamoDbRecoveryManifestVersionId}"
        type  = "PLAINTEXT"
      },
      {
        name  = "DynamoDbRecoveryManifestSha256"
        value = "#{variables.DynamoDbRecoveryManifestSha256}"
        type  = "PLAINTEXT"
      },
    ],
  ))
  app_codebuild_apply_env_variables = jsonencode(concat(
    [
      for variable in jsondecode(local.app_codebuild_deployment_env_variables) :
      variable if variable.name != "APP_STATIC_FAST_MODE"
    ],
    [
      {
        name  = "DynamoDbRecoveryManifestKey"
        value = "#{variables.DynamoDbRecoveryManifestKey}"
        type  = "PLAINTEXT"
      },
      {
        name  = "DynamoDbRecoveryManifestVersionId"
        value = "#{variables.DynamoDbRecoveryManifestVersionId}"
        type  = "PLAINTEXT"
      },
      {
        name  = "DynamoDbRecoveryManifestSha256"
        value = "#{variables.DynamoDbRecoveryManifestSha256}"
        type  = "PLAINTEXT"
      },
    ],
  ))
}

locals {
  app_codebuild_source_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{variables.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SELECTED_DEPLOYMENT_RECORD_KEY"
      value = "#{variables.SelectedDeploymentRecordKey}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SELECTED_DEPLOYMENT_RECORD_VERSION_ID"
      value = "#{variables.SelectedDeploymentRecordVersionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SELECTED_DEPLOYMENT_RECORD_SHA256"
      value = "#{variables.SelectedDeploymentRecordSha256}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_FOUNDATION_APP_NETWORKING_KEY"
      value = "#{variables.FoundationAppNetworkingKey}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_FOUNDATION_APP_NETWORKING_VERSION_ID"
      value = "#{variables.FoundationAppNetworkingVersionId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_FOUNDATION_APP_NETWORKING_SHA256"
      value = "#{variables.FoundationAppNetworkingSha256}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
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
  ])
  app_signature_state_refresh_plan_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{variables.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_STATE_REFRESH_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SELECTED_APPLICATION_SOURCE_SHA"
      value = "#{variables.SelectedApplicationSourceSha}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_STATE_REFRESH_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
      type  = "PLAINTEXT"
    },
  ])
  app_signature_state_refresh_apply_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{variables.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_STATE_REFRESH_SOURCE_SHA"
      value = "#{AppSource.CommitId}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_STATE_REFRESH_PIPELINE_EXECUTION_ID"
      value = "#{codepipeline.PipelineExecutionId}"
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
      value = "#{VerifierPreflightPlan.ProverImageUri}"
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
      value = "#{VerifierPreflightPlan.ProverImageUri}"
      type  = "PLAINTEXT"
    },
  ])
  app_codebuild_deployment_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{AppDeploymentRecord.DeploymentMode}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_DYNAMODB_RECOVERY_PHASE"
      value = "#{variables.DynamoDbRecoveryPhase}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_DEPLOYMENT_RECORD_SHA256"
      value = "#{AppDeploymentRecord.AppDeploymentRecordSha256}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_SOURCE_SHA"
      value = "#{AppDeploymentRecord.AppSourceSha}"
      type  = "PLAINTEXT"
    },
    {
      name  = "APP_DEPLOYMENT_ID"
      value = "#{AppDeploymentRecord.DeploymentId}"
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

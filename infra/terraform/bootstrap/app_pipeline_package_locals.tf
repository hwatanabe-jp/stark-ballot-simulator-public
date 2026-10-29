locals {
  app_codebuild_release_resolution_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "normal"
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
  app_codebuild_deployment_env_variables = jsonencode([
    {
      name  = "APP_DEPLOYMENT_MODE"
      value = "#{PlanAppState.DeploymentMode}"
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
  ])
  app_codebuild_plan_env_variables = jsonencode(concat(
    [
      { name = "DEPLOYMENT_INITIAL_PUBLICATION", value = "#{variables.InitialPublication}", type = "PLAINTEXT" },
      { name = "APP_SOURCE_SHA", value = "#{AppSource.CommitId}", type = "PLAINTEXT" },
      {
        name  = "APP_DEPLOYMENT_MODE"
        value = "normal"
        type  = "PLAINTEXT"
      },
      {
        name  = "APP_PIPELINE_EXECUTION_ID"
        value = "#{codepipeline.PipelineExecutionId}"
        type  = "PLAINTEXT"
      },
    ],
  ))
  app_codebuild_apply_env_variables = local.app_codebuild_deployment_env_variables
}

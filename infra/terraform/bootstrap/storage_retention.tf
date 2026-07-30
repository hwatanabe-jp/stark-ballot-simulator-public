locals {
  storage_retention_by_environment = {
    develop = {
      state_noncurrent_days               = 90
      bootstrap_pipeline_artifact_days    = 30
      foundation_pipeline_artifact_days   = 90
      app_pipeline_artifact_days          = 30
      app_pipeline_cache_days             = 30
      app_accepted_authority_days         = 180
      bootstrap_codebuild_log_days        = 30
      foundation_codebuild_log_days       = 365
      app_codebuild_log_days              = 180
      incomplete_multipart_retention_days = 7
    }
    main = {
      state_noncurrent_days               = 365
      bootstrap_pipeline_artifact_days    = 90
      foundation_pipeline_artifact_days   = 90
      app_pipeline_artifact_days          = 90
      app_pipeline_cache_days             = 30
      app_accepted_authority_days         = 365
      bootstrap_codebuild_log_days        = 365
      foundation_codebuild_log_days       = 365
      app_codebuild_log_days              = 365
      incomplete_multipart_retention_days = 7
    }
  }

  storage_retention = local.storage_retention_by_environment[var.deployment_environment]
}

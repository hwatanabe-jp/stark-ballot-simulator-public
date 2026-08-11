moved {
  from = aws_cloudwatch_log_group.pipeline_codebuild
  to   = module.bootstrap_pipeline_codebuild_log_groups.aws_cloudwatch_log_group.this
}

moved {
  from = aws_cloudwatch_log_group.foundation_pipeline_codebuild
  to   = module.foundation_pipeline_codebuild_log_groups.aws_cloudwatch_log_group.this
}

moved {
  from = aws_cloudwatch_log_group.app_pipeline_codebuild
  to   = module.app_pipeline_codebuild_log_groups.aws_cloudwatch_log_group.this
}

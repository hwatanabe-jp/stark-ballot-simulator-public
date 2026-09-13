data "aws_iam_policy_document" "app_initialization_execution_read" {
  count = local.app_pipeline_enabled && local.deployment_target.environmentId == "main" ? 1 : 0

  statement {
    sid       = "ReadExplicitAppInitializationExecution"
    effect    = "Allow"
    actions   = ["codepipeline:GetPipelineExecution"]
    resources = [local.app_pipeline_arn]
  }
}

data "aws_iam_policy_document" "app_initialization_absence_read" {
  count = local.app_pipeline_enabled && local.deployment_target.environmentId == "main" ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["s3:GetBucketVersioning"]
    resources = [aws_s3_bucket.state.arn, local.app_retained_artifact_bucket_arn]
  }

  dynamic "statement" {
    for_each = {
      state      = { bucket = aws_s3_bucket.state.arn, key = local.app_state_backend_key }
      acceptance = { bucket = local.app_retained_artifact_bucket_arn, key = local.deployment_shared_names.acceptedDeploymentPointerKey }
    }
    content {
      effect    = "Allow"
      actions   = ["s3:ListBucketVersions"]
      resources = [statement.value.bucket]
      condition {
        test     = "StringEquals"
        variable = "s3:prefix"
        values   = [statement.value.key]
      }
      condition {
        test     = "NumericEquals"
        variable = "s3:max-keys"
        values   = ["1"]
      }
      dynamic "condition" {
        for_each = statement.key == "state" ? [true] : []
        content {
          test     = "StringEquals"
          variable = "s3:delimiter"
          values   = ["."]
        }
      }
    }
  }
}

data "aws_iam_policy_document" "app_initial_acceptance_absence_read" {
  count = local.app_pipeline_enabled && local.deployment_target.environmentId == "main" ? 1 : 0

  statement {
    effect    = "Allow"
    actions   = ["s3:GetBucketVersioning"]
    resources = [local.app_retained_artifact_bucket_arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucketVersions"]
    resources = [local.app_retained_artifact_bucket_arn]
    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = [local.deployment_shared_names.acceptedDeploymentPointerKey]
    }
    condition {
      test     = "NumericEquals"
      variable = "s3:max-keys"
      values   = ["1"]
    }
  }
}

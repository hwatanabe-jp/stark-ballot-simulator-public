data "aws_iam_policy_document" "foundation_smoke_deploy_permissions_boundary" {
  count                   = local.foundation_pipeline_enabled ? 1 : 0
  source_policy_documents = concat([data.aws_iam_policy_document.foundation_gateway_logging_read.json], [data.aws_iam_policy_document.foundation_retained_image_logs_read.json])

  # Keep this ceiling independent of resources whose key policies trust the
  # smoke role. The attached identity policies narrow these guardrails to the
  # exact KMS keys and log streams after IAM intersects the two policy layers.
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
    resources = ["${local.deployment_record_prefixes.foundation}/*"]
  }
  statement {
    actions   = ["s3:ListBucketVersions"]
    resources = [local.deployment_record_roots.foundation.bucket]
  }

  statement {
    actions   = ["codebuild:BatchGetBuilds"]
    resources = ["arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.managed_codebuild_executions.foundation_terraform_smoke.project}"]
  }
  statement {
    actions   = ["codepipeline:ListActionExecutions", "codepipeline:GetPipelineExecution"]
    resources = ["arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.managed_codebuild_executions.foundation_terraform_smoke.pipeline}"]
  }

  statement {
    sid    = "FoundationSmokeBuildLogsGuardrail"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "FoundationSmokeCallerIdentityGuardrail"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }


  statement {
    sid    = "FoundationSmokePipelineArtifactsGuardrail"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}",
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}/*",
    ]
  }

  statement {
    sid    = "FoundationSmokeKmsGuardrail"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]
  }


  statement {
    sid    = "FoundationAcceptancePublisherGuardrail"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [
      local.foundation_checkpoint_object_arn,
    ]
  }

  statement {
    sid       = "FoundationSmokeSigningConfigurationReadGuardrail"
    effect    = "Allow"
    actions   = ["ecr:GetSigningConfiguration"]
    resources = ["*"]
  }

  statement {
    sid    = "FoundationSmokeRetentionReadGuardrail"
    effect = "Allow"
    actions = [
      "ecr:GetLifecyclePolicy",
      "s3:GetBucketPolicy",
      "s3:GetBucketVersioning",
      "s3:GetLifecycleConfiguration",
    ]
    resources = concat(
      [local.foundation_release_manifest_bucket_arn],
      local.foundation_ecr_repository_arns,
    )
  }

  statement {
    sid    = "FoundationSmokeTerraformAuthorityReadGuardrail"
    effect = "Allow"
    actions = [
      "s3:GetBucketPolicy",
      "s3:GetBucketVersioning",
    ]
    resources = [local.terraform_authority_bucket_arn]
  }

  statement {
    sid    = "FoundationSmokeApplyRetentionBoundaryReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_apply_role_name}",
    ]
  }

  statement {
    sid    = "FoundationSmokeApplyRetentionBoundaryPolicyReadGuardrail"
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
    ]
    resources = [
      local.foundation_apply_deploy_permissions_boundary_policy_arn,
      local.foundation_terraform_apply_workload_policy_arn,
    ]
  }

}

resource "aws_iam_policy" "foundation_smoke_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0


  name   = local.foundation_smoke_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.foundation_smoke_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    precondition {
      condition = (
        length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_smoke_deploy_permissions_boundary[0].json))) <= 6144
      )
      error_message = "Foundation smoke permissions boundary exceeds the IAM managed-policy size quota."
    }
  }
}

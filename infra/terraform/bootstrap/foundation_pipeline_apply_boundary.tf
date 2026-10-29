data "aws_iam_policy_document" "foundation_apply_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0
  source_policy_documents = concat([
    data.aws_iam_policy_document.foundation_gateway_logging_ceiling.json,
    ], data.aws_iam_policy_document.foundation_image_retirement_ceiling[*].json, [for document in data.aws_iam_policy_document.foundation_initial_state_observation[*].json : jsonencode({
      Version = "2012-10-17"
      Statement = [
        for statement in jsondecode(document).Statement :
        # The exact state bucket is already admitted by the S3 ceiling below.
        statement if statement.Sid != "InspectInitialFoundationStateVersions"
      ]
  })])

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
    resources = ["arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.managed_codebuild_executions.foundation_terraform_apply.project}"]
  }
  statement {
    actions   = ["codepipeline:ListActionExecutions", "codepipeline:GetPipelineExecution"]
    resources = ["arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.managed_codebuild_executions.foundation_terraform_apply.pipeline}"]
  }

  statement {
    effect  = "Allow"
    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}",
      "arn:aws:s3:::${local.foundation_pipeline_artifact_bucket_name}/*",
      "arn:aws:s3:::${var.state_bucket_name}",
      "arn:aws:s3:::${var.state_bucket_name}/${local.foundation_state_backend_key}",
      "arn:aws:s3:::${var.state_bucket_name}/${local.foundation_state_backend_key}.tflock",
      local.foundation_release_manifest_bucket_arn,
      local.foundation_release_manifest_objects_arn,
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["logs:*"]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "acm:*",
      "ec2:*",
      "route53:*",
    ]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["ecr:*"]
    resources = local.foundation_ecr_repository_arns
  }

  statement {
    effect = "Allow"
    actions = [
      "ecr:GetSigningConfiguration",
      "ecr:PutSigningConfiguration",
    ]
    resources = ["*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["signer:*"]
    resources = concat(local.foundation_ecr_signing_profile_arns, [local.foundation_signing_job_arn_pattern])
  }

  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:*",
      "ssm:*",
    ]
    resources = concat(local.foundation_runtime_secret_arns, local.foundation_runtime_ssm_parameter_arns)
  }

  statement {
    effect    = "Allow"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  statement {
    sid    = "DenyDeletingRetainedFoundationImages"
    effect = "Deny"
    actions = [
      "ecr:BatchDeleteImage",
      "ecr:DeleteRepository",
    ]
    resources = local.foundation_ecr_repository_arns
  }

  statement {
    sid    = "DenyDeletingImmutableReleaseAuthority"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = [
      "${local.foundation_release_manifest_bucket_arn}/artifacts/*",
      "${local.foundation_release_manifest_bucket_arn}/candidates/*",
      "${local.foundation_release_manifest_bucket_arn}/promotions/*",
      "${local.foundation_release_manifest_bucket_arn}/deployments/*",
      "${local.foundation_release_manifest_bucket_arn}/rollbacks/*",
      "${local.foundation_release_manifest_bucket_arn}/reissue/*",
      local.foundation_toolchain_promotion_object_arn,
      local.foundation_prover_promotion_object_arn,
    ]
  }

  statement {
    sid       = "DenyAddingReleaseAuthorityLifecycle"
    effect    = "Deny"
    actions   = ["s3:PutLifecycleConfiguration"]
    resources = [local.foundation_release_manifest_bucket_arn]
  }
}

resource "aws_iam_policy" "foundation_apply_deploy_permissions_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0


  name   = local.foundation_apply_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.foundation_apply_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    precondition {
      condition = (
        length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_apply_deploy_permissions_boundary[0].json))) <= 6144
      )
      error_message = "Foundation Apply permissions boundary exceeds the IAM managed-policy size quota."
    }
  }
}

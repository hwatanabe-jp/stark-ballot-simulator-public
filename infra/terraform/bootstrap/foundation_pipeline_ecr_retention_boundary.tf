data "aws_iam_policy_document" "foundation_ecr_retention_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid    = "WriteEcrRetentionLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${local.foundation_ecr_retention_log_group_arn}:log-stream:*"]
  }

  statement {
    sid       = "VerifyEcrRetentionCaller"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid    = "InspectAndDeleteExactEcrSubjects"
    effect = "Allow"
    actions = [
      "ecr:BatchDeleteImage",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = local.foundation_ecr_repository_arns
  }

  statement {
    sid    = "ReadExactAppImageAuthority"
    effect = "Allow"
    actions = [
      "s3:GetObject",
    ]
    resources = local.foundation_ecr_retention_app_authority_object_arns
  }

  statement {
    sid    = "DecryptExactAppImageAuthority"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    sid    = "ReadExactReleaseImageAuthority"
    effect = "Allow"
    actions = [
      "s3:GetObject",
    ]
    resources = local.foundation_ecr_retention_release_authority_object_arns
  }

  statement {
    sid       = "ReadImageReleasePipelineActivity"
    effect    = "Allow"
    actions   = ["codepipeline:ListPipelineExecutions"]
    resources = local.foundation_ecr_retention_pipeline_arns
  }

  statement {
    sid    = "ReadImageCandidateBuildActivity"
    effect = "Allow"
    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:ListBuildsForProject",
    ]
    resources = [
      "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.toolchain_release_candidate_project_name}",
      "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.prover_release_candidate_project_name}",
    ]
  }

  statement {
    sid    = "ReadFinalizationActivity"
    effect = "Allow"
    actions = [
      "states:DescribeStateMachine",
      "states:ListExecutions",
    ]
    resources = [local.foundation_ecr_retention_state_machine_arn]
  }

  statement {
    sid       = "ReadProverTaskDefinitionActivity"
    effect    = "Allow"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "ListExactProverClusterTasks"
    effect    = "Allow"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.foundation_ecr_retention_ecs_cluster_arn]
    }
  }
}

resource "aws_iam_policy" "foundation_ecr_retention_boundary" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  depends_on = [
    terraform_data.bootstrap_apply_authorization_propagation,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_artifacts_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_iam_management,
    aws_iam_role_policy_attachment.bootstrap_apply_foundation_lane_pipeline_management,
  ]

  name   = local.foundation_ecr_retention_boundary_policy_name
  policy = data.aws_iam_policy_document.foundation_ecr_retention_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })

  lifecycle {
    precondition {
      condition = (
        length(jsonencode(jsondecode(data.aws_iam_policy_document.foundation_ecr_retention_boundary[0].json))) <= 6144
      )
      error_message = "Foundation ECR retention permissions boundary exceeds the IAM managed-policy size quota."
    }
  }
}

data "aws_iam_policy_document" "foundation_toolchain_release_candidate_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ReadExactToolchainCandidateProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [aws_codebuild_project.toolchain_release_candidate[0].arn]
  }

  statement {
    sid    = "UseToolchainReleaseCandidatePipelineArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.foundation_pipeline_artifacts[0].arn,
      "${aws_s3_bucket.foundation_pipeline_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid    = "UseToolchainReleaseCandidatePipelineArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.foundation_pipeline_artifacts[0].arn]
  }

  statement {
    sid    = "WriteToolchainReleaseCandidateBuildLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.toolchain_release_candidate_project_name}:*",
    ]
  }

  statement {
    sid    = "AuthenticateToEcrForToolchainReleaseCandidate"
    effect = "Allow"

    actions = [
      "ecr:GetAuthorizationToken",
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "PublishToolchainReleaseCandidateImage"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImageScanFindings",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [local.foundation_risc0_toolchain_ecr_repository_arn]
  }

  statement {
    sid    = "UseToolchainCandidateLedgerRecords"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.foundation_toolchain_candidate_records_objects_arn]
  }

}

resource "aws_iam_role_policy" "foundation_toolchain_release_candidate_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_toolchain_release_candidate_build[0].name}-policy"
  role   = aws_iam_role.foundation_toolchain_release_candidate_build[0].id
  policy = data.aws_iam_policy_document.foundation_toolchain_release_candidate_build[0].json
}

data "aws_iam_policy_document" "foundation_toolchain_release_update_accepted_pointer_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ReadExactToolchainPointerProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [aws_codebuild_project.toolchain_release_update_accepted_pointer[0].arn]
  }

  statement {
    sid    = "UseToolchainReleaseAcceptedPointerArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.foundation_pipeline_artifacts[0].arn,
      "${aws_s3_bucket.foundation_pipeline_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid    = "UseToolchainReleaseAcceptedPointerArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.foundation_pipeline_artifacts[0].arn]
  }

  statement {
    sid    = "WriteToolchainReleaseAcceptedPointerLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.toolchain_release_update_accepted_pointer_project_name}:*",
    ]
  }

  statement {
    sid    = "ReadToolchainLedgerRecords"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.foundation_toolchain_candidate_records_objects_arn,
      local.foundation_toolchain_release_records_objects_arn,
    ]
  }

  statement {
    sid       = "PublishToolchainReleaseLedgerRecords"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = [local.foundation_toolchain_release_records_objects_arn]
  }

  statement {
    sid    = "PromoteAcceptedToolchainPointer"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.foundation_toolchain_accepted_pointer_object_arn]
  }

  statement {
    sid    = "ListToolchainAcceptedPointerAuthority"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [local.foundation_release_manifest_bucket_arn]

    condition {
      test     = "StringEqualsIfExists"
      variable = "s3:prefix"
      values   = [local.deployment_shared_names.toolchainAcceptedPointerKey]
    }
  }
}

resource "aws_iam_role_policy" "foundation_toolchain_release_update_accepted_pointer_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_toolchain_release_update_accepted_pointer_build[0].name}-policy"
  role   = aws_iam_role.foundation_toolchain_release_update_accepted_pointer_build[0].id
  policy = data.aws_iam_policy_document.foundation_toolchain_release_update_accepted_pointer_build[0].json
}

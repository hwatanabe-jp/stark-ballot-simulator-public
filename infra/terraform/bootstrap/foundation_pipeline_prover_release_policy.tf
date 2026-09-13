data "aws_iam_policy_document" "foundation_prover_release_toolchain_resolver_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ReadExactProverToolchainResolverProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [aws_codebuild_project.prover_release_toolchain_resolver[0].arn]
  }

  statement {
    sid    = "UseProverReleaseToolchainResolverPipelineArtifacts"
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
    sid    = "UseProverReleaseToolchainResolverPipelineArtifactKey"
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
    sid    = "WriteProverReleaseToolchainResolverBuildLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.prover_release_toolchain_resolver_project_name}:*",
    ]
  }

  statement {
    sid    = "ReadToolchainArtifactAuthority"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.foundation_toolchain_accepted_pointer_object_arn,
      local.foundation_toolchain_candidate_records_objects_arn,
      local.foundation_toolchain_release_records_objects_arn,
    ]
  }

}

resource "aws_iam_role_policy" "foundation_prover_release_toolchain_resolver_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_prover_release_toolchain_resolver_build[0].name}-policy"
  role   = aws_iam_role.foundation_prover_release_toolchain_resolver_build[0].id
  policy = data.aws_iam_policy_document.foundation_prover_release_toolchain_resolver_build[0].json
}

data "aws_iam_policy_document" "foundation_prover_release_candidate_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ReadExactProverCandidateProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [aws_codebuild_project.prover_release_candidate[0].arn]
  }

  statement {
    sid    = "UseProverReleaseCandidatePipelineArtifacts"
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
    sid    = "UseProverReleaseCandidatePipelineArtifactKey"
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
    sid    = "WriteProverReleaseCandidateBuildLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.prover_release_candidate_project_name}:*",
    ]
  }

  statement {
    sid    = "UseProverCandidateLedgerRecords"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.foundation_prover_candidate_records_objects_arn]
  }

  statement {
    sid    = "ReadProverCandidateToolchainLedgerClosure"
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
    sid    = "AuthenticateToEcrForProverReleaseCandidate"
    effect = "Allow"

    actions = [
      "ecr:GetAuthorizationToken",
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ReadAcceptedToolchainImage"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [local.foundation_risc0_toolchain_ecr_repository_arn]
  }

  statement {
    sid    = "PublishProverReleaseCandidateImage"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImageScanFindings",
      "ecr:DescribeImageSigningStatus",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [local.foundation_prover_ecr_repository_arn]
  }

  statement {
    sid    = "UseProverReleaseImageSigningProfile"
    effect = "Allow"

    actions = [
      "signer:SignPayload",
    ]
    resources = local.foundation_ecr_signing_profile_arns
  }

}

resource "aws_iam_role_policy" "foundation_prover_release_candidate_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_prover_release_candidate_build[0].name}-policy"
  role   = aws_iam_role.foundation_prover_release_candidate_build[0].id
  policy = data.aws_iam_policy_document.foundation_prover_release_candidate_build[0].json
}

data "aws_iam_policy_document" "foundation_prover_release_update_accepted_pointer_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid       = "ReadExactProverPointerProjectConfiguration"
    effect    = "Allow"
    actions   = ["codebuild:BatchGetProjects"]
    resources = [aws_codebuild_project.prover_release_update_accepted_pointer[0].arn]
  }

  statement {
    sid    = "UseProverReleaseAcceptedPointerArtifacts"
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
    sid    = "UseProverReleaseAcceptedPointerArtifactKey"
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
    sid    = "WriteProverReleaseAcceptedPointerLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.prover_release_update_accepted_pointer_project_name}:*",
    ]
  }

  statement {
    sid    = "ReadProverLedgerRecords"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = [
      local.foundation_prover_candidate_records_objects_arn,
      local.foundation_prover_release_records_objects_arn,
    ]
  }

  statement {
    sid    = "ReadProverPromotionToolchainLedgerClosure"
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
    sid       = "PublishProverReleaseLedgerRecords"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = [local.foundation_prover_release_records_objects_arn]
  }

  statement {
    sid    = "PromoteAcceptedProverPointer"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.foundation_prover_accepted_pointer_object_arn]
  }

}

resource "aws_iam_role_policy" "foundation_prover_release_update_accepted_pointer_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_prover_release_update_accepted_pointer_build[0].name}-policy"
  role   = aws_iam_role.foundation_prover_release_update_accepted_pointer_build[0].id
  policy = data.aws_iam_policy_document.foundation_prover_release_update_accepted_pointer_build[0].json
}

data "aws_iam_policy_document" "foundation_prover_release_toolchain_resolver_build" {
  count                   = local.foundation_pipeline_enabled ? 1 : 0
  source_policy_documents = [data.aws_iam_policy_document.terraform_authority_decrypt[0].json]


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
      local.foundation_toolchain_promotion_object_arn,
      local.foundation_toolchain_candidate_records_objects_arn,
    ]
  }

  statement {
    sid       = "ReadCurrentFoundationCheckpoint"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${local.terraform_authority_bucket_arn}/deployment/${local.deployment_target.targetKey}/foundation/checkpoint.json"]
  }

  statement {
    sid       = "RevalidateSelectedToolchainImage"
    effect    = "Allow"
    actions   = ["ecr:DescribeImages", "ecr:DescribeImageScanFindings"]
    resources = [local.foundation_risc0_toolchain_ecr_repository_arn]
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
      local.foundation_toolchain_promotion_object_arn,
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

  statement {
    sid       = "ObserveProverPromotionPredecessor"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = [local.foundation_prover_promotion_object_arn]
  }
  statement {
    sid       = "ObserveInitialProverPromotionAbsence"
    effect    = "Allow"
    actions   = ["s3:ListBucketVersions"]
    resources = [local.foundation_release_manifest_bucket_arn]
    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = ["promotions/prover/current.json"]
    }
  }

  statement {
    sid       = "ReadCurrentFoundationCheckpoint"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${local.terraform_authority_bucket_arn}/deployment/${local.deployment_target.targetKey}/foundation/checkpoint.json"]
  }
  statement {
    sid       = "DecryptFoundationCheckpoint"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]
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
      local.foundation_toolchain_promotion_object_arn,
    ]
  }



  statement {
    sid    = "PromoteAcceptedProverPointer"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = [local.foundation_prover_promotion_object_arn]
  }

  statement {
    sid       = "RevalidateProverPromotionImage"
    effect    = "Allow"
    actions   = ["ecr:DescribeImages", "ecr:DescribeImageScanFindings", "ecr:DescribeImageSigningStatus"]
    resources = [local.foundation_prover_ecr_repository_arn]
  }

  statement {
    sid       = "ReadCurrentFoundationCheckpoint"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${local.terraform_authority_bucket_arn}/deployment/${local.deployment_target.targetKey}/foundation/checkpoint.json"]
  }
  statement {
    sid       = "DecryptFoundationCheckpoint"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_alias.terraform_authority[0].target_key_arn]
  }

}

resource "aws_iam_role_policy" "foundation_prover_release_update_accepted_pointer_build" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${aws_iam_role.foundation_prover_release_update_accepted_pointer_build[0].name}-policy"
  role   = aws_iam_role.foundation_prover_release_update_accepted_pointer_build[0].id
  policy = data.aws_iam_policy_document.foundation_prover_release_update_accepted_pointer_build[0].json
}

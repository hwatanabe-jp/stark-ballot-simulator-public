data "aws_iam_policy_document" "foundation_codebuild_common" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid    = "WriteFoundationCodeBuildLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      for log_group in aws_cloudwatch_log_group.foundation_pipeline_codebuild :
      "${log_group.arn}:*"
    ]
  }

  statement {
    sid    = "UseFoundationPipelineArtifacts"
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
    sid    = "UseFoundationPipelineArtifactKey"
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
}

data "aws_iam_policy_document" "foundation_terraform_plan" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.foundation_codebuild_common[0].json]

  statement {
    sid       = "ReadFoundationStateBackend"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/${local.foundation_state_backend_key}"]
  }

  statement {
    sid    = "UseFoundationStateLockfile"
    effect = "Allow"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.state.arn}/${local.foundation_state_backend_key}.tflock"]
  }

  statement {
    sid       = "ListFoundationStatePrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "stark-ballot-simulator/stark-dev/develop/foundation/",
        "stark-ballot-simulator/stark-dev/develop/foundation/*",
      ]
    }
  }

  statement {
    sid    = "UseFoundationStateKey"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
    ]
    resources = [aws_kms_key.state.arn]
  }

  statement {
    sid    = "ReadFoundationWorkloadResources"
    effect = "Allow"
    actions = [
      "acm:DescribeCertificate",
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeInternetGateways",
      "ec2:DescribeRouteTables",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeVpcs",
      "ec2:DescribeVpcAttribute",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetSigningConfiguration",
      "ecr:GetLifecyclePolicy",
      "ecr:GetRepositoryPolicy",
      "ecr:ListTagsForResource",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
      "route53:GetHostedZone",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:ListSecretVersionIds",
      "s3:GetAccelerateConfiguration",
      "s3:GetBucketAcl",
      "s3:GetBucketCORS",
      "s3:GetBucketLocation",
      "s3:GetBucketLogging",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetBucketPolicy",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketRequestPayment",
      "s3:GetBucketTagging",
      "s3:GetBucketVersioning",
      "s3:GetBucketWebsite",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:ListBucket",
      "signer:GetSigningProfile",
      "signer:ListSigningProfiles",
      "signer:ListTagsForResource",
      "ssm:DescribeParameters",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:ListTagsForResource",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "foundation_terraform_plan" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = "${local.foundation_terraform_plan_role_name}-policy"
  role   = aws_iam_role.foundation_terraform_plan[0].id
  policy = data.aws_iam_policy_document.foundation_terraform_plan[0].json
}

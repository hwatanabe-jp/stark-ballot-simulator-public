data "aws_iam_policy_document" "target_lambda_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "image_signature_verifier" {
  name                 = local.image_signature_verifier_role_name
  assume_role_policy   = data.aws_iam_policy_document.target_lambda_assume_role.json
  permissions_boundary = var.image_signature_verifier_permissions_boundary_arn
  tags                 = local.common_tags
}
data "aws_iam_policy_document" "image_signature_verifier" {
  statement {
    sid    = "WriteImageSignatureVerifierLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.image_signature_verifier.arn}:*"]
  }

  statement {
    sid    = "ReadExactProverImage"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImageSigningStatus",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [local.prover_image_repository_arn]
  }

  statement {
    sid       = "GetEcrAuthorizationToken"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid     = "CheckSignerRevocation"
    effect  = "Allow"
    actions = ["signer:GetRevocationStatus"]
    resources = [
      local.image_signature_signing_profile_arn,
      local.image_signature_signing_job_arn_pattern,
    ]
  }
}

resource "aws_iam_role_policy" "image_signature_verifier" {
  name   = "${local.image_signature_name_prefix}-image-signature-verifier"
  role   = aws_iam_role.image_signature_verifier.id
  policy = data.aws_iam_policy_document.image_signature_verifier.json
}

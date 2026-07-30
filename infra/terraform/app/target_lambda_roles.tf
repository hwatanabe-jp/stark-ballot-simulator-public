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

resource "aws_iam_role" "target_lambda" {
  for_each = local.target_application_lambda_names

  name               = local.target_lambda_role_names[each.key]
  assume_role_policy = data.aws_iam_policy_document.target_lambda_assume_role.json
  tags               = local.common_tags
}

resource "aws_iam_role" "image_signature_verifier" {
  name                 = local.image_signature_verifier_role_name
  assume_role_policy   = data.aws_iam_policy_document.target_lambda_assume_role.json
  permissions_boundary = var.image_signature_verifier_permissions_boundary_arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "foundation_terraform_acceptance_publisher_assume_role" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [local.foundation_terraform_smoke_role_arn]
    }
  }
}

resource "aws_iam_role" "foundation_terraform_acceptance_publisher" {
  count = local.terraform_baseline_authority_enabled ? 1 : 0

  depends_on = [
    aws_iam_role.foundation_terraform_smoke,
    aws_iam_policy.foundation_smoke_deploy_permissions_boundary,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  name                 = local.foundation_terraform_acceptance_publisher_role_name
  assume_role_policy   = data.aws_iam_policy_document.foundation_terraform_acceptance_publisher_assume_role[0].json
  permissions_boundary = aws_iam_policy.foundation_smoke_deploy_permissions_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "foundation"
  })
}

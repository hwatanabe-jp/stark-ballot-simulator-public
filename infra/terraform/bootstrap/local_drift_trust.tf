data "aws_iam_policy_document" "local_drift_assume_role" {
  count = local.terraform_drift_enabled ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [local.saved_plan_approval_administrator_access_role_arn]
    }
  }
}

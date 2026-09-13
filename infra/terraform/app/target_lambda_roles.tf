resource "aws_iam_role" "target_lambda" {
  for_each = local.target_application_lambda_names

  name               = local.target_lambda_role_names[each.key]
  assume_role_policy = data.aws_iam_policy_document.target_lambda_assume_role.json
  tags               = local.common_tags
}

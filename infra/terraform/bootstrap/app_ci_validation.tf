# The credential bytes are installed outside Terraform and never enter plan/state.
resource "aws_secretsmanager_secret" "app_ci_validation_github" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                    = "/${var.project_name}/${local.deployment_target.targetKey}/delivery/github-ci-evidence"
  description             = "Read-only GitHub App credentials for exact App CI validation evidence"
  recovery_window_in_days = 30
  tags                    = local.common_tags
}

resource "aws_iam_role_policy" "app_ci_validation_github" {
  count = local.app_pipeline_enabled ? 1 : 0

  name = "read-ci-validation-github"
  role = aws_iam_role.app_terraform_plan[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_secretsmanager_secret.app_ci_validation_github[0].arn
    }]
  })
}

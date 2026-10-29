data "aws_iam_policy_document" "app_apply_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  source_policy_documents = [
    # Native signature verification belongs to Plan. Apply consumes its exact
    # evidence and only needs ordinary image reads, not Signer verification.
    jsonencode({
      Version = "2012-10-17"
      Statement = [
        for statement in jsondecode(data.aws_iam_policy_document.app_deploy_permissions_boundary[0].json).Statement : statement
        if try(statement.Sid, "") != "VerifyProverSignature"
      ]
    }),
  ]

  statement {
    effect    = "Allow"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [local.foundation_prover_ecr_repository_arn]
  }


  statement {
    effect = "Allow"

    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}/${local.app_state_backend_key}"]
  }
}

resource "aws_iam_policy" "app_apply_deploy_permissions_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0


  name   = local.app_apply_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.app_apply_deploy_permissions_boundary[0].json
  tags = merge(local.common_tags, {
    StateScope = "app"
  })
}

check "app_apply_deploy_permissions_boundary_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_apply_deploy_permissions_boundary[0].json))) <= 6144, false)
    )
    error_message = "The app apply deploy permissions boundary must remain within the IAM 6,144-character quota."
  }
}

data "aws_iam_policy_document" "app_acceptance_publisher_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "ExactAppAcceptanceObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = concat(
      [
        local.app_retained_acceptance_record_objects_arn,
        local.app_retained_accepted_deployment_pointer_object_arn,
      ],
      local.app_retained_acceptance_attempt_evidence_object_arns,
    )
  }

  statement {
    sid    = "ExactAppRetainedArtifactKey"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/AccountAlias"
      values   = [var.account_alias]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = [var.deployment_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/StateScope"
      values   = ["app"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [local.app_retained_artifact_bucket_arn]
    }
  }
}

resource "aws_iam_policy" "app_acceptance_publisher_boundary" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = local.app_acceptance_publisher_boundary_policy_name
  policy = data.aws_iam_policy_document.app_acceptance_publisher_boundary[0].json
  tags   = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]
}

check "app_acceptance_publisher_boundary_policy_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_acceptance_publisher_boundary[0].json))) <= 6144, false)
    )
    error_message = "The App acceptance publisher permissions boundary must remain within IAM's 6,144-character quota."
  }
}

data "aws_iam_policy_document" "app_acceptance_publisher_assume_role" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [local.app_terraform_smoke_role_arn]
    }
  }

}

resource "aws_iam_role" "app_acceptance_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  name                 = local.app_acceptance_publisher_role_name
  assume_role_policy   = data.aws_iam_policy_document.app_acceptance_publisher_assume_role[0].json
  permissions_boundary = aws_iam_policy.app_acceptance_publisher_boundary[0].arn
  tags = merge(local.common_tags, {
    StateScope = "app"
  })

  depends_on = [
    aws_iam_role.app_terraform_smoke,
    aws_iam_role_policy_attachment.bootstrap_apply_app_lane_iam_management,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]
}

data "aws_iam_policy_document" "app_acceptance_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "PublishExactAppAcceptanceObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = concat(
      [
        local.app_retained_acceptance_record_objects_arn,
        local.app_retained_accepted_deployment_pointer_object_arn,
      ],
      local.app_retained_acceptance_attempt_evidence_object_arns,
    )
  }

  statement {
    sid    = "UseExactAppRetainedArtifactKey"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_alias.app_pipeline_artifacts[0].target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [local.app_retained_artifact_bucket_arn]
    }
  }
}

resource "aws_iam_role_policy" "app_acceptance_publisher" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = "${local.app_acceptance_publisher_role_name}-policy"
  role   = aws_iam_role.app_acceptance_publisher[0].id
  policy = data.aws_iam_policy_document.app_acceptance_publisher[0].json
}

check "app_acceptance_publisher_identity_policy_size" {
  assert {
    condition = (
      !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.app_acceptance_publisher[0].json))) <= 10240, false)
    )
    error_message = "The App acceptance publisher inline policy must remain within IAM's 10,240-character quota."
  }
}

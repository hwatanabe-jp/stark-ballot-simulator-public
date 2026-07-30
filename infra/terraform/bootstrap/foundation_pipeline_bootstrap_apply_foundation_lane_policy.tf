data "aws_iam_policy_document" "bootstrap_apply_foundation_lane_pipeline_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid    = "ManageFoundationCodeBuildProjects"
    effect = "Allow"
    actions = [
      "codebuild:BatchGetProjects",
      "codebuild:CreateProject",
      "codebuild:DeleteProject",
      "codebuild:ListTagsForResource",
      "codebuild:TagResource",
      "codebuild:UntagResource",
      "codebuild:UpdateProject",
    ]
    resources = local.foundation_bootstrap_managed_codebuild_project_arns
  }

  statement {
    sid    = "ManageFoundationCodePipeline"
    effect = "Allow"
    actions = [
      "codepipeline:CreatePipeline",
      "codepipeline:DeletePipeline",
      "codepipeline:GetPipeline",
      "codepipeline:GetPipelineState",
      "codepipeline:ListTagsForResource",
      "codepipeline:TagResource",
      "codepipeline:UntagResource",
      "codepipeline:UpdatePipeline",
    ]
    resources = [
      local.foundation_pipeline_arn,
      local.foundation_pipeline_action_arn_pattern,
      local.prover_release_pipeline_arn,
      local.prover_release_pipeline_action_arn_pattern,
      local.toolchain_release_pipeline_arn,
      local.toolchain_release_pipeline_action_arn_pattern,
    ]
  }

  statement {
    sid    = "PassFoundationSourceConnectionToCodePipeline"
    effect = "Allow"
    actions = [
      "codeconnections:PassConnection",
      "codestar-connections:PassConnection",
    ]
    resources = local.foundation_source_connection_arns

    condition {
      test     = "StringEqualsIfExists"
      variable = "codeconnections:PassedToService"
      values   = ["codepipeline.amazonaws.com"]
    }

    condition {
      test     = "StringEqualsIfExists"
      variable = "codestar-connections:PassedToService"
      values   = ["codepipeline.amazonaws.com"]
    }
  }

  statement {
    sid    = "ReadSharedSourceAndIdentity"
    effect = "Allow"
    actions = [
      "codeconnections:GetConnection",
      "iam:GetOpenIDConnectProvider",
    ]
    resources = [
      aws_codeconnections_connection.source[0].arn,
      aws_iam_openid_connect_provider.github[0].arn,
    ]
  }
}

data "aws_iam_policy_document" "bootstrap_apply_foundation_lane_iam_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid       = "CreateFoundationBoundaryPolicies"
    effect    = "Allow"
    actions   = ["iam:CreatePolicy"]
    resources = local.foundation_deploy_permissions_boundary_policy_arns

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/StateScope"
      values   = ["foundation"]
    }
  }

  statement {
    sid    = "ManageFoundationBoundaryPolicies"
    effect = "Allow"
    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyTags",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = local.foundation_deploy_permissions_boundary_policy_arns
  }

  statement {
    sid    = "CreateOrAttachFoundationPipelineRoleBoundary"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = local.foundation_bootstrap_managed_role_arn_patterns

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values = [
        local.foundation_deploy_permissions_boundary_policy_arn,
        local.foundation_apply_deploy_permissions_boundary_policy_arn,
        local.foundation_smoke_deploy_permissions_boundary_policy_arn,
      ]
    }
  }

  statement {
    sid    = "ManageFoundationPipelineRoles"
    effect = "Allow"
    actions = [
      "iam:DeleteRole",
      "iam:DeleteRolePermissionsBoundary",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = local.foundation_bootstrap_managed_role_arn_patterns
  }

  statement {
    sid    = "AttachFoundationApplyWorkloadPolicy"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_apply_role_name}"]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = [local.foundation_terraform_apply_workload_policy_arn]
    }
  }

  statement {
    sid       = "PassFoundationPipelineRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = local.foundation_bootstrap_managed_role_arn_patterns

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "codebuild.amazonaws.com",
        "codepipeline.amazonaws.com",
      ]
    }
  }
}

data "aws_iam_policy_document" "bootstrap_apply_foundation_lane_artifacts_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  statement {
    sid    = "ManageFoundationArtifactBucket"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:DeleteBucketPolicy",
      "s3:GetBucketAcl",
      "s3:GetEncryptionConfiguration",
      "s3:GetBucketPolicy",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketTagging",
      "s3:GetBucketVersioning",
      "s3:GetLifecycleConfiguration",
      "s3:ListBucket",
      "s3:PutEncryptionConfiguration",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketTagging",
      "s3:PutBucketVersioning",
      "s3:PutLifecycleConfiguration",
    ]
    resources = [local.foundation_pipeline_artifact_bucket_arn]
  }

  statement {
    sid       = "CreateTaggedFoundationArtifactKey"
    effect    = "Allow"
    actions   = ["kms:CreateKey"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/StateScope"
      values   = ["foundation"]
    }
  }

  statement {
    sid    = "ManageFoundationArtifactKey"
    effect = "Allow"
    actions = [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/StateScope"
      values   = ["foundation"]
    }
  }

  statement {
    sid    = "ManageFoundationArtifactKeyAlias"
    effect = "Allow"
    actions = [
      "kms:CreateAlias",
      "kms:UpdateAlias",
    ]
    resources = [local.foundation_artifact_kms_alias_arn]
  }

  statement {
    sid    = "AssociateFoundationArtifactKeyAlias"
    effect = "Allow"
    actions = [
      "kms:CreateAlias",
      "kms:UpdateAlias",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/StateScope"
      values   = ["foundation"]
    }
  }

  statement {
    sid    = "ManageFoundationCodeBuildLogGroups"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:DescribeLogGroups",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
    ]
    resources = local.foundation_bootstrap_managed_codebuild_log_group_resource_arn_patterns
  }

}

resource "aws_iam_policy" "bootstrap_apply_foundation_lane_pipeline_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = local.foundation_lane_pipeline_management_policy_name
  policy = data.aws_iam_policy_document.bootstrap_apply_foundation_lane_pipeline_management[0].json
  tags   = local.common_tags

  depends_on = [
    aws_iam_policy.bootstrap_deploy_permissions_boundary,
    aws_iam_policy.terraform_apply_app_lane_policy_admin,
  ]
}

resource "aws_iam_policy" "bootstrap_apply_foundation_lane_iam_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = local.foundation_lane_iam_management_policy_name
  policy = data.aws_iam_policy_document.bootstrap_apply_foundation_lane_iam_management[0].json
  tags   = local.common_tags

  depends_on = [
    aws_iam_policy.bootstrap_deploy_permissions_boundary,
    aws_iam_policy.terraform_apply_app_lane_policy_admin,
  ]
}

check "bootstrap_apply_foundation_lane_iam_policy_size" {
  assert {
    condition = (
      !local.foundation_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.bootstrap_apply_foundation_lane_iam_management[0].json))) <= 6144, false)
    )
    error_message = "The bootstrap Foundation-lane IAM managed policy must remain within the IAM 6,144-character quota."
  }
}

resource "aws_iam_policy" "bootstrap_apply_foundation_lane_artifacts_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  name   = local.foundation_lane_artifacts_management_policy_name
  policy = data.aws_iam_policy_document.bootstrap_apply_foundation_lane_artifacts_management[0].json
  tags   = local.common_tags

  depends_on = [
    aws_iam_policy.bootstrap_deploy_permissions_boundary,
    aws_iam_policy.terraform_apply_app_lane_policy_admin,
  ]
}

resource "aws_iam_role_policy_attachment" "bootstrap_apply_foundation_lane_pipeline_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.bootstrap_apply_foundation_lane_pipeline_management[0].arn
}

resource "aws_iam_role_policy_attachment" "bootstrap_apply_foundation_lane_iam_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.bootstrap_apply_foundation_lane_iam_management[0].arn
}

resource "aws_iam_role_policy_attachment" "bootstrap_apply_foundation_lane_artifacts_management" {
  count = local.foundation_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.bootstrap_apply_foundation_lane_artifacts_management[0].arn
}

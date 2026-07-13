data "aws_iam_policy_document" "bootstrap_apply_app_lane_pipeline_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "ManageAppCodeBuildProjects"
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
    resources = local.app_codebuild_project_arns
  }

  statement {
    sid    = "ManageAppCodePipeline"
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
      local.app_pipeline_arn,
      local.app_pipeline_action_arn_pattern,
      local.app_static_fast_pipeline_arn,
      local.app_static_fast_action_arn_pattern,
    ]
  }

  statement {
    sid    = "PassAppSourceConnectionToCodePipeline"
    effect = "Allow"

    actions = [
      "codeconnections:PassConnection",
      "codestar-connections:PassConnection",
    ]
    resources = local.app_source_connection_arns

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

data "aws_iam_policy_document" "bootstrap_apply_app_lane_iam_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "CreateAppBoundaryPolicies"
    effect = "Allow"

    actions = ["iam:CreatePolicy"]
    resources = concat(
      local.app_deploy_permissions_boundary_policy_arns,
      local.app_deployment_managed_policy_arns,
    )

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/AccountAlias"
      values   = [var.account_alias]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [var.deployment_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/StateScope"
      values = [
        "app",
        var.state_scope,
      ]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values = [
        "AccountAlias",
        "Environment",
        "ManagedBy",
        "Project",
        "StateScope",
      ]
    }
  }

  statement {
    sid    = "ManageAppBoundaryPolicies"
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
    ]
    resources = concat(
      local.app_deploy_permissions_boundary_policy_arns,
      local.app_deployment_managed_policy_arns,
    )

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
      values = [
        "app",
        var.state_scope,
      ]
    }
  }

  statement {
    sid    = "TagAppBoundaryPolicies"
    effect = "Allow"

    actions = [
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = concat(
      local.app_deploy_permissions_boundary_policy_arns,
      local.app_deployment_managed_policy_arns,
    )

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
      values = [
        "app",
        var.state_scope,
      ]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values = [
        "AccountAlias",
        "Environment",
        "ManagedBy",
        "Project",
        "StateScope",
      ]
    }
  }

}

data "aws_iam_policy_document" "bootstrap_apply_app_lane_role_attachment_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "AttachAppPlanManagedPolicies"
    effect = "Allow"

    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_plan_role_name}"]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = local.app_plan_managed_policy_arns
    }
  }

  statement {
    sid    = "AttachAppDeploymentManagedPolicies"
    effect = "Allow"

    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_apply_role_name}"]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = local.app_deployment_managed_policy_arns
    }
  }

  statement {
    sid       = "ListAppApplyAttachedPolicies"
    effect    = "Allow"
    actions   = ["iam:ListAttachedRolePolicies"]
    resources = local.app_pipeline_role_name_arns
  }

  statement {
    sid    = "CreateOrAttachAppPipelineRoleBoundary"
    effect = "Allow"

    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = local.app_pipeline_role_name_arns

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values = [
        local.app_deploy_permissions_boundary_policy_arn,
        local.app_apply_deploy_permissions_boundary_policy_arn,
        local.app_smoke_deploy_permissions_boundary_policy_arn,
      ]
    }
  }

  statement {
    sid    = "ManageAppPipelineRoles"
    effect = "Allow"

    actions = [
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = local.app_pipeline_role_name_arns
  }

  statement {
    sid    = "PassAppPipelineRoles"
    effect = "Allow"

    actions   = ["iam:PassRole"]
    resources = local.app_pipeline_role_name_arns

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

data "aws_iam_policy_document" "bootstrap_apply_app_lane_artifacts_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "ManageAppArtifactBucket"
    effect = "Allow"

    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:DeleteBucketPolicy",
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
    resources = [local.app_pipeline_artifact_bucket_arn]
  }

  statement {
    sid    = "CreateTaggedAppArtifactKey"
    effect = "Allow"

    actions   = ["kms:CreateKey"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Project"
      values   = [var.project_name]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/AccountAlias"
      values   = [var.account_alias]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [var.deployment_environment]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/StateScope"
      values   = ["app"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values = [
        "AccountAlias",
        "Environment",
        "ManagedBy",
        "Project",
        "StateScope",
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:KeyUsage"
      values   = ["ENCRYPT_DECRYPT"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:KeySpec"
      values   = ["SYMMETRIC_DEFAULT"]
    }
  }

  statement {
    sid    = "ManageAppArtifactKey"
    effect = "Allow"

    actions = [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:PutKeyPolicy",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
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
  }

  statement {
    sid    = "ManageAppArtifactKeyAlias"
    effect = "Allow"

    actions = [
      "kms:CreateAlias",
      "kms:UpdateAlias",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:RequestAlias"
      values   = [local.app_artifact_kms_alias]
    }
  }

  statement {
    sid    = "ManageAppCodeBuildLogGroups"
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
    resources = local.app_codebuild_log_group_arns
  }
}

resource "aws_iam_policy" "bootstrap_apply_app_lane_pipeline_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = local.app_lane_pipeline_management_policy_name
  policy = data.aws_iam_policy_document.bootstrap_apply_app_lane_pipeline_management[0].json
  tags   = local.common_tags

  depends_on = [aws_iam_policy.bootstrap_deploy_permissions_boundary]
}

resource "aws_iam_policy" "bootstrap_apply_app_lane_iam_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = local.app_lane_iam_management_policy_name
  policy = data.aws_iam_policy_document.bootstrap_apply_app_lane_iam_management[0].json
  tags   = local.common_tags

  depends_on = [aws_iam_policy.bootstrap_deploy_permissions_boundary]
}

resource "aws_iam_policy" "bootstrap_apply_app_lane_role_attachment_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = local.app_lane_role_attachment_management_policy_name
  policy = data.aws_iam_policy_document.bootstrap_apply_app_lane_role_attachment_management[0].json
  tags   = local.common_tags

  depends_on = [aws_iam_policy.bootstrap_deploy_permissions_boundary]
}

resource "aws_iam_policy" "bootstrap_apply_app_lane_artifacts_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  name   = local.app_lane_artifacts_management_policy_name
  policy = data.aws_iam_policy_document.bootstrap_apply_app_lane_artifacts_management[0].json
  tags   = local.common_tags

  depends_on = [aws_iam_policy.bootstrap_deploy_permissions_boundary]
}

resource "aws_iam_role_policy_attachment" "bootstrap_apply_app_lane_pipeline_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.bootstrap_apply_app_lane_pipeline_management[0].arn
}

resource "aws_iam_role_policy_attachment" "bootstrap_apply_app_lane_iam_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.bootstrap_apply_app_lane_iam_management[0].arn
}

resource "aws_iam_role_policy_attachment" "bootstrap_apply_app_lane_role_attachment_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.bootstrap_apply_app_lane_role_attachment_management[0].arn
}

resource "aws_iam_role_policy_attachment" "bootstrap_apply_app_lane_artifacts_management" {
  count = local.app_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.bootstrap_apply_app_lane_artifacts_management[0].arn
}

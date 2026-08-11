locals {
  pipeline_enabled = var.enable_development_pipeline
  development_pipeline_identity_approved = (
    var.enable_development_pipeline == false
    || (
      var.account_alias == local.deployment_target.accountLabel
      && var.deployment_environment == local.deployment_target.environmentId
      && var.state_scope == local.bootstrap_lane_authority.scope
      && var.source_branch == local.deployment_target.sourceBranch
    )
  )

  pipeline_name                 = local.bootstrap_lane_authority.names.pipeline
  codeconnection_name           = "sbs-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  pipeline_artifact_bucket_name = local.bootstrap_lane_authority.names.artifactBucket
  artifact_kms_alias            = local.bootstrap_lane_authority.names.artifactKmsAlias
  artifact_kms_alias_arn        = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.artifact_kms_alias}"

  pipeline_role_name        = local.bootstrap_lane_authority.names.pipelineRole
  terraform_plan_role_name  = local.bootstrap_lane_authority.names.terraformPlanRole
  terraform_apply_role_name = local.bootstrap_lane_authority.names.terraformApplyRole
  terraform_smoke_role_name = local.bootstrap_lane_authority.names.terraformSmokeRole
  terraform_smoke_role_arn  = "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_smoke_role_name}"
  github_trigger_role_name  = local.bootstrap_lane_authority.names.githubTriggerRole
  bootstrap_deploy_permissions_boundary_policy_name = (
    "${local.deployment_target.projectId}-bootstrap-deploy-boundary-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}-${local.bootstrap_lane_authority.scope}"
  )
  bootstrap_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_deploy_permissions_boundary_policy_name}"
  )
  bootstrap_apply_app_lane_policy_admin_policy_name = (
    "${local.deployment_target.projectId}-bootstrap-apply-app-lane-admin-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  )
  bootstrap_apply_artifact_management_policy_name = (
    "${local.deployment_target.projectId}-bootstrap-apply-artifacts-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}"
  )
  bootstrap_apply_artifact_management_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_apply_artifact_management_policy_name}"
  )
  bootstrap_apply_foundation_lane_policy_arns = local.foundation_pipeline_enabled ? local.foundation_lane_management_policy_arns : []
  bootstrap_apply_managed_policy_arns = concat(
    [
      "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_apply_app_lane_policy_admin_policy_name}",
      local.bootstrap_apply_artifact_management_policy_arn,
      local.terraform_baseline_authority_management_policy_arn,
      local.terraform_baseline_authority_runtime_management_policy_arn,
    ],
    local.bootstrap_apply_foundation_lane_policy_arns,
  )
  bootstrap_apply_administered_policy_arns = concat(
    local.bootstrap_apply_managed_policy_arns,
    local.foundation_pipeline_enabled ? [local.foundation_terraform_apply_workload_policy_arn] : [],
    values(local.terraform_drift_bootstrap_provider_policy_arns),
  )
  bootstrap_apply_managed_policy_attachment_count = length(distinct(concat(
    local.bootstrap_apply_managed_policy_arns,
    local.app_pipeline_enabled ? local.app_lane_management_policy_arns : [],
  )))
  validate_project_name        = local.bootstrap_lane_authority.names.validateProject
  terraform_plan_project_name  = local.bootstrap_lane_authority.names.terraformPlanProject
  terraform_apply_project_name = local.bootstrap_lane_authority.names.terraformApplyProject
  smoke_project_name           = local.bootstrap_lane_authority.names.smokeProject

  codebuild_project_names = [
    local.validate_project_name,
    local.terraform_plan_project_name,
    local.terraform_apply_project_name,
    local.smoke_project_name,
  ]

  codebuild_project_arns = [
    for name in local.codebuild_project_names :
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${name}"
  ]
  codebuild_log_group_arns = [
    for name in local.codebuild_project_names :
    "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${name}"
  ]
  codebuild_project_arn_pattern   = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.pipeline_name}-*"
  codebuild_log_group_arn_pattern = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.pipeline_name}-*"
  pipeline_arn                    = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.pipeline_name}"
  oidc_provider_arn               = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
  bootstrap_pipeline_role_name_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_plan_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_smoke_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.github_trigger_role_name}",
  ]
  bootstrap_pipeline_role_arn_patterns = [
    "arn:aws:iam::${var.aws_account_id}:role/stark-ballot-sim*-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}*",
    "arn:aws:iam::${var.aws_account_id}:role/sbs-*-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}*",
  ]
  bootstrap_pipeline_policy_arn_patterns = [
    "arn:aws:iam::${var.aws_account_id}:policy/${local.deployment_target.projectId}-*-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}*",
    "arn:aws:iam::${var.aws_account_id}:policy/stark-ballot-sim-tf-*-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}-*",
    "arn:aws:iam::${var.aws_account_id}:policy/sbs-terraform-drift-runner-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}-*",
  ]
  bootstrap_pipeline_role_arns = [
    aws_iam_role.pipeline[0].arn,
    aws_iam_role.terraform_plan[0].arn,
    aws_iam_role.terraform_apply[0].arn,
    aws_iam_role.terraform_smoke[0].arn,
    aws_iam_role.github_trigger[0].arn,
  ]

  terraform_distribution_sha256 = (
    "d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d"
  )

  pipeline_tfvars = {
    account_alias                                  = local.deployment_target.accountLabel
    aws_account_id                                 = local.deployment_target.accountId
    aws_region                                     = local.deployment_target.region
    backend_principal_arns                         = var.backend_principal_arns
    deployment_environment                         = local.deployment_target.environmentId
    development_app_cloudfront_acm_certificate_arn = var.development_app_cloudfront_acm_certificate_arn
    development_app_public_hostname                = var.development_app_public_hostname
    enable_development_app_pipeline                = true
    enable_development_foundation_pipeline         = true
    enable_development_pipeline                    = true
    github_full_repository_id                      = local.deployment_target.repository
    project_name                                   = local.deployment_target.projectId
    source_branch                                  = local.deployment_target.sourceBranch
    state_backend_key                              = local.bootstrap_lane_authority.backendKey
    state_bucket_name                              = var.state_bucket_name
    state_kms_alias                                = var.state_kms_alias
    state_kms_key_id                               = var.state_kms_key_id
    state_scope                                    = local.bootstrap_lane_authority.scope
    terraform_version                              = var.terraform_version
  }

  terraform_install_commands = [
    "set -eu",
    "curl -fsSLo /tmp/terraform.zip \"https://releases.hashicorp.com/terraform/${var.terraform_version}/terraform_${var.terraform_version}_linux_amd64.zip\"; echo \"${local.terraform_distribution_sha256}  /tmp/terraform.zip\" | sha256sum --check --status; unzip -q -o /tmp/terraform.zip -d /usr/local/bin",
    "terraform version -json > /tmp/stark-ballot-terraform-version.json && jq -e -c 'select(.terraform_version == \"${var.terraform_version}\" and .platform == \"linux_amd64\") | {terraform_version, platform}' /tmp/stark-ballot-terraform-version.json",
  ]

}

check "bootstrap_apply_managed_policy_attachment_quota" {
  assert {
    condition     = !local.pipeline_enabled || local.bootstrap_apply_managed_policy_attachment_count <= 10
    error_message = "The Bootstrap Terraform Apply role must stay within the default ten managed-policy attachment quota."
  }
}

resource "terraform_data" "development_pipeline_identity_guard" {
  input = "${local.bootstrap_lane_authority.stateIdentity}:${local.deployment_target.sourceBranch}"

  lifecycle {
    precondition {
      condition     = local.deployment_target_inputs_exact
      error_message = "Bootstrap inputs must match the exact reviewed stark-dev/develop target and lane configuration."
    }

    precondition {
      condition     = local.development_pipeline_identity_approved
      error_message = "enable_development_pipeline=true is approved only for ${local.bootstrap_lane_authority.stateIdentity} from source_branch=${local.deployment_target.sourceBranch}."
    }
  }
}

data "aws_iam_policy_document" "pipeline_assume_role" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codepipeline.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "codebuild_assume_role" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_codeconnections_connection" "source" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.codeconnection_name
  provider_type = "GitHub"

  tags = merge(local.common_tags, {
    Name = local.codeconnection_name
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  count = local.pipeline_enabled ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = merge(local.common_tags, {
    Name = "token.actions.githubusercontent.com"
  })
}

data "aws_iam_policy_document" "bootstrap_deploy_permissions_boundary" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["s3:*"]
    resources = [
      local.terraform_authority_bucket_arn,
      "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.bootstrap_lane_authority.stateIdentity}/executions/*",
      "arn:aws:s3:::${local.terraform_authority_bucket_name}/${local.terraform_baseline_prefix}/${local.bootstrap_lane_authority.stateIdentity}/current.json",
    ]
  }

  statement {
    effect    = "Allow"
    actions   = ["scheduler:*"]
    resources = [local.terraform_drift_schedule_arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["sqs:*"]
    resources = [local.terraform_drift_missed_queue_arn]
  }

  statement {
    effect = "Allow"

    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${local.pipeline_artifact_bucket_name}",
      "arn:aws:s3:::${local.pipeline_artifact_bucket_name}/*",
    ]
  }

  statement {
    effect = "Allow"

    actions = ["s3:*"]
    resources = [
      "arn:aws:s3:::${var.state_bucket_name}",
      "arn:aws:s3:::${var.state_bucket_name}/${var.state_backend_key}",
      "arn:aws:s3:::${var.state_bucket_name}/${local.state_lockfile_key}",
    ]
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [1] : []

    content {
      effect = "Allow"

      actions = [
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "kms:GetKeyRotationStatus",
        "kms:ListResourceTags",
        "kms:PutKeyPolicy",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
      ]
      resources = [
        "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/${var.state_kms_key_id}",
        "arn:aws:s3:::${var.state_bucket_name}",
      ]
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [1] : []

    content {
      effect = "Allow"

      actions = ["iam:*"]
      resources = concat(
        local.bootstrap_pipeline_policy_arn_patterns,
        local.terraform_drift_managed_policy_arns,
        local.bootstrap_pipeline_role_arn_patterns,
        local.foundation_pipeline_enabled ? [
          local.foundation_ecr_retention_boundary_policy_arn,
        ] : [],
      )
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled || local.foundation_pipeline_enabled ? [1] : []

    content {
      effect = "Allow"

      actions = ["s3:*"]
      resources = concat(
        local.app_pipeline_enabled ? [
          local.app_retained_artifact_bucket_arn,
          local.app_pipeline_execution_artifact_bucket_arn,
          local.app_static_fast_execution_artifact_bucket_arn,
        ] : [],
        local.foundation_pipeline_enabled ? [
          local.foundation_pipeline_artifact_bucket_arn,
        ] : [],
      )
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [1] : []

    content {
      effect = "Allow"

      actions   = ["kms:*"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [1] : []

    content {
      effect = "Allow"

      actions = [
        "codebuild:*",
        "codepipeline:*",
      ]
      # The boundary admits the target's standard project family; attached
      # identity policies continue to enumerate the managed projects exactly.
      resources = [
        "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.deployment_target.projectId}-*-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}*",
        "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.deployment_target.projectId}-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}-*",
        "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.deployment_target.projectId}-pipeline-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}*",
      ]
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [] : [1]

    content {
      effect = "Allow"

      actions = [
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:GenerateDataKeyWithoutPlaintext",
        "kms:ReEncryptFrom",
        "kms:ReEncryptTo",
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
        variable = "aws:ResourceTag/StateScope"
        values   = [var.state_scope]
      }
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [] : [1]

    content {
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
        values = [
          var.state_scope,
          "foundation",
        ]
      }
    }
  }

  statement {
    effect = "Allow"

    actions = [
      "kms:CreateAlias",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:PutKeyPolicy",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
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
      values = [
        var.state_scope,
        "foundation",
      ]
    }
  }

  statement {
    effect = "Allow"

    actions = [
      "kms:CreateAlias",
      "kms:UpdateAlias",
    ]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:alias/${local.deployment_target.projectId}-pipeline-${local.deployment_target.accountLabel}-${local.deployment_target.environmentId}*artifacts"]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:ListAliases"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [] : [1]

    content {
      effect = "Allow"

      actions = [
        "codebuild:*",
        "codepipeline:*",
      ]
      resources = [
        local.codebuild_project_arn_pattern,
        "${local.pipeline_arn}*",
      ]
    }
  }

  statement {
    effect = "Allow"

    actions   = ["codeconnections:CreateConnection"]
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
      values   = [var.state_scope]
    }
  }

  statement {
    effect = "Allow"

    actions = [
      "codeconnections:DeleteConnection",
      "codeconnections:GetConnection",
      "codeconnections:ListTagsForResource",
      "codeconnections:PassConnection",
      "codeconnections:TagResource",
      "codeconnections:UntagResource",
      "codeconnections:UseConnection",
      "codestar-connections:PassConnection",
      "codestar-connections:UseConnection",
    ]
    resources = local.app_source_connection_arns
  }

  statement {
    effect = "Allow"

    actions = [
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
    ]
    resources = [local.oidc_provider_arn]
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [] : [1]

    content {
      effect = "Allow"

      actions = [
        "iam:CreateRole",
        "iam:PutRolePermissionsBoundary",
      ]
      resources = local.bootstrap_pipeline_role_arn_patterns

      condition {
        test     = "StringEquals"
        variable = "iam:PermissionsBoundary"
        values   = [local.bootstrap_deploy_permissions_boundary_policy_arn]
      }
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [] : [1]

    content {
      effect = "Allow"

      actions = [
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:ListRoleTags",
        "iam:PutRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
      ]
      resources = local.bootstrap_pipeline_role_arn_patterns
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [] : [1]

    content {
      effect = "Allow"

      actions   = ["iam:PassRole"]
      resources = local.bootstrap_pipeline_role_arn_patterns

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

  statement {
    effect = "Allow"

    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
    ]
    resources = [local.bootstrap_deploy_permissions_boundary_policy_arn]
  }

  statement {
    effect = "Allow"

    actions   = ["logs:*"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "bootstrap_deploy_permissions_boundary" {
  count = local.pipeline_enabled ? 1 : 0

  name   = local.bootstrap_deploy_permissions_boundary_policy_name
  policy = data.aws_iam_policy_document.bootstrap_deploy_permissions_boundary[0].json
  tags   = local.common_tags

  lifecycle {
    precondition {
      condition     = length(jsonencode(jsondecode(data.aws_iam_policy_document.bootstrap_deploy_permissions_boundary[0].json))) <= 6144
      error_message = "The bootstrap deploy permissions boundary must remain within the IAM 6,144-character quota."
    }
  }
}

data "aws_iam_policy_document" "github_trigger_assume_role" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${local.deployment_target.repository}:ref:refs/heads/${local.deployment_target.sourceBranch}"]
    }
  }
}

resource "aws_iam_role" "github_trigger" {
  count = local.pipeline_enabled ? 1 : 0

  name                 = local.github_trigger_role_name
  assume_role_policy   = data.aws_iam_policy_document.github_trigger_assume_role[0].json
  permissions_boundary = aws_iam_policy.bootstrap_deploy_permissions_boundary[0].arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "github_trigger" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid    = "TriggerAndObserveDevelopmentPipeline"
    effect = "Allow"

    actions = [
      "codepipeline:GetPipelineExecution",
      "codepipeline:GetPipelineState",
      "codepipeline:ListPipelineExecutions",
      "codepipeline:StartPipelineExecution",
    ]

    resources = [aws_codepipeline.development[0].arn]
  }
}

resource "aws_iam_role_policy" "github_trigger" {
  count = local.pipeline_enabled ? 1 : 0

  name   = "${local.github_trigger_role_name}-policy"
  role   = aws_iam_role.github_trigger[0].id
  policy = data.aws_iam_policy_document.github_trigger[0].json
}

data "aws_iam_policy_document" "artifact_kms_key" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid    = "EnableAccountRootAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowPipelineArtifactKeyUse"
    effect = "Allow"

    principals {
      type = "AWS"
      identifiers = [
        aws_iam_role.pipeline[0].arn,
        aws_iam_role.terraform_plan[0].arn,
        aws_iam_role.terraform_apply[0].arn,
        aws_iam_role.terraform_smoke[0].arn,
      ]
    }

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]
  }
}

resource "aws_kms_key" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  description             = "STARK Ballot Simulator pipeline artifact key for ${local.bootstrap_lane_authority.stateIdentity}"
  deletion_window_in_days = 30
  key_usage               = "ENCRYPT_DECRYPT"
  policy                  = data.aws_iam_policy_document.artifact_kms_key[0].json
  tags                    = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.artifact_kms_alias
  target_key_id = aws_kms_key.pipeline_artifacts[0].key_id
}

resource "aws_s3_bucket" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = local.pipeline_artifact_bucket_name
  tags   = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.pipeline_artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.pipeline_artifacts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.pipeline_artifacts[0].id

  rule {
    id     = "expire-pipeline-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = local.storage_retention.bootstrap_pipeline_artifact_days
    }

    noncurrent_version_expiration {
      noncurrent_days = local.storage_retention.bootstrap_pipeline_artifact_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = local.storage_retention.incomplete_multipart_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.pipeline_artifacts[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_alias.pipeline_artifacts[0].name
      sse_algorithm     = "aws:kms"
    }

    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "pipeline_artifacts_bucket" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.pipeline_artifacts[0].arn,
      "${aws_s3_bucket.pipeline_artifacts[0].arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "pipeline_artifacts" {
  count = local.pipeline_enabled ? 1 : 0

  bucket = aws_s3_bucket.pipeline_artifacts[0].id
  policy = data.aws_iam_policy_document.pipeline_artifacts_bucket[0].json
}

resource "aws_iam_role" "pipeline" {
  count = local.pipeline_enabled ? 1 : 0

  name                 = local.pipeline_role_name
  assume_role_policy   = data.aws_iam_policy_document.pipeline_assume_role[0].json
  permissions_boundary = aws_iam_policy.bootstrap_deploy_permissions_boundary[0].arn
  tags                 = local.common_tags
}

resource "aws_iam_role" "terraform_plan" {
  count = local.pipeline_enabled ? 1 : 0

  name                 = local.terraform_plan_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.bootstrap_deploy_permissions_boundary[0].arn
  tags                 = local.common_tags
}

resource "aws_iam_role" "terraform_smoke" {
  count = local.pipeline_enabled ? 1 : 0

  depends_on = [
    aws_iam_role_policy.terraform_apply_smoke_role_bootstrap,
    terraform_data.bootstrap_apply_authorization_propagation,
  ]

  name                 = local.terraform_smoke_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.bootstrap_deploy_permissions_boundary[0].arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "terraform_apply_smoke_role_bootstrap" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid       = "CreateExactBootstrapTerraformSmokeRole"
    effect    = "Allow"
    actions   = ["iam:CreateRole"]
    resources = [local.terraform_smoke_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.bootstrap_deploy_permissions_boundary_policy_arn]
    }
  }

  statement {
    sid       = "TagExactBootstrapTerraformSmokeRole"
    effect    = "Allow"
    actions   = ["iam:TagRole"]
    resources = [local.terraform_smoke_role_arn]
  }

  statement {
    sid    = "ReadExactBootstrapTerraformSmokeRole"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
    ]
    resources = [local.terraform_smoke_role_arn]
  }

  statement {
    sid       = "PassExactBootstrapTerraformSmokeRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [local.terraform_smoke_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "terraform_apply_smoke_role_bootstrap" {
  count = local.pipeline_enabled ? 1 : 0

  name   = "${local.terraform_apply_role_name}-smoke-role-bootstrap"
  role   = aws_iam_role.terraform_apply[0].id
  policy = data.aws_iam_policy_document.terraform_apply_smoke_role_bootstrap[0].json
}

resource "aws_iam_role" "terraform_apply" {
  count = local.pipeline_enabled ? 1 : 0

  name                 = local.terraform_apply_role_name
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume_role[0].json
  permissions_boundary = aws_iam_policy.bootstrap_deploy_permissions_boundary[0].arn
  tags                 = local.common_tags
}

data "aws_iam_policy_document" "pipeline" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid    = "UseSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:GetConnection",
      "codeconnections:GetConnectionToken",
      "codeconnections:UseConnection",
      "codestar-connections:GetConnection",
      "codestar-connections:GetConnectionToken",
      "codestar-connections:UseConnection",
    ]
    resources = [aws_codeconnections_connection.source[0].arn]
  }

  statement {
    sid    = "RunCodeBuildProjects"
    effect = "Allow"

    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
    ]
    resources = local.codebuild_project_arns
  }

  statement {
    sid    = "UsePipelineArtifactBucket"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.pipeline_artifacts[0].arn,
      "${aws_s3_bucket.pipeline_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid    = "UsePipelineArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.pipeline_artifacts[0].arn]
  }
}

resource "aws_iam_role_policy" "pipeline" {
  count = local.pipeline_enabled ? 1 : 0

  name   = "${local.pipeline_role_name}-policy"
  role   = aws_iam_role.pipeline[0].id
  policy = data.aws_iam_policy_document.pipeline[0].json
}

data "aws_iam_policy_document" "codebuild_common" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid    = "WriteCodeBuildLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      for log_group in module.bootstrap_pipeline_codebuild_log_groups.log_groups :
      "${log_group.arn}:*"
    ]
  }

  statement {
    sid    = "ReadCodeBuildLogGroups"
    effect = "Allow"

    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid    = "UsePipelineArtifacts"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.pipeline_artifacts[0].arn,
      "${aws_s3_bucket.pipeline_artifacts[0].arn}/*",
    ]
  }

  statement {
    sid    = "UsePipelineArtifactKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.pipeline_artifacts[0].arn]
  }

  statement {
    sid    = "ReadBootstrapStateBackend"
    effect = "Allow"

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/${var.state_backend_key}"]
  }

  statement {
    sid    = "UseBootstrapStateLockfile"
    effect = "Allow"

    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.state.arn}/${local.state_lockfile_key}"]
  }

  statement {
    sid    = "ListBootstrapStatePrefix"
    effect = "Allow"

    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        local.state_backend_prefix,
        "${local.state_backend_prefix}*",
      ]
    }
  }

  statement {
    sid    = "UseBootstrapStateKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
    ]
    resources = [aws_kms_key.state.arn]
  }
}

data "aws_iam_policy_document" "terraform_plan" {
  count = local.pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.codebuild_common[0].json]

  statement {
    sid    = "ReadBootstrapSourceConnectionForPlan"
    effect = "Allow"

    actions   = ["codeconnections:GetConnection"]
    resources = [aws_codeconnections_connection.source[0].arn]
  }

  statement {
    sid    = "ReadBootstrapResourcesForPlan"
    effect = "Allow"

    actions = [
      "codebuild:BatchGetProjects",
      "codebuild:ListTagsForResource",
      "codeconnections:ListTagsForResource",
      "codepipeline:GetPipeline",
      "codepipeline:ListActionExecutions",
      "codepipeline:ListTagsForResource",
      "iam:GetOpenIDConnectProvider",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListAttachedRolePolicies",
      "iam:ListPolicyVersions",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListAliases",
      "kms:ListResourceTags",
      "logs:DescribeLogGroups",
      "logs:ListTagsForResource",
      "s3:Get*",
      "s3:ListBucket",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ReadExactTerraformDriftScheduleForPlan"
    effect = "Allow"

    actions   = ["scheduler:GetSchedule"]
    resources = [local.terraform_drift_schedule_arn]
  }

  statement {
    sid    = "ReadExactTerraformDriftMissedQueueForPlan"
    effect = "Allow"

    actions = [
      "sqs:GetQueueAttributes",
      "sqs:ListQueueTags",
    ]
    resources = [local.terraform_drift_missed_queue_arn]
  }

}

resource "aws_iam_role_policy" "terraform_plan" {
  count = local.pipeline_enabled ? 1 : 0

  name   = "${local.terraform_plan_role_name}-policy"
  role   = aws_iam_role.terraform_plan[0].id
  policy = data.aws_iam_policy_document.terraform_plan[0].json
}

data "aws_iam_policy_document" "terraform_smoke" {
  count = local.pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.terraform_plan[0].json]

  statement {
    sid       = "DenyCrossAccountBootstrapStateKeyUse"
    effect    = "Deny"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"]
    resources = [aws_kms_key.state.arn]

    condition {
      test     = "StringNotEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }
  }

  statement {
    sid       = "DenyDirectBootstrapStateKeyUse"
    effect    = "Deny"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"]
    resources = [aws_kms_key.state.arn]

    condition {
      test     = "StringNotEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "DenyBootstrapStateKeyUseOutsideStateBucket"
    effect    = "Deny"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"]
    resources = [aws_kms_key.state.arn]

    condition {
      test     = "StringNotEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.state.arn]
    }
  }
}

resource "aws_iam_role_policy" "terraform_smoke" {
  count = local.pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_role_policy.terraform_apply]

  name   = "${local.terraform_smoke_role_name}-policy"
  role   = aws_iam_role.terraform_smoke[0].id
  policy = data.aws_iam_policy_document.terraform_smoke[0].json
}

data "aws_iam_policy_document" "terraform_apply" {
  count = local.pipeline_enabled ? 1 : 0

  source_policy_documents = [data.aws_iam_policy_document.codebuild_common[0].json]

  statement {
    sid    = "WriteBootstrapStateBackend"
    effect = "Allow"

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state.arn}/${var.state_backend_key}"]
  }

  statement {
    sid    = "ManageBootstrapCodeBuildProjects"
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
    resources = local.codebuild_project_arns
  }

  statement {
    sid    = "ManageBootstrapCodePipeline"
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
      local.pipeline_arn,
      "${local.pipeline_arn}/*",
    ]
  }

  statement {
    sid    = "ManageBootstrapDeployBoundaryPolicy"
    effect = "Allow"

    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:SetDefaultPolicyVersion",
    ]
    resources = [local.bootstrap_deploy_permissions_boundary_policy_arn]
  }

  statement {
    sid    = "CreateBootstrapSourceConnection"
    effect = "Allow"

    actions   = ["codeconnections:CreateConnection"]
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
      values   = [var.state_scope]
    }
  }

  statement {
    sid    = "ManageBootstrapSourceConnection"
    effect = "Allow"

    actions = [
      "codeconnections:DeleteConnection",
      "codeconnections:GetConnection",
      "codeconnections:ListTagsForResource",
      "codeconnections:TagResource",
      "codeconnections:UntagResource",
    ]
    resources = [aws_codeconnections_connection.source[0].arn]
  }

  statement {
    sid    = "ManageBootstrapOidcProvider"
    effect = "Allow"

    actions = [
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
    ]
    resources = [local.oidc_provider_arn]
  }

  statement {
    sid    = "CreateOrAttachBootstrapPipelineRoleBoundary"
    effect = "Allow"

    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = local.bootstrap_pipeline_role_arns

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.bootstrap_deploy_permissions_boundary_policy_arn]
    }
  }

  statement {
    sid    = "ManageBootstrapPipelineRoles"
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
    resources = local.bootstrap_pipeline_role_arns
  }

  statement {
    sid    = "PassBootstrapPipelineRoles"
    effect = "Allow"

    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.pipeline[0].arn,
      aws_iam_role.terraform_plan[0].arn,
      aws_iam_role.terraform_apply[0].arn,
      aws_iam_role.terraform_smoke[0].arn,
    ]

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

data "aws_iam_policy_document" "terraform_apply_app_lane_policy_admin" {
  count = local.pipeline_enabled && local.app_pipeline_enabled ? 1 : 0

  statement {
    sid    = "CreateAppLanePolicies"
    effect = "Allow"

    actions = ["iam:CreatePolicy"]
    resources = concat(
      local.app_lane_management_policy_arns,
      local.bootstrap_apply_administered_policy_arns,
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
        var.state_scope,
        "app",
        "foundation",
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
    sid    = "ManageAppLanePolicies"
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
    resources = concat(
      local.app_lane_management_policy_arns,
      local.bootstrap_apply_administered_policy_arns,
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
        var.state_scope,
        "foundation",
      ]
    }
  }

}

resource "aws_iam_policy" "terraform_apply_app_lane_policy_admin" {
  count = local.pipeline_enabled && local.app_pipeline_enabled ? 1 : 0

  name   = local.bootstrap_apply_app_lane_policy_admin_policy_name
  policy = data.aws_iam_policy_document.terraform_apply_app_lane_policy_admin[0].json
  tags   = local.common_tags
}

check "terraform_apply_app_lane_policy_admin_size" {
  assert {
    condition = (
      !local.pipeline_enabled
      || !local.app_pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_apply_app_lane_policy_admin[0].json))) <= 6144, false)
    )
    error_message = "The bootstrap app-lane policy-admin managed policy must remain within the IAM 6,144-character quota."
  }
}

resource "aws_iam_role_policy_attachment" "terraform_apply_app_lane_policy_admin" {
  count = local.pipeline_enabled && local.app_pipeline_enabled ? 1 : 0

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.terraform_apply_app_lane_policy_admin[0].arn
}

resource "aws_iam_role_policy" "terraform_apply" {
  count = local.pipeline_enabled ? 1 : 0

  name   = "${local.terraform_apply_role_name}-policy"
  role   = aws_iam_role.terraform_apply[0].id
  policy = data.aws_iam_policy_document.terraform_apply[0].json
}

check "terraform_apply_inline_policy_size" {
  assert {
    condition = (
      !local.pipeline_enabled
      || try(
        length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_apply[0].json)))
        + length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_apply_smoke_role_bootstrap[0].json))) <= 10240,
        false,
      )
    )
    error_message = "The bootstrap Terraform apply aggregate inline policies must remain within the IAM 10,240-character role-policy quota."
  }
}

data "aws_iam_policy_document" "terraform_apply_artifact_management" {
  count = local.pipeline_enabled ? 1 : 0

  statement {
    sid    = "CreateBootstrapArtifactKey"
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
      values   = [var.state_scope]
    }
  }

  statement {
    sid    = "ManageBootstrapArtifactKey"
    effect = "Allow"

    actions = [
      "kms:CreateAlias",
      "kms:DescribeKey",
      "kms:GetKeyRotationStatus",
      "kms:GetKeyPolicy",
      "kms:PutKeyPolicy",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
    ]
    resources = [
      aws_kms_key.pipeline_artifacts[0].arn,
      local.artifact_kms_alias_arn,
      local.foundation_artifact_kms_alias_arn,
    ]
  }

  statement {
    sid    = "ReadBootstrapArtifactKeyMetadata"
    effect = "Allow"

    actions = [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
    ]
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/*"]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values = [
        local.artifact_kms_alias,
        local.app_artifact_kms_alias,
        local.foundation_artifact_kms_alias,
      ]
    }
  }

  statement {
    sid    = "ListBootstrapKmsAliases"
    effect = "Allow"

    actions   = ["kms:ListAliases"]
    resources = ["*"]
  }

  statement {
    sid    = "ManageBootstrapCodeBuildLogGroups"
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
    resources = concat(
      [
        local.codebuild_log_group_arn_pattern,
        "${local.codebuild_log_group_arn_pattern}:*",
      ],
      local.foundation_bootstrap_managed_codebuild_log_group_resource_arn_patterns,
    )
  }

  statement {
    sid    = "ManageBootstrapArtifactBucket"
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
    resources = [aws_s3_bucket.pipeline_artifacts[0].arn]
  }

  statement {
    sid    = "ManageStateBucketLifecycle"
    effect = "Allow"

    actions = [
      "s3:GetLifecycleConfiguration",
      "s3:PutLifecycleConfiguration",
    ]
    resources = [aws_s3_bucket.state.arn]
  }
}

resource "aws_iam_policy" "terraform_apply_artifact_management" {
  count = local.pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_policy.terraform_apply_app_lane_policy_admin]

  name   = local.bootstrap_apply_artifact_management_policy_name
  policy = data.aws_iam_policy_document.terraform_apply_artifact_management[0].json
  tags   = local.common_tags
}

check "terraform_apply_artifact_management_policy_size" {
  assert {
    condition = (
      !local.pipeline_enabled
      || try(length(jsonencode(jsondecode(data.aws_iam_policy_document.terraform_apply_artifact_management[0].json))) <= 6144, false)
    )
    error_message = "The bootstrap artifact-management managed policy must remain within the IAM 6,144-character quota."
  }
}

resource "aws_iam_role_policy_attachment" "terraform_apply_artifact_management" {
  count = local.pipeline_enabled ? 1 : 0

  depends_on = [aws_iam_policy.terraform_apply_app_lane_policy_admin]

  role       = aws_iam_role.terraform_apply[0].name
  policy_arn = aws_iam_policy.terraform_apply_artifact_management[0].arn
}

resource "aws_codebuild_project" "validate" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.validate_project_name
  service_role  = aws_iam_role.terraform_plan[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.bootstrap_pipeline_codebuild_log_groups.log_groups[local.validate_project_name].name
      stream_name = "validate"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-bootstrap-validate.yml.tftpl", {
      aws_account_id             = var.aws_account_id
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = local.common_tags
}

resource "aws_codebuild_project" "terraform_plan" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.terraform_plan_project_name
  service_role  = aws_iam_role.terraform_plan[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.bootstrap_pipeline_codebuild_log_groups.log_groups[local.terraform_plan_project_name].name
      stream_name = "plan"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-bootstrap-plan.yml.tftpl", {
      aws_region                 = local.deployment_target.region
      backend_key                = local.bootstrap_lane_authority.backendKey
      pipeline_tfvars_base64     = base64encode(jsonencode(local.pipeline_tfvars))
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = local.common_tags
}

resource "aws_codebuild_project" "terraform_apply" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.terraform_apply_project_name
  service_role  = aws_iam_role.terraform_apply[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.bootstrap_pipeline_codebuild_log_groups.log_groups[local.terraform_apply_project_name].name
      stream_name = "apply"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-bootstrap-apply.yml.tftpl", {
      aws_region                 = local.deployment_target.region
      backend_key                = local.bootstrap_lane_authority.backendKey
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = local.common_tags
}

resource "aws_codebuild_project" "bootstrap_smoke" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.smoke_project_name
  service_role  = aws_iam_role.terraform_smoke[0].arn
  build_timeout = 20

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:8.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = module.bootstrap_pipeline_codebuild_log_groups.log_groups[local.smoke_project_name].name
      stream_name = "smoke"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = templatefile("${path.module}/buildspec-bootstrap-smoke.yml.tftpl", {
      aws_region                 = local.deployment_target.region
      backend_key                = local.bootstrap_lane_authority.backendKey
      pipeline_tfvars_base64     = base64encode(jsonencode(local.pipeline_tfvars))
      state_bucket_name          = aws_s3_bucket.state.bucket
      state_kms_alias            = var.state_kms_alias
      state_kms_key_arn          = aws_kms_key.state.arn
      terraform_install_commands = jsonencode(local.terraform_install_commands)
    })
  }

  tags = local.common_tags
}

resource "aws_codepipeline" "development" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.pipeline_name
  pipeline_type = "V2"
  role_arn      = aws_iam_role.pipeline[0].arn

  artifact_store {
    location = aws_s3_bucket.pipeline_artifacts[0].bucket
    type     = "S3"

    encryption_key {
      id   = aws_kms_key.pipeline_artifacts[0].arn
      type = "KMS"
    }
  }

  stage {
    name = local.deployment_target.sourceAction

    action {
      name             = local.deployment_target.sourceAction
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      namespace        = "BootstrapSource"
      output_artifacts = ["SourceOutput"]

      configuration = {
        BranchName           = local.deployment_target.sourceBranch
        ConnectionArn        = aws_codeconnections_connection.source[0].arn
        DetectChanges        = "false"
        FullRepositoryId     = local.deployment_target.repository
        OutputArtifactFormat = "CODE_ZIP"
      }
    }
  }

  stage {
    name = "ValidatePackage"

    action {
      name             = "Validate"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["BootstrapContextOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          {
            name  = "BOOTSTRAP_SOURCE_ACTION_SHA"
            value = "#{BootstrapSource.CommitId}"
            type  = "PLAINTEXT"
          },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.validate[0].name
      }
    }
  }

  stage {
    name = "TerraformPlan"

    action {
      name             = "Plan"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "BootstrapContextOutput"]
      output_artifacts = ["PlanOutput"]

      configuration = {
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.terraform_plan[0].name
      }
    }
  }

  stage {
    name = "ManualApproval"

    action {
      name     = "ApproveInitialDevelopmentApply"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        CustomData = "Approve only after reviewing PlanOutput/infra/terraform/bootstrap/tfplan.txt and PlanOutput/infra/terraform/bootstrap/tfplan.sha256 for ${local.bootstrap_lane_authority.stateIdentity}. Approval summary must be exact JSON: {\"sourceSha\":\"#{BootstrapSource.CommitId}\",\"accountId\":\"${local.deployment_target.accountId}\",\"deploymentEnvironment\":\"${local.deployment_target.environmentId}\",\"reviewedPlanChecksum\":\"<tfplan sha256>\"}."
      }
    }
  }

  stage {
    name = "TerraformApply"

    action {
      name            = "ApplySavedPlan"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["SourceOutput", "PlanOutput", "BootstrapContextOutput"]

      configuration = {
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.terraform_apply[0].name
      }
    }
  }

  stage {
    name = "PostApplySmoke"

    action {
      name             = "NoChangePlan"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["SourceOutput", "PlanOutput", "BootstrapContextOutput"]
      output_artifacts = ["BootstrapSmokeEvidenceOutput"]

      configuration = {
        EnvironmentVariables = jsonencode([
          { name = "TERRAFORM_BASELINE_PIPELINE_EXECUTION_ID", value = "#{codepipeline.PipelineExecutionId}", type = "PLAINTEXT" },
          { name = "PIPELINE_SOURCE_SHA", value = "#{BootstrapSource.CommitId}", type = "PLAINTEXT" },
        ])
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.bootstrap_smoke[0].name
      }
    }
  }

  tags = local.common_tags
}

locals {
  pipeline_enabled = var.enable_development_pipeline
  development_pipeline_identity_approved = (
    var.enable_development_pipeline == false
    || (
      var.account_alias == "stark-dev"
      && var.deployment_environment == "develop"
      && var.state_scope == "bootstrap"
      && var.source_branch == "develop"
    )
  )

  pipeline_name                 = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}"
  codeconnection_name           = "sbs-${var.account_alias}-${var.deployment_environment}"
  pipeline_artifact_bucket_name = coalesce(var.pipeline_artifact_bucket_name, "sbs-pipeline-artifacts-${var.account_alias}-${var.deployment_environment}-${var.aws_account_id}")
  artifact_kms_alias            = "alias/${local.pipeline_name}-artifacts"
  artifact_kms_alias_arn        = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:${local.artifact_kms_alias}"

  pipeline_role_name        = "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}"
  terraform_plan_role_name  = "stark-ballot-sim-tf-plan-${var.account_alias}-${var.deployment_environment}-${var.state_scope}"
  terraform_apply_role_name = "stark-ballot-sim-tf-apply-${var.account_alias}-${var.deployment_environment}-${var.state_scope}"
  github_trigger_role_name  = "${var.project_name}-github-trigger-${var.account_alias}-${var.deployment_environment}"
  bootstrap_deploy_permissions_boundary_policy_name = (
    "${var.project_name}-bootstrap-deploy-boundary-${var.account_alias}-${var.deployment_environment}-${var.state_scope}"
  )
  bootstrap_deploy_permissions_boundary_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_deploy_permissions_boundary_policy_name}"
  )
  bootstrap_apply_app_lane_policy_admin_policy_name = (
    "${var.project_name}-bootstrap-apply-app-lane-admin-${var.account_alias}-${var.deployment_environment}"
  )
  bootstrap_apply_artifact_management_policy_name = (
    "${var.project_name}-bootstrap-apply-artifacts-${var.account_alias}-${var.deployment_environment}"
  )
  bootstrap_apply_artifact_management_policy_arn = (
    "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_apply_artifact_management_policy_name}"
  )
  bootstrap_apply_foundation_lane_policy_arns = local.foundation_pipeline_enabled ? concat(
    local.foundation_lane_management_policy_arns,
    [local.foundation_terraform_apply_workload_policy_arn],
  ) : []
  bootstrap_apply_managed_policy_arns = concat(
    [
      "arn:aws:iam::${var.aws_account_id}:policy/${local.bootstrap_apply_app_lane_policy_admin_policy_name}",
      local.bootstrap_apply_artifact_management_policy_arn,
    ],
    local.bootstrap_apply_foundation_lane_policy_arns,
  )
  validate_project_name        = "${local.pipeline_name}-validate"
  terraform_plan_project_name  = "${local.pipeline_name}-terraform-plan"
  terraform_apply_project_name = "${local.pipeline_name}-terraform-apply"
  smoke_project_name           = "${local.pipeline_name}-bootstrap-smoke"

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
  codebuild_project_arn_pattern   = "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.pipeline_name}-*"
  codebuild_log_group_arn_pattern = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/codebuild/${local.pipeline_name}-*"
  pipeline_arn                    = "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${local.pipeline_name}"
  oidc_provider_arn               = "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com"
  bootstrap_pipeline_role_name_arns = [
    "arn:aws:iam::${var.aws_account_id}:role/${local.pipeline_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_plan_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.terraform_apply_role_name}",
    "arn:aws:iam::${var.aws_account_id}:role/${local.github_trigger_role_name}",
  ]
  bootstrap_pipeline_role_arn_pattern = "arn:aws:iam::${var.aws_account_id}:role/*-${var.account_alias}-${var.deployment_environment}*"
  bootstrap_pipeline_role_arns = [
    aws_iam_role.pipeline[0].arn,
    aws_iam_role.terraform_plan[0].arn,
    aws_iam_role.terraform_apply[0].arn,
    aws_iam_role.github_trigger[0].arn,
  ]

  pipeline_tfvars = {
    account_alias                                  = var.account_alias
    aws_account_id                                 = var.aws_account_id
    aws_region                                     = var.aws_region
    backend_principal_arns                         = var.backend_principal_arns
    deployment_environment                         = var.deployment_environment
    development_app_cloudfront_acm_certificate_arn = var.development_app_cloudfront_acm_certificate_arn
    development_app_public_hostname                = var.development_app_public_hostname
    enable_development_app_pipeline                = true
    enable_development_foundation_pipeline         = true
    enable_development_pipeline                    = true
    github_full_repository_id                      = var.github_full_repository_id
    pipeline_artifact_bucket_name                  = local.pipeline_artifact_bucket_name
    project_name                                   = var.project_name
    source_branch                                  = var.source_branch
    state_backend_key                              = var.state_backend_key
    state_bucket_name                              = var.state_bucket_name
    state_kms_alias                                = var.state_kms_alias
    state_kms_key_id                               = var.state_kms_key_id
    state_scope                                    = var.state_scope
    terraform_version                              = var.terraform_version
  }

  terraform_install_commands = [
    "set -eu",
    "if ! command -v terraform >/dev/null 2>&1 || [ \"$(terraform version -json | jq -r .terraform_version)\" != \"${var.terraform_version}\" ]; then curl -fsSLo /tmp/terraform.zip \"https://releases.hashicorp.com/terraform/${var.terraform_version}/terraform_${var.terraform_version}_linux_amd64.zip\"; unzip -q -o /tmp/terraform.zip -d /usr/local/bin; fi",
    "terraform version -json > /tmp/stark-ballot-terraform-version.json && jq -e -c 'select(.terraform_version == \"${var.terraform_version}\" and .platform == \"linux_amd64\") | {terraform_version, platform}' /tmp/stark-ballot-terraform-version.json",
  ]

  bootstrap_backend_init_command = "terraform -chdir=infra/terraform/bootstrap init -backend-config=\"bucket=${aws_s3_bucket.state.bucket}\" -backend-config=\"key=${var.state_backend_key}\" -backend-config=\"region=${var.aws_region}\" -backend-config=\"encrypt=true\" -backend-config=\"kms_key_id=${var.state_kms_alias}\" -backend-config=\"use_lockfile=true\""
  bootstrap_tfvars_command       = "printf '%s' '${base64encode(jsonencode(local.pipeline_tfvars))}' | base64 -d > infra/terraform/bootstrap/pipeline.auto.tfvars.json"
}

resource "terraform_data" "development_pipeline_identity_guard" {
  input = "${var.account_alias}/${var.deployment_environment}/${var.state_scope}:${var.source_branch}"

  lifecycle {
    precondition {
      condition     = local.development_pipeline_identity_approved
      error_message = "enable_development_pipeline=true is approved only for stark-dev/develop/bootstrap from source_branch=develop."
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
      sid    = "AppBackend"
      effect = "Allow"

      actions = [
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
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
      resources = [
        "arn:aws:iam::${var.aws_account_id}:policy/${var.project_name}-*-${var.account_alias}-${var.deployment_environment}*",
        "arn:aws:iam::${var.aws_account_id}:policy/stark-ballot-sim-tf-apply-${var.account_alias}-${var.deployment_environment}-*",
        "arn:aws:iam::${var.aws_account_id}:policy/stark-ballot-sim-tf-plan-${var.account_alias}-${var.deployment_environment}-*",
        local.bootstrap_pipeline_role_arn_pattern,
      ]
    }
  }

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [1] : []

    content {
      effect = "Allow"

      actions   = ["s3:*"]
      resources = ["arn:aws:s3:::sbs-*-pipeline-artifacts-${var.account_alias}-${var.deployment_environment}-${var.aws_account_id}"]
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
      resources = [
        "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}*",
        local.foundation_image_signing_authority_resolver_project_arn,
        "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}*",
      ]
    }
  }

  statement {
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

  statement {
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
    resources = ["arn:aws:kms:${var.aws_region}:${var.aws_account_id}:alias/${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}*artifacts"]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:ListAliases"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"

    actions   = ["codebuild:*"]
    resources = [local.codebuild_project_arn_pattern]
  }

  statement {
    effect = "Allow"

    actions   = ["codepipeline:*"]
    resources = ["${local.pipeline_arn}*"]
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

  statement {
    sid    = "RoleBoundary"
    effect = "Allow"

    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = [local.bootstrap_pipeline_role_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.bootstrap_deploy_permissions_boundary_policy_arn]
    }
  }

  statement {
    sid    = "ManageRoles"
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
    resources = [local.bootstrap_pipeline_role_arn_pattern]
  }

  statement {
    sid    = "PassRoles"
    effect = "Allow"

    actions   = ["iam:PassRole"]
    resources = [local.bootstrap_pipeline_role_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "codebuild.amazonaws.com",
        "codepipeline.amazonaws.com",
      ]
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
      values   = ["repo:${var.github_full_repository_id}:ref:refs/heads/${var.source_branch}"]
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

  description             = "STARK Ballot Simulator pipeline artifact key for ${var.account_alias}/${var.deployment_environment}/${var.state_scope}"
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

resource "aws_cloudwatch_log_group" "pipeline_codebuild" {
  for_each = local.pipeline_enabled ? toset(local.codebuild_project_names) : toset([])

  name              = "/aws/codebuild/${each.key}"
  retention_in_days = local.storage_retention.bootstrap_codebuild_log_days
  tags              = local.common_tags
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
      for log_group in aws_cloudwatch_log_group.pipeline_codebuild :
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
      "codepipeline:GetPipelineState",
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

}

resource "aws_iam_role_policy" "terraform_plan" {
  count = local.pipeline_enabled ? 1 : 0

  name   = "${local.terraform_plan_role_name}-policy"
  role   = aws_iam_role.terraform_plan[0].id
  policy = data.aws_iam_policy_document.terraform_plan[0].json
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

  dynamic "statement" {
    for_each = local.app_pipeline_enabled ? [1] : []

    content {
      sid    = "ManageAppBackendGrantPolicies"
      effect = "Allow"

      actions = [
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "kms:PutKeyPolicy",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
      ]
      resources = [
        aws_kms_key.state.arn,
        aws_s3_bucket.state.arn,
      ]
    }
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
    resources = [aws_iam_policy.bootstrap_deploy_permissions_boundary[0].arn]
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
      values   = [aws_iam_policy.bootstrap_deploy_permissions_boundary[0].arn]
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
      local.bootstrap_apply_managed_policy_arns,
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
      local.bootstrap_apply_managed_policy_arns,
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

  statement {
    sid    = "AttachAppLanePolicies"
    effect = "Allow"

    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = [aws_iam_role.terraform_apply[0].arn]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = concat(local.app_lane_management_policy_arns, local.bootstrap_apply_managed_policy_arns)
    }
  }

  statement {
    sid       = "ListBootstrapApplyPolicies"
    effect    = "Allow"
    actions   = ["iam:ListAttachedRolePolicies"]
    resources = [aws_iam_role.terraform_apply[0].arn]
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
      || try(length(data.aws_iam_policy_document.terraform_apply[0].json) <= 10240, false)
    )
    error_message = "The bootstrap Terraform apply inline policy must remain within the IAM 10,240-character role-policy quota."
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
      "s3:GetBucketEncryption",
      "s3:GetBucketPolicy",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketTagging",
      "s3:GetBucketVersioning",
      "s3:GetLifecycleConfiguration",
      "s3:ListBucket",
      "s3:PutBucketEncryption",
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
      group_name  = aws_cloudwatch_log_group.pipeline_codebuild[local.validate_project_name].name
      stream_name = "validate"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            "terraform -chdir=infra/terraform/bootstrap init -backend=false",
            "terraform -chdir=infra/terraform/bootstrap fmt -check -recursive",
            "terraform -chdir=infra/terraform/bootstrap validate",
          ]
        }
      }
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
      group_name  = aws_cloudwatch_log_group.pipeline_codebuild[local.terraform_plan_project_name].name
      stream_name = "plan"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            local.bootstrap_backend_init_command,
            local.bootstrap_tfvars_command,
            "terraform -chdir=infra/terraform/bootstrap validate",
            "terraform -chdir=infra/terraform/bootstrap plan -out=tfplan",
            "terraform -chdir=infra/terraform/bootstrap show -no-color tfplan > infra/terraform/bootstrap/tfplan.txt",
            "sha256sum infra/terraform/bootstrap/tfplan > infra/terraform/bootstrap/tfplan.sha256",
          ]
        }
      }
      artifacts = {
        files = [
          "infra/terraform/bootstrap/.terraform.lock.hcl",
          "infra/terraform/bootstrap/tfplan",
          "infra/terraform/bootstrap/tfplan.txt",
          "infra/terraform/bootstrap/tfplan.sha256",
          "infra/terraform/bootstrap/pipeline.auto.tfvars.json",
        ]
      }
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
      group_name  = aws_cloudwatch_log_group.pipeline_codebuild[local.terraform_apply_project_name].name
      stream_name = "apply"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            "set -eu",
            "test -n \"$CODEBUILD_SRC_DIR_PlanOutput\"",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/bootstrap/.terraform.lock.hcl infra/terraform/bootstrap/.terraform.lock.hcl",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/bootstrap/tfplan infra/terraform/bootstrap/tfplan",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/bootstrap/tfplan.sha256 infra/terraform/bootstrap/tfplan.sha256",
            "cp \"$CODEBUILD_SRC_DIR_PlanOutput\"/infra/terraform/bootstrap/pipeline.auto.tfvars.json infra/terraform/bootstrap/pipeline.auto.tfvars.json",
            "sha256sum -c infra/terraform/bootstrap/tfplan.sha256",
            local.bootstrap_backend_init_command,
            "terraform -chdir=infra/terraform/bootstrap apply -auto-approve tfplan",
          ]
        }
      }
    })
  }

  tags = local.common_tags
}

resource "aws_codebuild_project" "bootstrap_smoke" {
  count = local.pipeline_enabled ? 1 : 0

  name          = local.smoke_project_name
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
      group_name  = aws_cloudwatch_log_group.pipeline_codebuild[local.smoke_project_name].name
      stream_name = "smoke"
    }
  }

  source {
    type = "CODEPIPELINE"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          commands = local.terraform_install_commands
        }
        build = {
          commands = [
            local.bootstrap_backend_init_command,
            local.bootstrap_tfvars_command,
            "terraform -chdir=infra/terraform/bootstrap validate",
            "terraform -chdir=infra/terraform/bootstrap plan -detailed-exitcode; rc=$?; if [ \"$rc\" -eq 2 ]; then exit 1; fi; exit \"$rc\"",
          ]
        }
      }
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
    name = "Source"

    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      output_artifacts = ["SourceOutput"]

      configuration = {
        BranchName           = var.source_branch
        ConnectionArn        = aws_codeconnections_connection.source[0].arn
        DetectChanges        = "false"
        FullRepositoryId     = var.github_full_repository_id
        OutputArtifactFormat = "CODE_ZIP"
      }
    }
  }

  stage {
    name = "ValidatePackage"

    action {
      name            = "Validate"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["SourceOutput"]

      configuration = {
        ProjectName = aws_codebuild_project.validate[0].name
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
      input_artifacts  = ["SourceOutput"]
      output_artifacts = ["PlanOutput"]

      configuration = {
        ProjectName = aws_codebuild_project.terraform_plan[0].name
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
        CustomData = "Approve only after reviewing PlanOutput/infra/terraform/bootstrap/tfplan.txt and PlanOutput/infra/terraform/bootstrap/tfplan.sha256 for ${var.account_alias}/${var.deployment_environment}/${var.state_scope}."
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
      input_artifacts = ["SourceOutput", "PlanOutput"]

      configuration = {
        PrimarySource = "SourceOutput"
        ProjectName   = aws_codebuild_project.terraform_apply[0].name
      }
    }
  }

  stage {
    name = "PostApplySmoke"

    action {
      name            = "NoChangePlan"
      category        = "Build"
      owner           = "AWS"
      provider        = "CodeBuild"
      version         = "1"
      input_artifacts = ["SourceOutput"]

      configuration = {
        ProjectName = aws_codebuild_project.bootstrap_smoke[0].name
      }
    }
  }

  tags = local.common_tags
}

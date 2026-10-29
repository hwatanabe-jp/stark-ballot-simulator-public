locals {
  deployment_record_kms = {
    bootstrap  = aws_kms_alias.terraform_authority[0].target_key_arn
    foundation = aws_kms_alias.terraform_authority[0].target_key_arn
    app        = aws_kms_alias.app_pipeline_artifacts[0].target_key_arn
  }
  deployment_record_roots = {
    bootstrap = {
      bucket = local.terraform_authority_bucket_arn

      plan    = local.saved_plan_approval_administrator_access_role_arn
      apply   = local.saved_plan_approval_administrator_access_role_arn
      smoke   = local.saved_plan_approval_administrator_access_role_arn
      actions = { "Local/Apply" = local.saved_plan_approval_administrator_access_role_arn }
    }
    foundation = {
      bucket = local.terraform_authority_bucket_arn

      plan  = "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_plan_role_name}"
      apply = "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_apply_role_name}"
      smoke = local.foundation_terraform_smoke_role_arn
      actions = {
        "DeployFoundation/ApplyReviewedFoundationPlan"        = "arn:aws:iam::${var.aws_account_id}:role/${local.foundation_terraform_apply_role_name}"
        "DeployFoundation/FoundationStateAbsenceOfAppRuntime" = local.foundation_terraform_smoke_role_arn
      }
    }
    app = {
      bucket = local.app_retained_artifact_bucket_arn

      plan  = "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_plan_role_name}"
      apply = "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_apply_role_name}"
      smoke = local.app_terraform_smoke_role_arn
      actions = {
        "DeployApplication/ApplyReviewedAppPlan" = "arn:aws:iam::${var.aws_account_id}:role/${local.app_terraform_apply_role_name}"
        "DeployApplication/DeployStaticFrontend" = "arn:aws:iam::${var.aws_account_id}:role/${local.app_static_deploy_role_name}"
        "DeployApplication/TargetRuntimeSmoke"   = local.app_terraform_smoke_role_arn
        "DeployApplication/PublishCurrentStatus" = local.foundation_app_status_publisher_role_arn
      }
    }
  }
  deployment_record_prefixes = {
    for root, config in local.deployment_record_roots : root => "${config.bucket}/deployment/${local.deployment_target.targetKey}/${root}"
  }
  deployment_record_writers = {
    for entry in flatten([
      for root, config in local.deployment_record_roots : concat([
        { root = root, suffix = "plan-packages/*", writer = config.plan },
        { root = root, suffix = "checkpoint.json", writer = config.smoke },
        { root = root, suffix = "mutation-owner.json", writer = config.apply },
        ], [for action, writer in config.actions : { root = root, suffix = "actions/*/${action}.json", writer = writer }],
      root == "bootstrap" ? [{ root = root, suffix = "approvals/*", writer = config.plan }] : [])
    ]) : "${entry.root}/${entry.suffix}" => entry
  }
}

# Closed semantic prefixes. Old records remain immutable audit history; no new
# publication or consumer admission uses their previous body/pointer contracts.
data "aws_iam_policy_document" "deployment_record_storage" {
  for_each = local.terraform_baseline_authority_enabled ? {
    terraform = ["bootstrap", "foundation"]
    app       = ["app"]
  } : {}

  statement {
    sid    = "DenyDeploymentRecordDeletion"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = [for root in each.value : "${local.deployment_record_prefixes[root]}/*"]
  }
  statement {
    sid    = "DenyUnconditionalDeploymentRecordWrites"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = [for root in each.value : "${local.deployment_record_prefixes[root]}/*"]
    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["true"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }
  statement {
    sid    = "DenyAmbiguousDeploymentRecordWrites"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = [for root in each.value : "${local.deployment_record_prefixes[root]}/*"]
    condition {
      test     = "Null"
      variable = "s3:if-match"
      values   = ["false"]
    }
    condition {
      test     = "Null"
      variable = "s3:if-none-match"
      values   = ["false"]
    }
  }
  statement {
    sid    = "DenyImmutableDeploymentRecordOverwrite"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = flatten([for root in each.value : [for prefix in ["plan-packages", "actions", "approvals"] : "${local.deployment_record_prefixes[root]}/${prefix}/*"]])
    condition {
      test     = "StringNotEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }
  statement {
    sid    = "DenyNonKmsDeploymentRecordWrites"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:PutObject"]
    resources = [for root in each.value : "${local.deployment_record_prefixes[root]}/*"]
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
  dynamic "statement" {
    for_each = { for key, rule in local.deployment_record_writers : key => rule if contains(each.value, rule.root) }
    content {
      sid    = "DenyRecordWriter${replace(statement.key, "/[^A-Za-z0-9]/", "")}"
      effect = "Deny"
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      actions   = ["s3:PutObject"]
      resources = ["${local.deployment_record_prefixes[statement.value.root]}/${statement.value.suffix}"]
      condition {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = [statement.value.writer]
      }
    }
  }
  dynamic "statement" {
    for_each = toset(each.value)
    content {
      sid    = "DenyWrong${title(statement.value)}RecordKmsKey"
      effect = "Deny"
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      actions   = ["s3:PutObject"]
      resources = ["${local.deployment_record_prefixes[statement.value]}/*"]
      condition {
        test     = "StringNotEquals"
        variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
        values   = [local.deployment_record_kms[statement.value]]
      }
    }
  }
}

# IAM action grants remain separate from bucket-side publication restrictions.
locals {
  deployment_record_role_access = {
    for role, execution in local.managed_codebuild_executions : role => {
      root = startswith(role, "app_") ? "app" : "foundation"
      role = role
    } if(startswith(role, "app_") || startswith(role, "foundation_terraform_")) && role != "app_deployment_status_publisher"
  }
}
data "aws_iam_policy_document" "deployment_record_access" {
  for_each = local.pipeline_enabled ? local.deployment_record_role_access : {}
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${local.deployment_record_prefixes[each.value.root]}/*"]
  }
  statement {
    actions   = ["s3:ListBucketVersions"]
    resources = [local.deployment_record_roots[each.value.root].bucket]
    condition {
      test     = "StringEquals"
      variable = "s3:prefix"
      values   = ["deployment/${local.deployment_target.targetKey}/${each.value.root}/checkpoint.json", "deployment/${local.deployment_target.targetKey}/${each.value.root}/mutation-owner.json"]
    }
    condition {
      test     = "NumericEquals"
      variable = "s3:max-keys"
      values   = ["1"]
    }
  }
  dynamic "statement" {
    for_each = [for rule in values(local.deployment_record_writers) : rule if rule.root == each.value.root && rule.writer == "arn:aws:iam::${var.aws_account_id}:role/${local.managed_record_role_names[each.key]}"]
    content {
      actions   = ["s3:PutObject"]
      resources = ["${local.deployment_record_prefixes[each.value.root]}/${statement.value.suffix}"]
    }
  }
  statement {
    actions   = ["kms:DescribeKey", "kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [local.deployment_record_kms[each.value.root]]
  }
}
locals {
  managed_record_role_names = {
    app_terraform_plan              = local.app_terraform_plan_role_name
    app_terraform_apply             = local.app_terraform_apply_role_name
    app_terraform_smoke             = local.app_terraform_smoke_role_name
    app_static_deploy               = local.app_static_deploy_role_name
    app_deployment_status_publisher = local.foundation_app_status_publisher_role_name
    foundation_terraform_plan       = local.foundation_terraform_plan_role_name
    foundation_terraform_apply      = local.foundation_terraform_apply_role_name
    foundation_terraform_smoke      = local.foundation_terraform_smoke_role_name
  }
}
resource "aws_iam_policy" "deployment_record_access" {
  for_each = local.pipeline_enabled ? local.deployment_record_role_access : {}
  name     = "${local.managed_record_role_names[each.key]}-records"
  policy   = data.aws_iam_policy_document.deployment_record_access[each.key].json
  tags     = local.common_tags
}
resource "aws_iam_role_policy_attachment" "deployment_record_access" {
  for_each   = local.pipeline_enabled ? local.deployment_record_role_access : {}
  role       = local.managed_record_role_names[each.key]
  policy_arn = aws_iam_policy.deployment_record_access[each.key].arn
}

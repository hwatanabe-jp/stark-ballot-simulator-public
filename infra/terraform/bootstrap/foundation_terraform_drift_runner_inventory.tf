locals {
  terraform_drift_enabled = local.terraform_baseline_authority_enabled
  terraform_drift_runner_roles = local.terraform_drift_enabled ? {
    for configuration in local.terraform_baseline_root_configuration :
    configuration.root => merge(configuration, {
      roleName = local.terraform_drift_runner_role_names[configuration.root]
    })
  } : {}
  terraform_drift_bootstrap_provider_policy_names = {
    codebuild = "${local.terraform_drift_runner_role_names.bootstrap}-provider-codebuild-read"
    logs      = "${local.terraform_drift_runner_role_names.bootstrap}-provider-logs-read"
    roles     = "${local.terraform_drift_runner_role_names.bootstrap}-provider-roles-read"
    policies  = "${local.terraform_drift_runner_role_names.bootstrap}-provider-policies-read"
    shared    = "${local.terraform_drift_runner_role_names.bootstrap}-provider-shared-read"
  }
  terraform_drift_bootstrap_provider_policy_arns = {
    for kind, name in local.terraform_drift_bootstrap_provider_policy_names :
    kind => "arn:aws:iam::${var.aws_account_id}:policy/${name}"
  }
  terraform_drift_bootstrap_provider_policy_configuration = local.terraform_drift_enabled ? {
    codebuild = {
      name = local.terraform_drift_bootstrap_provider_policy_names.codebuild
      statements = [{
        sid = "ReadExactBootstrapCodeBuildProjects"
        actions = [
          "codebuild:BatchGetProjects",
          "codebuild:ListTagsForResource",
        ]
        resources = distinct(concat(
          local.foundation_bootstrap_managed_codebuild_project_arns,
          local.app_codebuild_project_arns,
        ))
      }]
    }
    logs = {
      name = local.terraform_drift_bootstrap_provider_policy_names.logs
      statements = [{
        sid     = "ReadExactBootstrapCodeBuildLogGroups"
        actions = ["logs:ListTagsForResource"]
        resources = distinct(concat(
          local.codebuild_log_group_arns,
          local.foundation_bootstrap_managed_codebuild_log_group_arns,
          local.app_codebuild_log_group_arns,
          local.terraform_drift_codebuild_log_group_arns,
        ))
      }]
    }
    roles = {
      name = local.terraform_drift_bootstrap_provider_policy_names.roles
      statements = [{
        sid = "ReadExactBootstrapIamRolesAndOidc"
        actions = [
          "iam:GetOpenIDConnectProvider",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListOpenIDConnectProviderTags",
          "iam:ListRolePolicies",
          "iam:ListRoleTags",
        ]
        resources = distinct(concat(
          local.foundation_bootstrap_managed_role_name_arns,
          local.app_pipeline_role_name_arns,
          local.terraform_drift_execution_role_arns,
          [local.oidc_provider_arn, aws_iam_role.app_status_delivery[0].arn, aws_iam_role.app_status_event[0].arn],
        ))
      }]
    }
    policies = {
      name = local.terraform_drift_bootstrap_provider_policy_names.policies
      statements = [{
        sid = "ReadExactBootstrapIamPolicies"
        actions = [
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
          "iam:ListPolicyTags",
          "iam:ListPolicyVersions",
        ]
        resources = distinct(concat(
          local.foundation_deploy_permissions_boundary_policy_arns,
          [local.foundation_terraform_apply_workload_policy_arn],
          local.foundation_image_retirement_enabled ? [local.foundation_retired_image_boundary_arn] : [],
          values(local.terraform_drift_bootstrap_provider_policy_arns),
          [for config in values(local.managed_codebuild_executions) : "arn:aws:iam::${var.aws_account_id}:policy/${config.project}-execution-read"],
          [for role in keys(local.deployment_record_role_access) : "arn:aws:iam::${var.aws_account_id}:policy/${local.managed_record_role_names[role]}-records"],
          local.app_deploy_permissions_boundary_policy_arns,
          local.app_deployment_managed_policy_arns,
          local.terraform_drift_managed_policy_arns,
          [for configuration in values(local.terraform_drift_runner_app_provider_policy_configuration) :
            "arn:aws:iam::${var.aws_account_id}:policy/${configuration.name}"
          ],
          values(local.terraform_drift_runner_boundary_policy_arns),
        ))
      }]
    }
    shared = {
      name = local.terraform_drift_bootstrap_provider_policy_names.shared
      statements = [
        {
          sid = "ReadExactBootstrapSharedProviderResources"
          actions = [
            "codeconnections:GetConnection",
            "codestar-connections:GetConnection",
            "codeconnections:ListTagsForResource",
            "codestar-connections:ListTagsForResource",
            "codepipeline:GetPipeline",
            "codepipeline:ListTagsForResource",
            "kms:DescribeKey",
            "kms:GetKeyPolicy",
            "kms:GetKeyRotationStatus",
            "kms:ListResourceTags",
            "s3:GetAccelerateConfiguration",
            "s3:GetBucketAcl",
            "s3:GetBucketCORS",
            "s3:GetBucketLocation",
            "s3:GetBucketLogging",
            "s3:GetBucketObjectLockConfiguration",
            "s3:GetBucketPolicy",
            "s3:GetBucketPublicAccessBlock",
            "s3:GetBucketRequestPayment",
            "s3:GetBucketTagging",
            "s3:GetBucketVersioning",
            "s3:GetBucketWebsite",
            "s3:GetEncryptionConfiguration",
            "s3:GetLifecycleConfiguration",
            "s3:GetReplicationConfiguration",
            "s3:ListBucket",
            "s3:ListTagsForResource",
          ]
          resources = compact([
            aws_codeconnections_connection.source[0].arn,
            local.foundation_pipeline_arn,
            local.prover_release_pipeline_arn,
            local.toolchain_release_pipeline_arn,
            local.app_pipeline_arn,
            aws_kms_key.state.arn,
            aws_kms_key.pipeline_artifacts[0].arn,
            aws_kms_key.foundation_pipeline_artifacts[0].arn,
            aws_kms_alias.app_pipeline_artifacts[0].target_key_arn,
            aws_kms_alias.terraform_authority[0].target_key_arn,
            aws_s3_bucket.state.arn,
            aws_s3_bucket.pipeline_artifacts[0].arn,
            aws_s3_bucket.foundation_pipeline_artifacts[0].arn,
            aws_s3_bucket.app_pipeline_artifacts[0].arn,
            aws_s3_bucket.app_pipeline_execution_artifacts[0].arn,
            local.foundation_release_manifest_bucket_arn,
            local.terraform_authority_bucket_arn,
          ])
        },
        {
          sid = "ReadExactAppStatusScheduler"
          actions = [
            "states:DescribeStateMachine", "states:ListTagsForResource", "states:ListStateMachineVersions",
            "events:DescribeRule", "events:ListTagsForResource", "events:ListTargetsByRule",
            "sqs:GetQueueAttributes", "sqs:ListQueueTags",
            "cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource",
          ]
          resources = [
            local.app_status_delivery_arn,
            local.app_status_delivery_rule_arn,
            aws_sqs_queue.app_status_delivery_failures[0].arn,
            aws_cloudwatch_metric_alarm.app_status_delivery_failed[0].arn,
            aws_cloudwatch_metric_alarm.app_status_delivery_undelivered[0].arn,
          ]
        },
        {
          sid       = "ReadExactCIValidationSecretMetadata"
          actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"]
          resources = [aws_secretsmanager_secret.app_ci_validation_github[0].arn]
        },
        {
          sid = "ReadBootstrapGlobalProviderInventory"
          actions = [
            "states:ValidateStateMachineDefinition",
            "kms:ListAliases",
            "logs:DescribeLogGroups",
          ]
          resources = ["*"]
        },
      ]
    }
  } : {}
  terraform_drift_runner_app_provider_policy_configuration = local.terraform_drift_enabled ? {
    batch = { name = "${local.app_runtime_name_prefix}-drift-batch-read" }
    core = {
      name = local.deployment_shared_names.terraformDriftAppProviderCorePolicy
    }
    runtime = {
      name = local.deployment_shared_names.terraformDriftAppProviderRuntimePolicy
    }
  } : {}
  terraform_drift_foundation_provider_global_read_actions = [
    "ec2:DescribeAvailabilityZones",
    "ec2:DescribeInternetGateways",
    "ec2:DescribeRouteTables",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeSubnets",
    "ec2:DescribeVpcAttribute",
    "ec2:DescribeVpcs",
    "logs:DescribeLogGroups",
    "ssm:DescribeParameters",
  ]
  terraform_drift_foundation_provider_scoped_read_actions = concat(local.foundation_gateway_logging_read_actions, [
    "apigateway:GET",
    "ecr:DescribeRepositories",
    "ecr:ListTagsForResource",
    "s3:GetAccelerateConfiguration",
    "s3:GetBucketAcl",
    "s3:GetBucketCORS",
    "s3:GetBucketLocation",
    "s3:GetBucketLogging",
    "s3:GetBucketObjectLockConfiguration",
    "s3:GetBucketPolicy",
    "s3:GetBucketPublicAccessBlock",
    "s3:GetBucketRequestPayment",
    "s3:GetBucketTagging",
    "s3:GetBucketVersioning",
    "s3:GetBucketWebsite",
    "s3:GetEncryptionConfiguration",
    "s3:GetLifecycleConfiguration",
    "s3:GetReplicationConfiguration",
    "s3:ListBucket",
    "signer:GetSigningProfile",
    "signer:ListTagsForResource",
  ])
  terraform_drift_foundation_provider_resource_arns = concat(
    [local.foundation_gateway_account_arn, local.foundation_gateway_logging_role_arn, local.foundation_gateway_logging_boundary_arn],
    local.foundation_ecr_repository_arns,
    local.foundation_ecr_signing_profile_arns,
    [local.foundation_release_manifest_bucket_arn],
  )
  terraform_drift_runner_state_object_arns = {
    for root, configuration in local.terraform_drift_runner_roles :
    root => "${aws_s3_bucket.state.arn}/${configuration.backendKey}"
  }
  terraform_drift_runner_authority_object_arns = {
    for root in ["bootstrap", "foundation", "app"] : root => concat(
      [for key in ["checkpoint.json", "mutation-owner.json", "plan-packages/*"] : "${local.deployment_record_prefixes[root]}/${key}"],
      root == "app" ? [local.app_retained_lambda_artifact_objects_arn, local.app_retained_static_frontend_artifact_objects_arn] : [],
    )
  }
  terraform_drift_runner_secret_read_arns = {
    bootstrap  = []
    foundation = local.foundation_runtime_secret_arns
    app = [
      local.app_expected_origin_verify_header_secret_arn,
      local.app_log_ip_hash_salt_secret_arn,
    ]
  }
  terraform_drift_runner_parameter_read_arns = {
    bootstrap  = []
    foundation = local.foundation_runtime_ssm_parameter_arns
    app = [
      local.app_runtime_ssm_parameter_arn,
      local.app_invariant_email_parameter_path_arn,
      local.app_invariant_email_parameter_children_arn,
      local.app_actionable_email_parameter_path_arn,
      local.app_actionable_email_parameter_children_arn,
    ]
  }
  terraform_drift_runner_kms_read_arns = {
    bootstrap = [
      aws_kms_key.state.arn,
      aws_kms_key.pipeline_artifacts[0].arn,
      aws_kms_key.foundation_pipeline_artifacts[0].arn,
      aws_kms_alias.app_pipeline_artifacts[0].target_key_arn,
      aws_kms_alias.terraform_authority[0].target_key_arn,
    ]
    foundation = [
      aws_kms_key.state.arn,
      aws_kms_alias.app_pipeline_artifacts[0].target_key_arn,
      aws_kms_alias.terraform_authority[0].target_key_arn,
    ]
    app = [aws_kms_key.state.arn, aws_kms_alias.terraform_authority[0].target_key_arn, aws_kms_alias.app_pipeline_artifacts[0].target_key_arn, local.app_data_kms_key_arn_pattern]
  }
  terraform_drift_runner_kms_decrypt_services = {
    bootstrap = ["s3.${var.aws_region}.amazonaws.com"]
    foundation = [
      "lambda.${var.aws_region}.amazonaws.com",
      "s3.${var.aws_region}.amazonaws.com",
    ]
    app = [
      "dynamodb.${var.aws_region}.amazonaws.com",
      "lambda.${var.aws_region}.amazonaws.com",
      "s3.${var.aws_region}.amazonaws.com",
      "secretsmanager.${var.aws_region}.amazonaws.com",
      "ssm.${var.aws_region}.amazonaws.com",
    ]
  }
  terraform_drift_runner_identity_policy_documents = local.terraform_drift_enabled ? {
    bootstrap = concat(
      [data.aws_iam_policy_document.terraform_drift_runner["bootstrap"].json],
      [
        for document in values(data.aws_iam_policy_document.terraform_drift_runner_bootstrap_provider) :
        document.json
      ],
    )
    foundation = [
      data.aws_iam_policy_document.terraform_drift_runner["foundation"].json,
      data.aws_iam_policy_document.terraform_drift_runner_foundation_provider[0].json,
      data.aws_iam_policy_document.terraform_drift_runner_foundation_exact[0].json,
    ]
    app = [
      data.aws_iam_policy_document.terraform_drift_runner["app"].json,
      data.aws_iam_policy_document.terraform_drift_runner_app_provider_core[0].json,
      data.aws_iam_policy_document.terraform_drift_runner_app_provider_runtime[0].json,
      data.aws_iam_policy_document.app_batch_read.json,
      data.aws_iam_policy_document.terraform_drift_runner_app_sensitive[0].json,
    ]
  } : {}
}

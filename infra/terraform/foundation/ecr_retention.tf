locals {
  ecr_retention_function_name       = local.deployment_shared_names.ecrRetentionFunction
  ecr_retention_log_group_name      = local.deployment_shared_names.ecrRetentionLogGroup
  ecr_retention_role_name           = local.deployment_shared_names.ecrRetentionRole
  ecr_retention_schedule_name       = local.deployment_shared_names.ecrRetentionSchedule
  ecr_retention_schedule_state      = "ENABLED"
  ecr_retention_boundary_policy_arn = "arn:aws:iam::${var.aws_account_id}:policy/${local.deployment_shared_names.ecrRetentionPermissionsBoundary}"
  ecr_retention_package             = jsondecode(file("${path.module}/ecr-retention-package.json")).artifact
  ecr_retention_package_path        = "${path.module}/../../../.tmp/foundation-lambdas/ecr_retention.zip"
  ecr_retention_app_authority_bucket_arn = (
    "arn:aws:s3:::${local.deployment_shared_names.appRetainedArtifactBucket}"
  )
  ecr_retention_app_authority_object_arns = [
    "${local.ecr_retention_app_authority_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPointerKey}",
    "${local.ecr_retention_app_authority_bucket_arn}/${local.deployment_shared_names.acceptedDeploymentPrefix}/acceptances/*",
  ]
  ecr_retention_release_authority_bucket_arn = "arn:aws:s3:::${local.manifest_bucket_name}"
  ecr_retention_release_authority_object_arns = [
    "${local.ecr_retention_release_authority_bucket_arn}/${local.deployment_shared_names.toolchainAcceptedPointerKey}",
    "${local.ecr_retention_release_authority_bucket_arn}/${local.deployment_shared_names.proverAcceptedPointerKey}",
    "${local.ecr_retention_release_authority_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/candidates/*",
    "${local.ecr_retention_release_authority_bucket_arn}/${local.deployment_shared_names.toolchainArtifactPrefix}/releases/*",
    "${local.ecr_retention_release_authority_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/candidates/*",
    "${local.ecr_retention_release_authority_bucket_arn}/${local.deployment_shared_names.proverReleasePrefix}/releases/*",
  ]
  ecr_retention_pipeline_arns = [
    for pipeline_name in [
      local.deployment_target.lanes.app.names.pipeline,
      local.deployment_target.lanes.foundation.names.pipeline,
      local.deployment_target.lanes.prover.names.pipeline,
      local.deployment_target.lanes.toolchain.names.pipeline,
    ] : "arn:aws:codepipeline:${var.aws_region}:${var.aws_account_id}:${pipeline_name}"
  ]
  ecr_retention_candidate_project_arns = [
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.deployment_shared_names.toolchainCandidateProject}",
    "arn:aws:codebuild:${var.aws_region}:${var.aws_account_id}:project/${local.deployment_shared_names.proverCandidateProject}",
  ]
  ecr_retention_state_machine_arn = (
    "arn:aws:states:${var.aws_region}:${var.aws_account_id}:stateMachine:${local.deployment_shared_names.finalizationStateMachine}"
  )
  ecr_retention_ecs_cluster_arn = (
    "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:cluster/${local.deployment_shared_names.proverEcsCluster}"
  )
  ecr_retention_environment = {
    APP_ACCEPTED_AUTHORITY_BUCKET       = local.deployment_shared_names.appRetainedArtifactBucket
    APP_ACCEPTED_AUTHORITY_KEY          = local.deployment_shared_names.acceptedDeploymentPointerKey
    APP_PIPELINE_NAME                   = local.deployment_target.lanes.app.names.pipeline
    AWS_NODEJS_CONNECTION_REUSE_ENABLED = "1"
    EXPECTED_ACCOUNT_ID                 = var.aws_account_id
    EXPECTED_REGION                     = var.aws_region
    EXPECTED_SCHEDULE_ARN               = aws_cloudwatch_event_rule.ecr_retention.arn
    FOUNDATION_PIPELINE_NAME            = local.deployment_target.lanes.foundation.names.pipeline
    NODE_ENV                            = "production"
    PROVER_ACCEPTED_POINTER_KEY         = local.deployment_shared_names.proverAcceptedPointerKey
    PROVER_CANDIDATE_PROJECT_NAME       = local.deployment_shared_names.proverCandidateProject
    PROVER_ECS_CLUSTER_NAME             = local.deployment_shared_names.proverEcsCluster
    PROVER_ECS_TASK_FAMILY              = local.deployment_shared_names.proverEcsTaskFamily
    PROVER_PIPELINE_NAME                = local.deployment_target.lanes.prover.names.pipeline
    PROVER_REPOSITORY_NAME              = local.prover_repository_name
    PROVER_STATE_MACHINE_ARN            = local.ecr_retention_state_machine_arn
    RELEASE_AUTHORITY_BUCKET            = local.manifest_bucket_name
    RETAINED_SUBJECT_COUNT              = "10"
    TARGET_KEY                          = local.deployment_target.targetKey
    TOOLCHAIN_ACCEPTED_POINTER_KEY      = local.deployment_shared_names.toolchainAcceptedPointerKey
    TOOLCHAIN_CANDIDATE_PROJECT_NAME    = local.deployment_shared_names.toolchainCandidateProject
    TOOLCHAIN_PIPELINE_NAME             = local.deployment_target.lanes.toolchain.names.pipeline
    TOOLCHAIN_REPOSITORY_NAME           = local.toolchain_repository_name
  }
}

data "aws_iam_policy" "ecr_retention_boundary" {
  arn = local.ecr_retention_boundary_policy_arn
}

data "aws_kms_key" "ecr_retention_app_authority" {
  key_id = local.deployment_target.lanes.app.names.artifactKmsAlias
}

data "aws_iam_policy_document" "ecr_retention_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ecr_retention" {
  statement {
    sid    = "WriteEcrRetentionLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.ecr_retention.arn}:log-stream:*"]
  }

  statement {
    sid       = "VerifyEcrRetentionCaller"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  statement {
    sid    = "InspectAndDeleteExactEcrSubjects"
    effect = "Allow"
    actions = [
      "ecr:BatchDeleteImage",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [
      aws_ecr_repository.toolchain.arn,
      aws_ecr_repository.prover.arn,
    ]
  }

  statement {
    sid    = "ReadExactAppImageAuthority"
    effect = "Allow"
    actions = [
      "s3:GetObject",
    ]
    resources = local.ecr_retention_app_authority_object_arns
  }

  statement {
    sid    = "DecryptExactAppImageAuthority"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    resources = [data.aws_kms_key.ecr_retention_app_authority.arn]

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
  }

  statement {
    sid    = "ReadExactReleaseImageAuthority"
    effect = "Allow"
    actions = [
      "s3:GetObject",
    ]
    resources = local.ecr_retention_release_authority_object_arns
  }

  statement {
    sid       = "ReadImageReleasePipelineActivity"
    effect    = "Allow"
    actions   = ["codepipeline:ListPipelineExecutions"]
    resources = local.ecr_retention_pipeline_arns
  }

  statement {
    sid    = "ReadImageCandidateBuildActivity"
    effect = "Allow"
    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:ListBuildsForProject",
    ]
    resources = local.ecr_retention_candidate_project_arns
  }

  statement {
    sid    = "ReadFinalizationActivity"
    effect = "Allow"
    actions = [
      "states:DescribeStateMachine",
      "states:ListExecutions",
    ]
    resources = [local.ecr_retention_state_machine_arn]
  }

  statement {
    sid       = "ReadProverTaskDefinitionActivity"
    effect    = "Allow"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "ListExactProverClusterTasks"
    effect    = "Allow"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.ecr_retention_ecs_cluster_arn]
    }
  }
}

resource "aws_cloudwatch_log_group" "ecr_retention" {
  name              = local.ecr_retention_log_group_name
  retention_in_days = 365
  tags              = local.common_tags
}

resource "aws_iam_role" "ecr_retention" {
  name                 = local.ecr_retention_role_name
  assume_role_policy   = data.aws_iam_policy_document.ecr_retention_assume_role.json
  permissions_boundary = data.aws_iam_policy.ecr_retention_boundary.arn
  tags                 = local.common_tags
}

resource "aws_iam_role_policy" "ecr_retention" {
  name   = "${local.ecr_retention_role_name}-runtime"
  role   = aws_iam_role.ecr_retention.id
  policy = data.aws_iam_policy_document.ecr_retention.json
}

resource "aws_lambda_function" "ecr_retention" {
  function_name                  = local.ecr_retention_function_name
  role                           = aws_iam_role.ecr_retention.arn
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = local.ecr_retention_package_path
  source_code_hash               = local.ecr_retention_package.sourceCodeHash
  timeout                        = 300
  memory_size                    = 256
  reserved_concurrent_executions = 1

  logging_config {
    log_format            = "JSON"
    application_log_level = "INFO"
    system_log_level      = "INFO"
  }

  environment {
    variables = local.ecr_retention_environment
  }

  lifecycle {
    precondition {
      condition     = local.deployment_target_inputs_exact
      error_message = "ECR retention may run only for the exact reviewed Foundation target."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.ecr_retention,
    aws_iam_role_policy.ecr_retention,
  ]

  tags = local.common_tags
}

resource "aws_cloudwatch_event_rule" "ecr_retention" {
  name                = local.ecr_retention_schedule_name
  description         = "Apply reference-aware subject retention to Foundation ECR repositories."
  schedule_expression = "cron(0 18 * * ? *)"
  state               = local.ecr_retention_schedule_state
  tags                = local.common_tags
}

resource "aws_cloudwatch_event_target" "ecr_retention" {
  rule      = aws_cloudwatch_event_rule.ecr_retention.name
  target_id = "foundation-ecr-retention"
  arn       = aws_lambda_function.ecr_retention.arn

  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 2
  }
}

resource "aws_lambda_permission" "ecr_retention" {
  statement_id   = "AllowScheduledEcrRetention"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.ecr_retention.function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.ecr_retention.arn
  source_account = var.aws_account_id
}

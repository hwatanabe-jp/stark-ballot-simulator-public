# AWS provider 6.70.0 does not expose Batch consumable resources or job-definition
# consumable requirements. Keep the two exact CloudFormation resource types in
# this source-reviewed Terraform stack; no custom resource or remote script.
resource "aws_cloudformation_stack" "prover_job" {
  name = "${local.name_prefix}-prover-job"
  template_body = jsonencode({
    Resources = {
      ProverSlots = {
        Type = "AWS::Batch::ConsumableResource"
        Properties = {
          ConsumableResourceName = "${local.name_prefix}-prover-slots"
          ResourceType           = "REPLENISHABLE"
          TotalQuantity          = var.prover_max_concurrent_provers
          Tags                   = merge(local.common_tags, { Name = "${local.name_prefix}-prover-slots" })
        }
      }
      ProverJob = {
        Type = "AWS::Batch::JobDefinition"
        Properties = {
          JobDefinitionName    = "${local.name_prefix}-prover"
          Type                 = "container"
          PlatformCapabilities = ["FARGATE"]
          PropagateTags        = true
          RetryStrategy        = { Attempts = 1 }
          Timeout              = { AttemptDurationSeconds = var.prover_task_timeout_seconds }
          ConsumableResourceProperties = {
            ConsumableResourceList = [{
              ConsumableResource = { Ref = "ProverSlots" }
              Quantity           = 1
            }]
          }
          EcsProperties = {
            TaskProperties = [{
              ExecutionRoleArn = aws_iam_role.prover_task_execution.arn
              TaskRoleArn      = aws_iam_role.prover_task.arn
              RuntimePlatform = {
                OperatingSystemFamily = "LINUX"
                CpuArchitecture       = "ARM64"
              }
              NetworkConfiguration = { AssignPublicIp = "ENABLED" }
              Volumes              = [{ Name = "prover-tmp" }, { Name = "prover-output" }]
              Containers = [
                {
                  Name                   = "prover"
                  Image                  = var.prover_image_uri
                  Essential              = true
                  User                   = "10001:10001"
                  ReadonlyRootFilesystem = true
                  StopTimeout            = 120
                  LinuxParameters = {
                    InitProcessEnabled = true
                  }
                  MountPoints = [
                    {
                      SourceVolume  = "prover-tmp"
                      ContainerPath = "/tmp"
                      ReadOnly      = false
                    },
                    {
                      SourceVolume  = "prover-output"
                      ContainerPath = "/var/task/output"
                      ReadOnly      = false
                    },
                  ]
                  ResourceRequirements = [
                    { Type = "VCPU", Value = tostring(var.prover_cpu / 1024) },
                    { Type = "MEMORY", Value = tostring(var.prover_memory) },
                  ]
                  Environment = [
                    { Name = "AWS_REGION", Value = var.aws_region },
                    { Name = "PROVER_START_ADMISSION_FUNCTION", Value = local.target_application_lambda_names.finalization_writer },
                    {
                      Name  = "ENV_NAME"
                      Value = var.deployment_environment
                    },
                    {
                      Name  = "RUNTIME_DEPLOYMENT_ENV"
                      Value = var.deployment_environment
                    },
                    {
                      Name  = "DEPLOYMENT_ID"
                      Value = var.deployment_id
                    },
                    {
                      Name  = "APP_SOURCE_SHA"
                      Value = var.app_source_sha
                    },
                    {
                      Name  = "DEPLOY_MODE"
                      Value = var.deploy_mode
                    },
                    {
                      Name  = "RUNTIME_PROFILE"
                      Value = "target-aws-async"
                    },
                    {
                      Name  = "AWS_ACCOUNT_ID"
                      Value = var.aws_account_id
                    },
                    {
                      Name  = "S3_PROOF_BUCKET"
                      Value = aws_s3_bucket.proof_artifacts.bucket
                    },
                    {
                      Name  = "S3_PROOF_PREFIX"
                      Value = local.proof_artifact_prefix
                    },
                  ]
                  Secrets = [
                    {
                      Name      = "LOG_IP_HASH_SALT"
                      ValueFrom = data.aws_secretsmanager_secret.prover_log_hash_salt.arn
                    },
                  ]
                  LogConfiguration = {
                    LogDriver = "awslogs"
                    Options = {
                      "awslogs-group"         = aws_cloudwatch_log_group.prover.name
                      "awslogs-region"        = var.aws_region
                      "awslogs-stream-prefix" = "prover"
                      "mode"                  = "non-blocking"
                      "max-buffer-size"       = "25m"
                    }
                  }
                }
              ]
            }]
          }
          Tags = merge(local.common_tags, { deployment_id = var.deployment_id })
        }
      }
    }
    Outputs = {
      JobDefinitionArn = { Value = { Ref = "ProverJob" } }
      ProverSlotsArn   = { Value = { Ref = "ProverSlots" } }
    }
  })

  lifecycle {
    precondition {
      condition     = can(regex(local.prover_image_uri_pattern, var.prover_image_uri))
      error_message = "prover_image_uri must reference the expected target account and region."
    }
  }
  tags = local.common_tags
}

resource "aws_batch_compute_environment" "prover" {
  name  = "${local.name_prefix}-prover"
  type  = "MANAGED"
  state = "ENABLED"
  compute_resources {
    type               = "FARGATE"
    max_vcpus          = var.prover_max_concurrent_provers * var.prover_cpu / 1024
    subnets            = var.prover_subnet_ids
    security_group_ids = var.prover_security_group_ids
  }
  tags = local.common_tags
}

resource "aws_batch_job_queue" "prover" {
  name     = "${local.name_prefix}-prover"
  state    = local.application_quiesced ? "DISABLED" : "ENABLED"
  priority = 1
  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.prover.arn
  }
  tags = local.common_tags
}

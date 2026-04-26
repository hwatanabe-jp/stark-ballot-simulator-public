locals {
  ecs_network_configuration = {
    AwsvpcConfiguration = {
      AssignPublicIp = "ENABLED"
      SecurityGroups = [aws_security_group.ecs_tasks.id]
      Subnets        = local.ecs_public_subnet_ids
    }
  }
  ecr_image_repo_uri   = split("@", var.ecs_image_uri)[0]
  ecr_image_repo_parts = split("/", local.ecr_image_repo_uri)
  ecr_image_repository = join("/", slice(local.ecr_image_repo_parts, 1, length(local.ecr_image_repo_parts)))
  ecr_image_digest     = split("@", var.ecs_image_uri)[1]
}

resource "aws_sfn_state_machine" "prover_dispatcher" {
  name     = "${var.project_name}-prover-dispatcher-${var.environment}"
  role_arn = aws_iam_role.step_functions.arn

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn_prover.arn}:*"
    include_execution_data = false
    level                  = "ALL"
  }

  definition = jsonencode({
    Comment = "STARK Ballot Simulator Prover Dispatcher - ECS Fargate"
    StartAt = "VerifyImageSignature"
    States = {
      VerifyImageSignature = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.check_image_signature.arn
          Payload = {
            repositoryName = local.ecr_image_repository
            imageDigest    = local.ecr_image_digest
          }
        }
        ResultPath = "$.signingStatus"
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.proverError"
            Next        = "FinalizeFailed"
          }
        ]
        Next = "CheckImageSignature"
      }
      CheckImageSignature = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.signingStatus.Payload.status"
            StringEquals = "COMPLETE"
            Next         = "RunProver"
          }
        ]
        Default = "FinalizeSignatureFailed"
      }
      RunProver = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::ecs:runTask.sync"
        Parameters = {
          LaunchType           = "FARGATE"
          Cluster              = aws_ecs_cluster.prover.arn
          TaskDefinition       = aws_ecs_task_definition.prover.arn
          NetworkConfiguration = local.ecs_network_configuration
          Overrides = {
            ContainerOverrides = [
              {
                Name = "prover"
                Environment = [
                  {
                    Name  = "ENV_NAME"
                    Value = var.environment
                  },
                  {
                    Name  = "S3_PROOF_BUCKET"
                    Value = local.proof_bundle_bucket_name
                  },
                  {
                    Name  = "S3_PROOF_PREFIX"
                    Value = var.s3_proof_prefix
                  },
                  {
                    Name  = "INPUT_S3_BUCKET"
                    Value = local.proof_bundle_bucket_name
                  },
                  {
                    Name      = "INPUT_S3_KEY"
                    "Value.$" = "$.payload.inputS3Key"
                  },
                  {
                    Name  = "OUTPUT_S3_BUCKET"
                    Value = local.proof_bundle_bucket_name
                  },
                  {
                    Name      = "OUTPUT_S3_PREFIX"
                    "Value.$" = "States.Format('{}{}/{}', '${var.s3_proof_prefix}', $.payload.sessionId, $.payload.executionId)"
                  }
                ]
              }
            ]
          }
        }
        ResultPath = "$.proverResult"
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.proverError"
            Next        = "FinalizeFailed"
          }
        ]
        Next = "FinalizeSucceeded"
      }
      FinalizeSignatureFailed = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::lambda:invoke"
        Parameters = {
          FunctionName = var.finalize_callback_lambda_arn
          Payload = {
            status           = "FAILED"
            "payload.$"      = "$.payload"
            "executionArn.$" = "$$.Execution.Id"
            error = {
              error = "ImageSignatureVerificationFailed"
              cause = "ECR signing status is not COMPLETE"
            }
          }
        }
        End = true
      }
      FinalizeSucceeded = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::lambda:invoke"
        Parameters = {
          FunctionName = var.finalize_callback_lambda_arn
          Payload = {
            status           = "SUCCEEDED"
            "payload.$"      = "$.payload"
            "executionArn.$" = "$$.Execution.Id"
            "proverResult.$" = "$.proverResult"
          }
        }
        End = true
      }
      FinalizeFailed = {
        Type     = "Task"
        Resource = "arn:${local.partition}:states:::lambda:invoke"
        Parameters = {
          FunctionName = var.finalize_callback_lambda_arn
          Payload = {
            status           = "FAILED"
            "payload.$"      = "$.payload"
            "executionArn.$" = "$$.Execution.Id"
            "error.$"        = "$.proverError"
          }
        }
        End = true
      }
    }
  })
}

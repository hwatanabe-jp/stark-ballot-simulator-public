data "aws_iam_policy_document" "target_sfn_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "target_sfn" {
  name               = "${local.name_prefix}-target-sfn"
  assume_role_policy = data.aws_iam_policy_document.target_sfn_assume_role.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "target_sfn" {
  statement {
    sid       = "SubmitTargetProverJob"
    effect    = "Allow"
    actions   = ["batch:SubmitJob"]
    resources = [aws_batch_job_queue.prover.arn, aws_cloudformation_stack.prover_job.outputs["JobDefinitionArn"], aws_cloudformation_stack.prover_job.outputs["ProverSlotsArn"]]
  }

  statement {
    # Tagged SubmitJob authorizes TagResource on its submission resources too.
    sid       = "TagTargetProverSubmission"
    effect    = "Allow"
    actions   = ["batch:TagResource"]
    resources = [aws_batch_job_queue.prover.arn, aws_cloudformation_stack.prover_job.outputs["JobDefinitionArn"], aws_cloudformation_stack.prover_job.outputs["ProverSlotsArn"]]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/prover_queue"
      values   = [aws_batch_job_queue.prover.name]
    }
  }

  statement {
    sid       = "CreateTaggedProverJob"
    effect    = "Allow"
    actions   = ["batch:SubmitJob", "batch:TagResource"]
    resources = ["arn:aws:batch:${var.aws_region}:${var.aws_account_id}:job/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/prover_queue"
      values   = [aws_batch_job_queue.prover.name]
    }
  }

  statement {
    sid       = "ObserveProverJobs"
    effect    = "Allow"
    actions   = ["batch:DescribeJobs"]
    resources = ["*"]
  }

  statement {
    sid       = "TerminateTargetProverJob"
    effect    = "Allow"
    actions   = ["batch:TerminateJob"]
    resources = ["arn:aws:batch:${var.aws_region}:${var.aws_account_id}:job/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/prover_queue"
      values   = [aws_batch_job_queue.prover.name]
    }
  }

  statement {
    sid    = "ManageStepFunctionsEvents"
    effect = "Allow"

    actions = [
      "events:DeleteRule",
      "events:DescribeRule",
      "events:PutRule",
      "events:PutTargets",
      "events:RemoveTargets",
    ]
    resources = ["arn:aws:events:${var.aws_region}:${var.aws_account_id}:rule/StepFunctionsGetEventsForBatchJobsRule"]
  }

  statement {
    sid    = "InvokeTargetCallback"
    effect = "Allow"

    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.target["finalization_writer"].arn,
      "${aws_lambda_function.target["finalization_writer"].arn}:*",
    ]
  }

  statement {
    sid    = "InvokeImageSignatureVerifier"
    effect = "Allow"

    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.image_signature_verifier.qualified_arn]
  }

  statement {
    sid    = "WriteStateMachineLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:DescribeLogGroups",
      "logs:DescribeResourcePolicies",
      "logs:GetLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:UpdateLogDelivery",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "target_sfn" {
  name   = "${local.name_prefix}-target-sfn"
  role   = aws_iam_role.target_sfn.id
  policy = data.aws_iam_policy_document.target_sfn.json
}

resource "aws_sfn_state_machine" "target_finalization" {
  name     = local.target_state_machine_name
  role_arn = aws_iam_role.target_sfn.arn

  definition = jsonencode({
    Comment = "Target async prover state machine"
    StartAt = "VerifyImageSignature"
    States = {
      VerifyImageSignature = {
        Type           = "Task"
        Resource       = "arn:aws:states:::lambda:invoke"
        TimeoutSeconds = var.image_signature_verifier_step_timeout_seconds
        Parameters = {
          FunctionName = aws_lambda_function.image_signature_verifier.qualified_arn
          Payload = {
            imageUri          = var.prover_image_uri
            registryId        = var.aws_account_id
            imageRegion       = var.aws_region
            repositoryName    = local.prover_image_repository
            imageDigest       = local.prover_image_digest
            signingProfileArn = local.image_signature_signing_profile_arn
          }
        }
        ResultSelector = {
          "response.$" = "$.Payload"
        }
        ResultPath = "$.signatureVerification"
        Retry = [
          {
            ErrorEquals = [
              "Lambda.ServiceException",
              "Lambda.AWSLambdaException",
              "Lambda.SdkClientException",
              "Lambda.TooManyRequestsException",
            ]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          },
        ]
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = null
            Next        = "RecordSignatureInvocationFailure"
          },
        ]
        Next = "CheckImageSignature"
      }
      RecordSignatureInvocationFailure = {
        Type = "Pass"
        Result = {
          response = {
            result     = "REJECTED"
            mode       = "cryptographic"
            reasonCode = "LAMBDA_INVOCATION_FAILED"
          }
        }
        ResultPath = "$.signatureVerification"
        Next       = "CheckImageSignature"
      }
      CheckImageSignature = {
        Type = "Choice"
        Choices = [
          {
            And = [
              {
                Variable  = "$.signatureVerification.response.result"
                IsPresent = true
              },
              {
                Variable     = "$.signatureVerification.response.result"
                StringEquals = "VERIFIED"
              },
              {
                Variable  = "$.signatureVerification.response.mode"
                IsPresent = true
              },
              {
                Variable     = "$.signatureVerification.response.mode"
                StringEquals = "cryptographic"
              },
            ]
            Next = "RunProver"
          },
        ]
        Default = "CallbackSignatureFailed"
      }
      RunProver = {
        Type     = "Task"
        Resource = "arn:aws:states:::batch:submitJob.sync"
        # Includes the former 30-minute capacity wait plus task runtime and stop grace.
        TimeoutSeconds = var.prover_task_timeout_seconds + 1800 + 180
        Parameters = {
          JobDefinition = aws_cloudformation_stack.prover_job.outputs["JobDefinitionArn"]
          JobQueue      = aws_batch_job_queue.prover.arn
          "JobName.$"   = "$$.Execution.Name"
          Tags          = { deployment_id = var.deployment_id, prover_queue = aws_batch_job_queue.prover.name }
          EcsPropertiesOverride = {
            TaskProperties = [{
              Containers = [{
                Name = "prover"
                Environment = [
                  { Name = "PROVER_START_PAYLOAD", "Value.$" = "States.JsonToString($)" },
                  { Name = "PROVER_EXECUTION_ARN", "Value.$" = "$$.Execution.Id" },
                  {
                    Name  = "INPUT_S3_BUCKET"
                    Value = aws_s3_bucket.proof_artifacts.bucket
                  },
                  {
                    Name      = "INPUT_S3_KEY"
                    "Value.$" = "$.inputS3Key"
                  },
                  {
                    Name  = "OUTPUT_S3_BUCKET"
                    Value = aws_s3_bucket.proof_artifacts.bucket
                  },
                  {
                    Name      = "OUTPUT_S3_PREFIX"
                    "Value.$" = "$.outputS3Prefix"
                  },
                  {
                    Name      = "FINALIZATION_ID"
                    "Value.$" = "$$.Execution.Name"
                  },
                  {
                    Name  = "EXPECTED_IMAGE_ID"
                    Value = var.expected_image_id
                  },
                ]
              }]
            }]
          }
        }
        ResultPath = "$.proverResult"
        Next       = "CallbackSucceeded"
        # SubmitJob has no ClientToken. Do not resubmit on an ambiguous response
        # or retry a failed proof; Batch also has Attempts = 1.
        Catch = [
          {
            ErrorEquals = ["States.Timeout"]
            ResultPath  = "$.error"
            Next        = "CallbackTimedOut"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.error"
            Next        = "CallbackFailed"
          },
        ]
      }
      CallbackSucceeded = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.target["finalization_writer"].arn
          Payload = {
            status             = "SUCCEEDED"
            "payload.$"        = "$"
            "executionArn.$"   = "$$.Execution.Id"
            "completedAtIso.$" = "$$.State.EnteredTime"
          }
        }
        Retry = local.callback_delivery_retry
        Catch = local.callback_delivery_catch
        End   = true
      }
      CallbackTimedOut = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.target["finalization_writer"].arn
          Payload = {
            status           = "TIMED_OUT"
            "payload.$"      = "$"
            "executionArn.$" = "$$.Execution.Id"
            "timeoutAtIso.$" = "$$.State.EnteredTime"
          }
        }
        Retry = local.callback_delivery_retry
        Catch = local.callback_delivery_catch
        End   = true
      }
      CallbackSignatureFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.target["finalization_writer"].arn
          Payload = {
            status           = "FAILED"
            "payload.$"      = "$"
            "executionArn.$" = "$$.Execution.Id"
            "failedAtIso.$"  = "$$.State.EnteredTime"
            error = {
              code    = "PROVER_IMAGE_SIGNATURE_FAILED"
              message = "Target prover image signature verification failed"
            }
          }
        }
        Retry = local.callback_delivery_retry
        Catch = local.callback_delivery_catch
        End   = true
      }
      CallbackFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.target["finalization_writer"].arn
          Payload = {
            status           = "FAILED"
            "payload.$"      = "$"
            "executionArn.$" = "$$.Execution.Id"
            "failedAtIso.$"  = "$$.State.EnteredTime"
            error = {
              code        = "PROVER_TASK_FAILED"
              message     = "Target prover task failed"
              "details.$" = "$.error"
            }
          }
        }
        Retry = local.callback_delivery_retry
        Catch = local.callback_delivery_catch
        End   = true
      }
      CallbackDeliveryFailed = {
        Type  = "Fail"
        Error = "CallbackDeliveryFailed"
        Cause = "Finalize callback Lambda delivery failed after bounded retries"
      }
    }
  })

  logging_configuration {
    include_execution_data = false
    level                  = "ALL"
    log_destination        = "${aws_cloudwatch_log_group.target_sfn.arn}:*"
  }

  tags = local.common_tags
}

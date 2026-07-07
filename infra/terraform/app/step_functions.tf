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
    sid    = "RunTargetProverTask"
    effect = "Allow"

    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.prover.arn]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.prover.arn]
    }
  }

  statement {
    sid    = "ObserveTargetProverTask"
    effect = "Allow"

    actions = [
      "ecs:DescribeTasks",
      "ecs:StopTask",
    ]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.prover.arn]
    }
  }

  statement {
    sid    = "PassTargetProverRoles"
    effect = "Allow"

    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.prover_task_execution.arn,
      aws_iam_role.prover_task.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
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
    resources = ["*"]
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
    sid    = "InvokeImageSignatureCheck"
    effect = "Allow"

    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.target["image_signature_gate"].arn,
      "${aws_lambda_function.target["image_signature_gate"].arn}:*",
    ]
  }

  statement {
    sid    = "UseProverSemaphore"
    effect = "Allow"

    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.prover_semaphore.arn]
  }

  statement {
    sid    = "UseProverSemaphoreKey"
    effect = "Allow"

    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.app_data.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:CallerAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["dynamodb.${var.aws_region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:dynamodb:tableName"
      values   = [aws_dynamodb_table.prover_semaphore.name]
    }
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
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.target["image_signature_gate"].arn
          Payload = {
            imageUri       = var.prover_image_uri
            registryId     = var.aws_account_id
            imageRegion    = var.aws_region
            repositoryName = local.prover_image_repository
            imageDigest    = local.prover_image_digest
          }
        }
        ResultPath = "$.signingStatus"
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
            ResultPath  = "$.error"
            Next        = "CallbackFailed"
          },
        ]
        Next = "CheckImageSignature"
      }
      CheckImageSignature = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.signingStatus.Payload.status"
            StringEquals = "COMPLETE"
            Next         = "AcquireProverSlot"
          },
        ]
        Default = "CallbackSignatureFailed"
      }
      AcquireProverSlot = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.prover_semaphore.name
          Key = {
            LockName = {
              S = local.prover_semaphore_lock_name
            }
          }
          UpdateExpression    = "SET currentLockCount = currentLockCount + :one, #owner = :acquiredAt"
          ConditionExpression = "currentLockCount < :limit AND attribute_not_exists(#owner)"
          ExpressionAttributeNames = {
            "#owner.$" = "$$.Execution.Name"
          }
          ExpressionAttributeValues = {
            ":one" = {
              N = "1"
            }
            ":limit" = {
              N = tostring(var.prover_max_concurrent_provers)
            }
            ":acquiredAt" = {
              "S.$" = "$$.State.EnteredTime"
            }
          }
        }
        ResultPath = null
        Retry = [
          {
            ErrorEquals     = ["DynamoDB.ConditionalCheckFailedException"]
            IntervalSeconds = 15
            BackoffRate     = 1
            MaxAttempts     = 120
          },
          {
            ErrorEquals = [
              "DynamoDB.ProvisionedThroughputExceededException",
              "DynamoDB.ThrottlingException",
              "DynamoDB.InternalServerError",
            ]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          },
        ]
        Catch = [
          {
            ErrorEquals = ["DynamoDB.ConditionalCheckFailedException"]
            ResultPath  = null
            Next        = "CheckProverSlotHeld"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.error"
            Next        = "CallbackFailed"
          },
        ]
        Next = "MarkProverStarted"
      }
      CheckProverSlotHeld = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:getItem"
        Parameters = {
          TableName = aws_dynamodb_table.prover_semaphore.name
          Key = {
            LockName = {
              S = local.prover_semaphore_lock_name
            }
          }
          ConsistentRead       = true
          ProjectionExpression = "#owner"
          ExpressionAttributeNames = {
            "#owner.$" = "$$.Execution.Name"
          }
        }
        ResultPath = "$.slotCheck"
        Retry = [
          {
            ErrorEquals = [
              "DynamoDB.ProvisionedThroughputExceededException",
              "DynamoDB.ThrottlingException",
              "DynamoDB.InternalServerError",
            ]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          },
        ]
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.error"
            Next        = "CallbackFailed"
          },
        ]
        Next = "CheckProverSlotHeldChoice"
      }
      CheckProverSlotHeldChoice = {
        Type = "Choice"
        Choices = [
          {
            Variable  = "$.slotCheck.Item"
            IsPresent = true
            Next      = "FormatSlotCheck"
          },
        ]
        Default = "CallbackCapacityWaitFailed"
      }
      FormatSlotCheck = {
        Type = "Pass"
        Parameters = {
          "ownerJson.$" = "States.JsonToString($.slotCheck.Item)"
        }
        ResultPath = "$.slotCheck.ownerJson"
        Next       = "CheckFormattedSlotHeld"
      }
      CheckFormattedSlotHeld = {
        Type = "Choice"
        Choices = [
          {
            Variable      = "$.slotCheck.ownerJson.ownerJson"
            StringMatches = "*S*"
            Next          = "MarkProverStarted"
          },
        ]
        Default = "CallbackCapacityWaitFailed"
      }
      MarkProverStarted = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.target["finalization_writer"].arn
          Payload = {
            status           = "RUNNING"
            "payload.$"      = "$"
            "executionArn.$" = "$$.Execution.Id"
            "startedAt.$"    = "$$.State.EnteredTime"
          }
        }
        ResultPath = "$.markStarted"
        Retry      = local.callback_delivery_retry
        Catch = [
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.error"
            Next        = "ReleaseAfterFailure"
          },
        ]
        Next = "CheckProverStartAdmitted"
      }
      CheckProverStartAdmitted = {
        Type = "Choice"
        Choices = [
          {
            Variable     = "$.markStarted.Payload.state.status"
            StringEquals = "running"
            Next         = "RunProver"
          },
        ]
        Default = "ReleaseSuperseded"
      }
      RunProver = {
        Type           = "Task"
        Resource       = "arn:aws:states:::ecs:runTask.sync"
        TimeoutSeconds = var.prover_task_timeout_seconds
        Parameters = {
          Cluster        = aws_ecs_cluster.prover.arn
          TaskDefinition = aws_ecs_task_definition.prover.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "ENABLED"
              SecurityGroups = var.prover_security_group_ids
              Subnets        = var.prover_subnet_ids
            }
          }
          Overrides = {
            ContainerOverrides = [
              {
                Name = "prover"
                Environment = [
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
                    Name  = "EXPECTED_IMAGE_ID"
                    Value = var.expected_image_id
                  },
                ]
              },
            ]
          }
        }
        ResultPath = "$.proverResult"
        Next       = "ReleaseAfterSuccess"
        Retry = [
          {
            ErrorEquals = [
              "AmazonECS.Unknown",
              "ECS.ServerException",
              "ECS.ThrottlingException",
              "ECS.AmazonECSException",
            ]
            IntervalSeconds = 10
            BackoffRate     = 2
            MaxAttempts     = 5
          },
        ]
        Catch = [
          {
            ErrorEquals = ["States.Timeout"]
            ResultPath  = "$.error"
            Next        = "ReleaseAfterTimeout"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = "$.error"
            Next        = "ReleaseAfterFailure"
          },
        ]
      }
      ReleaseAfterSuccess = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.prover_semaphore.name
          Key = {
            LockName = {
              S = local.prover_semaphore_lock_name
            }
          }
          UpdateExpression    = "SET currentLockCount = currentLockCount - :one REMOVE #owner"
          ConditionExpression = "attribute_exists(#owner) AND currentLockCount >= :one"
          ExpressionAttributeNames = {
            "#owner.$" = "$$.Execution.Name"
          }
          ExpressionAttributeValues = {
            ":one" = {
              N = "1"
            }
          }
        }
        ResultPath = null
        Retry = [
          {
            ErrorEquals = [
              "DynamoDB.ProvisionedThroughputExceededException",
              "DynamoDB.ThrottlingException",
              "DynamoDB.InternalServerError",
            ]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          },
        ]
        Catch = [
          {
            ErrorEquals = ["DynamoDB.ConditionalCheckFailedException"]
            ResultPath  = null
            Next        = "CallbackSucceeded"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = null
            Next        = "CallbackSucceeded"
          },
        ]
        Next = "CallbackSucceeded"
      }
      CallbackSucceeded = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.target["finalization_writer"].arn
          Payload = {
            status           = "SUCCEEDED"
            "payload.$"      = "$"
            "executionArn.$" = "$$.Execution.Id"
          }
        }
        Retry = local.callback_delivery_retry
        Catch = local.callback_delivery_catch
        End   = true
      }
      ReleaseAfterTimeout = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.prover_semaphore.name
          Key = {
            LockName = {
              S = local.prover_semaphore_lock_name
            }
          }
          UpdateExpression    = "SET currentLockCount = currentLockCount - :one REMOVE #owner"
          ConditionExpression = "attribute_exists(#owner) AND currentLockCount >= :one"
          ExpressionAttributeNames = {
            "#owner.$" = "$$.Execution.Name"
          }
          ExpressionAttributeValues = {
            ":one" = {
              N = "1"
            }
          }
        }
        ResultPath = null
        Retry = [
          {
            ErrorEquals = [
              "DynamoDB.ProvisionedThroughputExceededException",
              "DynamoDB.ThrottlingException",
              "DynamoDB.InternalServerError",
            ]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          },
        ]
        Catch = [
          {
            ErrorEquals = ["DynamoDB.ConditionalCheckFailedException"]
            ResultPath  = null
            Next        = "CallbackTimedOut"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = null
            Next        = "CallbackTimedOut"
          },
        ]
        Next = "CallbackTimedOut"
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
            "timeoutAt.$"    = "$$.State.EnteredTime"
          }
        }
        Retry = local.callback_delivery_retry
        Catch = local.callback_delivery_catch
        End   = true
      }
      ReleaseAfterFailure = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.prover_semaphore.name
          Key = {
            LockName = {
              S = local.prover_semaphore_lock_name
            }
          }
          UpdateExpression    = "SET currentLockCount = currentLockCount - :one REMOVE #owner"
          ConditionExpression = "attribute_exists(#owner) AND currentLockCount >= :one"
          ExpressionAttributeNames = {
            "#owner.$" = "$$.Execution.Name"
          }
          ExpressionAttributeValues = {
            ":one" = {
              N = "1"
            }
          }
        }
        ResultPath = null
        Retry = [
          {
            ErrorEquals = [
              "DynamoDB.ProvisionedThroughputExceededException",
              "DynamoDB.ThrottlingException",
              "DynamoDB.InternalServerError",
            ]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          },
        ]
        Catch = [
          {
            ErrorEquals = ["DynamoDB.ConditionalCheckFailedException"]
            ResultPath  = null
            Next        = "CallbackFailed"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = null
            Next        = "CallbackFailed"
          },
        ]
        Next = "CallbackFailed"
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
            error = {
              code    = "PROVER_IMAGE_SIGNATURE_FAILED"
              message = "Target prover image signature verification failed"
              details = {
                "signingStatus.$" = "$.signingStatus.Payload.status"
              }
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
      CallbackCapacityWaitFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.target["finalization_writer"].arn
          Payload = {
            status           = "FAILED"
            "payload.$"      = "$"
            "executionArn.$" = "$$.Execution.Id"
            error = {
              code    = "PROVER_CAPACITY_WAIT_TIMEOUT"
              message = "Timed out waiting for target prover capacity"
            }
          }
        }
        Retry = local.callback_delivery_retry
        Catch = local.callback_delivery_catch
        End   = true
      }
      ReleaseSuperseded = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.prover_semaphore.name
          Key = {
            LockName = {
              S = local.prover_semaphore_lock_name
            }
          }
          UpdateExpression    = "SET currentLockCount = currentLockCount - :one REMOVE #owner"
          ConditionExpression = "attribute_exists(#owner) AND currentLockCount >= :one"
          ExpressionAttributeNames = {
            "#owner.$" = "$$.Execution.Name"
          }
          ExpressionAttributeValues = {
            ":one" = {
              N = "1"
            }
          }
        }
        ResultPath = null
        Retry = [
          {
            ErrorEquals = [
              "DynamoDB.ProvisionedThroughputExceededException",
              "DynamoDB.ThrottlingException",
              "DynamoDB.InternalServerError",
            ]
            IntervalSeconds = 2
            BackoffRate     = 2
            MaxAttempts     = 3
          },
        ]
        Catch = [
          {
            ErrorEquals = ["DynamoDB.ConditionalCheckFailedException"]
            ResultPath  = null
            Next        = "ProverStartSuperseded"
          },
          {
            ErrorEquals = ["States.ALL"]
            ResultPath  = null
            Next        = "ProverStartSuperseded"
          },
        ]
        Next = "ProverStartSuperseded"
      }
      ProverStartSuperseded = {
        Type = "Succeed"
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

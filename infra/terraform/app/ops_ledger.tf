locals {
  ops_ledger_pipeline_names = [
    "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}",
    "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-foundation",
    "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-app",
    "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-app-static-fast",
    "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-toolchain-release",
    "${var.project_name}-pipeline-${var.account_alias}-${var.deployment_environment}-prover-release",
  ]

  # CloudWatch Logs targets require an epoch-millisecond timestamp that an
  # EventBridge input transformer cannot derive from the ISO event time. The
  # existing semaphore janitor Lambda therefore exact-validates these reduced
  # records, derives the ingestion timestamp, and writes only the common schema.
  ops_ledger_event_rules = {
    alarm_state_changed = {
      description = "Normalize target CloudWatch alarm state changes into the operations ledger."
      rule_suffix = "ops-alarm-changed"
      event_pattern = {
        source        = ["aws.cloudwatch"]
        "detail-type" = ["CloudWatch Alarm State Change"]
        detail = {
          alarmName = [{ prefix = "${local.name_prefix}-" }]
          state = {
            value = ["ALARM", "OK", "INSUFFICIENT_DATA"]
          }
        }
      }
      input_paths = {
        resource_name = "$.detail.alarmName"
        state         = "$.detail.state.value"
        ts            = "$.time"
      }
      input_template = "{\"ts\":<ts>,\"event_type\":\"alarm_state_changed\",\"env\":\"${var.deployment_environment}\",\"resource_name\":<resource_name>,\"state\":<state>}"
    }
    ecs_task_stopped = {
      description = "Normalize target prover ECS task stops into the operations ledger."
      rule_suffix = "ops-ecs-stopped"
      event_pattern = {
        source        = ["aws.ecs"]
        "detail-type" = ["ECS Task State Change"]
        detail = {
          clusterArn = [aws_ecs_cluster.prover.arn]
          lastStatus = ["STOPPED"]
          group      = [{ prefix = "dep_" }]
          taskDefinitionArn = [{
            prefix = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/${aws_ecs_task_definition.prover.family}:"
          }]
        }
      }
      input_paths = {
        deployment_id = "$.detail.group"
        ts            = "$.time"
      }
      input_template = "{\"ts\":<ts>,\"event_type\":\"ecs_task_stopped\",\"env\":\"${var.deployment_environment}\",\"deployment_id\":<deployment_id>,\"resource_name\":\"prover-task\",\"state\":\"STOPPED\"}"
    }
    pipeline_execution_changed = {
      description = "Normalize target app CodePipeline execution changes into the operations ledger."
      rule_suffix = "ops-pipeline-changed"
      event_pattern = {
        source        = ["aws.codepipeline"]
        "detail-type" = ["CodePipeline Pipeline Execution State Change"]
        detail = {
          pipeline = local.ops_ledger_pipeline_names
          state = [
            "STARTED",
            "SUCCEEDED",
            "RESUMED",
            "FAILED",
            "CANCELED",
            "SUPERSEDED",
            "STOPPING",
            "STOPPED",
          ]
        }
      }
      input_paths = {
        resource_name = "$.detail.pipeline"
        state         = "$.detail.state"
        ts            = "$.time"
      }
      input_template = "{\"ts\":<ts>,\"event_type\":\"pipeline_execution_changed\",\"env\":\"${var.deployment_environment}\",\"resource_name\":<resource_name>,\"state\":<state>}"
    }
    deployment_accepted = {
      description = "Normalize accepted target app deployment evidence into the operations ledger."
      rule_suffix = "ops-deploy-accepted"
      event_pattern = {
        source        = ["stark-ballot.observability"]
        "detail-type" = ["Accepted Deployment"]
        detail = {
          event_type    = ["deployment_accepted"]
          env           = [var.deployment_environment]
          deployment_id = [{ prefix = "dep_" }]
          resource_name = ["app"]
          state         = ["ACCEPTED"]
        }
      }
      input_paths = {
        deployment_id = "$.detail.deployment_id"
        ts            = "$.detail.ts"
      }
      input_template = "{\"ts\":<ts>,\"event_type\":\"deployment_accepted\",\"env\":\"${var.deployment_environment}\",\"deployment_id\":<deployment_id>,\"resource_name\":\"app\",\"state\":\"ACCEPTED\"}"
    }
  }
}

resource "aws_cloudwatch_log_group" "ops_ledger" {
  name              = "/aws/events/${local.name_prefix}-ops-ledger"
  retention_in_days = local.storage_retention.ops_ledger_log_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_event_rule" "ops_ledger" {
  for_each = local.ops_ledger_event_rules

  name          = "${local.name_prefix}-${each.value.rule_suffix}"
  description   = each.value.description
  event_pattern = jsonencode(each.value.event_pattern)

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "ops_ledger" {
  for_each = local.ops_ledger_event_rules

  rule      = aws_cloudwatch_event_rule.ops_ledger[each.key].name
  target_id = "normalized-ops-ledger"
  arn       = aws_lambda_function.target["semaphore_janitor"].arn

  input_transformer {
    input_paths    = each.value.input_paths
    input_template = each.value.input_template
  }
}

resource "aws_lambda_permission" "ops_ledger" {
  for_each      = aws_cloudwatch_event_rule.ops_ledger
  statement_id  = "AllowOpsLedger${replace(title(replace(each.key, "_", " ")), " ", "")}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.target["semaphore_janitor"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = each.value.arn
}

resource "aws_cloudwatch_query_definition" "ops_ledger_window" {
  name            = "${local.name_prefix}/ops-ledger/last-24-hours"
  log_group_names = [aws_cloudwatch_log_group.ops_ledger.name]

  query_string = <<-QUERY
    fields @timestamp, event_type, deployment_id, resource_name, state, reason_code
    | filter toMillis(@timestamp) >= (now() * 1000 - 86400000)
    | sort @timestamp asc
    | limit 200
  QUERY
}

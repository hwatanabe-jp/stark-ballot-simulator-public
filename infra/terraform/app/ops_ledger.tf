locals {
  ops_ledger_pipeline_names = compact([
    local.bootstrap_lane_authority.names.pipeline,
    local.foundation_lane_authority.names.pipeline,
    local.app_lane_authority.names.pipeline,
    local.toolchain_lane_authority.names.pipeline,
    local.prover_lane_authority.names.pipeline,
  ])

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
    prover_job_finished = {
      description = "Normalize terminal target Batch prover jobs into the operations ledger."
      rule_suffix = "ops-prover-finished"
      event_pattern = {
        source        = ["aws.batch"]
        "detail-type" = ["Batch Job State Change"]
        detail = {
          jobQueue = [aws_batch_job_queue.prover.arn]
          status   = ["SUCCEEDED", "FAILED"]
          tags     = { deployment_id = [{ prefix = "dep_" }] }
        }
      }
      input_paths = {
        deployment_id = "$.detail.tags.deployment_id"
        state         = "$.detail.status"
        ts            = "$.time"
      }
      input_template = "{\"ts\":<ts>,\"event_type\":\"prover_job_finished\",\"env\":\"${var.deployment_environment}\",\"deployment_id\":<deployment_id>,\"resource_name\":\"prover-job\",\"state\":<state>}"
    }
    pipeline_execution_changed = {
      description = "Normalize target app CodePipeline execution changes into the operations ledger."
      rule_suffix = "ops-pipeline-changed"
      event_pattern = {
        source        = ["aws.codepipeline"]
        "detail-type" = ["CodePipeline Pipeline Execution State Change"]
        detail = {
          pipeline       = local.ops_ledger_pipeline_names
          "execution-id" = [{ exists = true }]
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
        pipeline_execution_id = "$.detail.execution-id"
        resource_name         = "$.detail.pipeline"
        state                 = "$.detail.state"
        ts                    = "$.time"
      }
      input_template = "{\"ts\":<ts>,\"event_type\":\"pipeline_execution_changed\",\"env\":\"${var.deployment_environment}\",\"pipeline_execution_id\":<pipeline_execution_id>,\"resource_name\":<resource_name>,\"state\":<state>}"
    }
    deployment_accepted = {
      description = "Normalize accepted target app deployment evidence into the operations ledger."
      rule_suffix = "ops-deploy-accepted"
      event_pattern = {
        source        = ["stark-ballot.observability"]
        "detail-type" = ["Accepted Deployment"]
        detail = {
          event_type            = ["deployment_accepted"]
          env                   = [var.deployment_environment]
          deployment_id         = [{ prefix = "dep_" }]
          deployment_mode       = ["normal", "rollback"]
          pipeline_execution_id = [{ exists = true }]
          plan_disposition      = ["changed", "empty"]
          resource_name         = ["app"]
          state                 = ["ACCEPTED"]
        }
      }
      input_paths = {
        deployment_id         = "$.detail.deployment_id"
        deployment_mode       = "$.detail.deployment_mode"
        pipeline_execution_id = "$.detail.pipeline_execution_id"
        plan_disposition      = "$.detail.plan_disposition"
        ts                    = "$.detail.ts"
      }
      input_template = "{\"ts\":<ts>,\"event_type\":\"deployment_accepted\",\"env\":\"${var.deployment_environment}\",\"deployment_id\":<deployment_id>,\"deployment_mode\":<deployment_mode>,\"pipeline_execution_id\":<pipeline_execution_id>,\"plan_disposition\":<plan_disposition>,\"resource_name\":\"app\",\"state\":\"ACCEPTED\"}"
    }
  }

  ops_ledger_change_health_queries = {
    accepted_deployments_by_week        = <<-QUERY
      # Project-level change-health proxy; EventBridge delivery is at least once.
      fields @timestamp, pipeline_execution_id, deployment_mode, plan_disposition
      | filter event_type = "deployment_accepted"
      | stats latest(@timestamp) as accepted_at, latest(deployment_mode) as deployment_mode, latest(plan_disposition) as plan_disposition by pipeline_execution_id
      | stats count(*) as accepted_deployments by datefloor(accepted_at, 1w) as accepted_week, deployment_mode, plan_disposition
      | sort accepted_week desc
    QUERY
    pipeline_start_to_acceptance        = <<-QUERY
      # Project-level change-health proxy; duplicate delivery does not change min/max timestamps.
      fields @timestamp, pipeline_execution_id, event_type, state, deployment_mode, plan_disposition
      | filter event_type in ["pipeline_execution_changed", "deployment_accepted"] and state in ["STARTED", "ACCEPTED"]
      | stats min(toMillis(@timestamp)) as first_seen_ms, max(toMillis(@timestamp)) as accepted_ms, count_distinct(state) as observed_state_count, latest(deployment_mode) as deployment_mode, latest(plan_disposition) as plan_disposition by pipeline_execution_id
      | filter observed_state_count = 2
      | fields pipeline_execution_id, fromMillis(first_seen_ms) as started_at, fromMillis(accepted_ms) as accepted_at, (accepted_ms - first_seen_ms) / 1000 as lead_time_seconds, deployment_mode, plan_disposition
      | sort accepted_at desc
    QUERY
    terminal_pipeline_result            = <<-QUERY
      # Project-level change-health proxy; one terminal state is retained per execution.
      fields @timestamp, pipeline_execution_id, event_type, resource_name, state
      | filter event_type = "pipeline_execution_changed" and state in ["SUCCEEDED", "FAILED", "CANCELED", "SUPERSEDED", "STOPPED"]
      | stats latest(@timestamp) as terminal_at, latest(state) as terminal_state by pipeline_execution_id, resource_name
      | stats count(*) as terminal_executions by datefloor(terminal_at, 1w) as terminal_week, resource_name, terminal_state
      | sort terminal_week desc
    QUERY
    failed_execution_to_next_acceptance = <<-QUERY
      # Project-level change-health proxy; sorted deduplicated rows expose the next acceptance without claiming a join.
      fields @timestamp, pipeline_execution_id, event_type, resource_name, state, deployment_mode, plan_disposition
      | filter (event_type = "pipeline_execution_changed" and state in ["FAILED", "CANCELED", "SUPERSEDED", "STOPPED"]) or event_type = "deployment_accepted"
      | stats latest(@timestamp) as event_at, latest(resource_name) as resource_name, latest(state) as state, latest(deployment_mode) as deployment_mode, latest(plan_disposition) as plan_disposition by pipeline_execution_id, event_type
      | sort event_at asc
    QUERY
    restart_supersession_and_retry_toil = <<-QUERY
      # Project-level change-health proxy; each execution/state pair is counted once.
      fields @timestamp, pipeline_execution_id, event_type, resource_name, state
      | filter event_type = "pipeline_execution_changed" and state in ["STARTED", "RESUMED", "SUPERSEDED", "STOPPING", "STOPPED"]
      | stats latest(@timestamp) as state_at by pipeline_execution_id, resource_name, state
      | stats count(*) as execution_state_transitions by datefloor(state_at, 1w) as transition_week, resource_name, state
      | sort transition_week desc
    QUERY
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
    fields @timestamp, event_type, deployment_id, deployment_mode, pipeline_execution_id, plan_disposition, resource_name, state
    | filter toMillis(@timestamp) >= (now() * 1000 - 86400000)
    | sort @timestamp asc
    | limit 200
  QUERY
}

resource "aws_cloudwatch_query_definition" "ops_ledger_change_health" {
  for_each        = local.ops_ledger_change_health_queries
  name            = "${local.name_prefix}/ops-ledger/change-health/${each.key}"
  log_group_names = [aws_cloudwatch_log_group.ops_ledger.name]
  query_string    = each.value
}

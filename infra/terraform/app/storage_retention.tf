locals {
  storage_retention_by_environment = {
    develop = {
      runtime_log_days                     = 90
      container_insights_performance_days  = 7
      ops_ledger_log_days                  = 365
      frontend_noncurrent_days             = 30
      dynamodb_point_in_time_recovery_days = 35
      incomplete_multipart_retention_days  = 7
    }
    main = {
      runtime_log_days                     = 180
      container_insights_performance_days  = 30
      ops_ledger_log_days                  = 731
      frontend_noncurrent_days             = 90
      dynamodb_point_in_time_recovery_days = 35
      incomplete_multipart_retention_days  = 7
    }
  }

  storage_retention = local.storage_retention_by_environment[var.deployment_environment]
}

# Keep the original address and log identity after retiring the scheduled
# controller. Retaining logs does not restore its Lambda, role or schedule.
resource "aws_cloudwatch_log_group" "ecr_retention" {
  name              = "/aws/lambda/${local.name_prefix}-ecr-retention"
  retention_in_days = 365
  tags              = local.common_tags
  lifecycle { prevent_destroy = true }
}

resource "aws_cloudwatch_log_group" "image_signature_verifier" {
  name              = "/aws/lambda/${local.image_signature_verifier_name}"
  retention_in_days = local.storage_retention.runtime_log_days
  tags              = local.common_tags
}

data "aws_secretsmanager_secret_version" "api_origin_verify_header" {
  count = local.api_origin_verify_header_configured ? 1 : 0

  secret_id     = local.api_origin_verify_header_secret_ref
  version_stage = "AWSCURRENT"
}

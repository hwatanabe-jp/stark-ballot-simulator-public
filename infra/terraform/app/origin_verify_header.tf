data "aws_secretsmanager_secret_version" "api_origin_verify_header" {
  count = 1

  secret_id     = local.api_origin_verify_header_secret_ref
  version_stage = "AWSCURRENT"
}

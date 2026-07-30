resource "aws_secretsmanager_secret" "runtime_secret" {
  for_each = {
    SESSION_CAPABILITY_SECRET_REF     = local.runtime_reference_names.SESSION_CAPABILITY_SECRET_REF
    VOTE_SECRET_ENCRYPTION_KEY_REF    = local.runtime_reference_names.VOTE_SECRET_ENCRYPTION_KEY_REF
    TURNSTILE_SECRET_KEY_REF          = local.runtime_reference_names.TURNSTILE_SECRET_KEY_REF
    EXPECTED_ORIGIN_VERIFY_HEADER_REF = local.runtime_reference_names.EXPECTED_ORIGIN_VERIFY_HEADER_REF
    LOG_IP_HASH_SALT_REF              = local.runtime_reference_names.LOG_IP_HASH_SALT_REF
  }

  name                    = each.value
  recovery_window_in_days = 30
  tags = merge(local.common_tags, {
    RuntimeReference = each.key
  })
}

resource "aws_ssm_parameter" "runtime_config" {
  for_each = {
    SESSION_CAPABILITY_TTL_SECONDS_REF = {
      name  = local.runtime_reference_names.SESSION_CAPABILITY_TTL_SECONDS_REF
      value = "86400"
    }
    VITE_TURNSTILE_SITE_KEY_REF = {
      name  = local.runtime_reference_names.VITE_TURNSTILE_SITE_KEY_REF
      value = "unset-before-plan-03"
    }
  }

  name  = each.value.name
  type  = "String"
  value = each.value.value
  tags = merge(local.common_tags, {
    RuntimeReference = each.key
  })

  lifecycle {
    ignore_changes = [value]
  }
}

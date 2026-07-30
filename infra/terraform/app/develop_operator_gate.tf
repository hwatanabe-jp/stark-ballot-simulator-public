locals {
  operator_gate_name   = "${local.name_prefix}-operator-gate"
  operator_gate_keyset = jsondecode(file("${path.module}/develop-operator-gate-keyset.json"))

  operator_gate_key_generations = local.operator_gate_keyset.generations
  operator_gate_issuer_generations = sort([
    for generation, key in local.operator_gate_key_generations : generation
    if key.status == "issuer"
  ])
  operator_gate_trusted_managed_generations = {
    for generation, key in local.operator_gate_key_generations : generation => key
    if contains(["issuer", "trusted-retiring"], key.status)
  }
  operator_gate_keyset_static_valid = (
    local.operator_gate_keyset.keysetType == "operator-gate"
    && toset(keys(local.operator_gate_keyset)) == toset(["keysetType", "issuerGeneration", "generations"])
    && length(local.operator_gate_key_generations) > 0
    && alltrue([
      for generation in keys(local.operator_gate_key_generations) :
      can(regex("^[0-9]{8}-[0-9]{2}$", generation))
    ])
    && alltrue([
      for key in values(local.operator_gate_key_generations) :
      toset(keys(key)) == toset(["status"])
    ])
    && alltrue([
      for key in values(local.operator_gate_key_generations) :
      contains(["issuer", "trusted-retiring", "detached"], key.status)
    ])
    && length(local.operator_gate_issuer_generations) == 1
    && try(local.operator_gate_issuer_generations[0] == local.operator_gate_keyset.issuerGeneration, false)
    && length(local.operator_gate_trusted_managed_generations) <= 5
  )
  operator_gate_managed_generations = (
    local.target_develop_operator_gate_requested && local.operator_gate_keyset_static_valid
    ? local.operator_gate_key_generations
    : {}
  )
  operator_gate_active_trusted_managed_generations = {
    for generation, key in local.operator_gate_managed_generations : generation => key
    if contains(["issuer", "trusted-retiring"], key.status)
  }
  operator_gate_managed_trusted_public_key_ids = [
    for generation in sort(keys(local.operator_gate_active_trusted_managed_generations)) :
    aws_cloudfront_public_key.develop_operator_gate_managed[generation].id
  ]
  operator_gate_trusted_public_key_ids = local.operator_gate_managed_trusted_public_key_ids
  operator_gate_keyset_configured = (
    local.target_develop_operator_gate_requested
    && local.operator_gate_keyset_static_valid
    && length(local.operator_gate_active_trusted_managed_generations) > 0
  )
  operator_gate_trusted_key_groups = (
    local.operator_gate_keyset_configured
    ? [aws_cloudfront_key_group.develop_operator_gate[0].id]
    : []
  )
}

resource "aws_kms_key" "develop_operator_gate" {
  for_each = local.operator_gate_managed_generations

  description              = "${local.operator_gate_name} signing key generation ${each.key}"
  customer_master_key_spec = "RSA_2048"
  key_usage                = "SIGN_VERIFY"
  is_enabled               = each.value.status != "detached"
  deletion_window_in_days  = 30

  tags = local.common_tags
}

resource "aws_kms_alias" "develop_operator_gate" {
  for_each = local.operator_gate_active_trusted_managed_generations

  name          = "alias/${local.operator_gate_name}-${each.key}"
  target_key_id = aws_kms_key.develop_operator_gate[each.key].key_id
}

data "aws_kms_public_key" "develop_operator_gate" {
  for_each = local.operator_gate_active_trusted_managed_generations

  key_id = aws_kms_key.develop_operator_gate[each.key].key_id
}

resource "aws_cloudfront_public_key" "develop_operator_gate_managed" {
  for_each = local.operator_gate_active_trusted_managed_generations

  name        = "${local.operator_gate_name}-${each.key}"
  comment     = "KMS-backed public key for ${local.operator_gate_name} generation ${each.key}"
  encoded_key = data.aws_kms_public_key.develop_operator_gate[each.key].public_key_pem
}

resource "aws_cloudfront_key_group" "develop_operator_gate" {
  count = local.operator_gate_keyset_configured ? 1 : 0

  name    = local.operator_gate_name
  comment = "Trusted key group for the ${local.name_prefix} operator/tester gate"
  items   = local.operator_gate_trusted_public_key_ids
}

check "develop_operator_gate_keyset" {
  assert {
    condition     = toset(keys(local.operator_gate_keyset)) == toset(["keysetType", "issuerGeneration", "generations"])
    error_message = "develop operator-gate keyset contains unsupported or missing top-level fields."
  }

  assert {
    condition     = local.operator_gate_keyset.keysetType == "operator-gate"
    error_message = "develop operator-gate keyset must use keysetType operator-gate."
  }

  assert {
    condition = alltrue([
      for key in values(local.operator_gate_key_generations) :
      toset(keys(key)) == toset(["status"])
    ])
    error_message = "develop operator-gate generation entries may contain only status."
  }

  assert {
    condition = alltrue([
      for key in values(local.operator_gate_key_generations) :
      contains(["issuer", "trusted-retiring", "detached"], key.status)
    ])
    error_message = "develop operator-gate key statuses must be issuer, trusted-retiring, or detached."
  }

  assert {
    condition     = length(local.operator_gate_issuer_generations) == 1
    error_message = "develop operator-gate keyset must contain exactly one issuer generation."
  }

  assert {
    condition     = try(local.operator_gate_issuer_generations[0] == local.operator_gate_keyset.issuerGeneration, false)
    error_message = "develop operator-gate issuerGeneration must name the sole issuer generation."
  }

  assert {
    condition     = length(local.operator_gate_trusted_public_key_ids) <= 5
    error_message = "CloudFront operator-gate key groups support at most five trusted public keys."
  }

  assert {
    condition     = length(distinct(local.operator_gate_trusted_public_key_ids)) == length(local.operator_gate_trusted_public_key_ids)
    error_message = "develop operator-gate trusted public-key IDs must be unique."
  }

}

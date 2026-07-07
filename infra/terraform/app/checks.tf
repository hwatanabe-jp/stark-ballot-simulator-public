check "state_identity" {
  assert {
    condition     = var.state_backend_key == local.expected_state_backend_key
    error_message = "state_backend_key must match project/account alias/deployment environment/state scope."
  }
}

resource "terraform_data" "skeletal_app_lane" {
  input = {
    account_alias          = var.account_alias
    deployment_environment = var.deployment_environment
    state_backend_key      = var.state_backend_key
    state_scope            = var.state_scope
  }

  lifecycle {
    precondition {
      condition     = !local.target_develop_operator_gate_requested || local.operator_gate_public_key_configured
      error_message = "operator-gated develop requires develop_operator_gate_public_key_pem."
    }

    precondition {
      condition     = !local.target_public_session_create_enabled || length(local.operator_gate_trusted_key_groups) > 0
      error_message = "TARGET_PUBLIC_SESSION_CREATE_ENABLED requires a configured develop operator-gate key group."
    }
  }
}

data "aws_caller_identity" "current" {}

check "account_identity" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
    error_message = "AWS caller account must match aws_account_id."
  }
}

check "prover_image_uri_authority" {
  assert {
    condition     = can(regex(local.prover_image_uri_pattern, var.prover_image_uri))
    error_message = "prover_image_uri must reference the expected target account and region."
  }
}

check "target_public_session_turnstile_gate" {
  assert {
    condition = (
      !local.target_public_session_create_enabled
      || local.session_create_turnstile_required
      || local.target_develop_operator_gate_enabled
    )
    error_message = "TARGET_PUBLIC_SESSION_CREATE_ENABLED without SESSION_CREATE_TURNSTILE_REQUIRED is allowed only for operator-gated develop."
  }
}

check "develop_operator_gate_configured" {
  assert {
    condition = (
      !local.target_develop_operator_gate_requested
      || (local.operator_gate_public_key_configured && local.api_origin_verify_header_configured)
    )
    error_message = "operator-gated develop requires develop_operator_gate_public_key_pem and AWSCURRENT at EXPECTED_ORIGIN_VERIFY_HEADER_REF."
  }
}

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
      condition     = data.aws_caller_identity.current.account_id == var.aws_account_id
      error_message = "AWS caller account must match aws_account_id."
    }

    precondition {
      condition     = data.aws_region.current.region == var.aws_region
      error_message = "AWS provider region must match aws_region."
    }

    precondition {
      condition     = local.api_origin_verify_header_configured
      error_message = "The CloudFront API origin requires a non-empty AWSCURRENT value at EXPECTED_ORIGIN_VERIFY_HEADER_REF."
    }

    precondition {
      condition = (
        !local.target_develop_operator_gate_requested
        || (local.operator_gate_keyset_configured && local.api_origin_verify_header_configured)
      )
      error_message = "operator-gated develop requires a valid tracked KMS-backed operator-gate keyset and non-empty AWSCURRENT origin-verify secret."
    }

    precondition {
      condition     = !local.target_public_session_create_enabled || length(local.operator_gate_trusted_key_groups) > 0
      error_message = "TARGET_PUBLIC_SESSION_CREATE_ENABLED requires a configured develop operator-gate key group."
    }

    precondition {
      condition     = var.dynamodb_recovery_activation == null ? true : var.dynamodb_recovery_activation.kms_key_arn == aws_kms_key.app_data.arn
      error_message = "dynamodb_recovery_activation must retain the Terraform-owned app-data KMS key."
    }

    precondition {
      condition = (
        var.dynamodb_recovery_phase == "primary_active"
        ? var.dynamodb_recovery_activation == null
        : var.dynamodb_recovery_activation != null
      )
      error_message = "primary_active requires a null dynamodb_recovery_activation; every transition phase requires one validated manifest."
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

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
      || (local.operator_gate_keyset_configured && local.api_origin_verify_header_configured)
    )
    error_message = "operator-gated develop requires a valid tracked KMS-backed keyset and AWSCURRENT at EXPECTED_ORIGIN_VERIFY_HEADER_REF."
  }
}

check "image_signature_verifier_timeout_budget" {
  assert {
    condition     = local.image_signature_verifier_timeout_budget_valid
    error_message = "The verifier process, signing-status retry, cleanup, handler, Step Functions, and Lambda timeout budgets must remain strictly bounded."
  }
}

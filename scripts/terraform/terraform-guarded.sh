#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

terraform_guard_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
deployment_target_configuration_path="${terraform_guard_script_dir}/../../packages/deployment-authority/deployment-targets.json"
deployment_authority_module_path="${terraform_guard_script_dir}/../../packages/deployment-authority/src/index.js"

usage() {
  cat <<'EOF'
Usage:
  scripts/terraform/terraform-guarded.sh <develop|main|account-alias/environment/scope> <terraform args...>

Runs Terraform only after checking:
  - AWS caller is an approved Terraform execution, bootstrap role, foundation CodeBuild role, or app CodeBuild role
  - AWS caller account matches the selected account identity
  - legacy mode workspace matches <develop|main>
  - target account mode plan/apply/destroy use the default workspace
  - plan/apply/destroy use a tfvars file whose environment matches the selected deployment environment

Optional:
  TERRAFORM_WORKING_DIR  # default: infra/terraform/legacy; target bootstrap requires infra/terraform/bootstrap; foundation requires infra/terraform/foundation; app requires infra/terraform/app

Run inside aws-vault, for example:
  aws-vault exec terraform-admin -- scripts/terraform/terraform-guarded.sh develop plan -var-file=develop.local.tfvars

For target account bootstrap init, run with an explicit AWS profile:
  AWS_PROFILE=stark-dev-admin TERRAFORM_WORKING_DIR=infra/terraform/bootstrap scripts/terraform/terraform-guarded.sh stark-dev/develop/bootstrap init -reconfigure -backend-config=backend.local.hcl
EOF
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_env_file() {
  local env_file="$1"
  local line key value

  if [ ! -f "$env_file" ]; then
    return 0
  fi

  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    case "$line" in
      ''|'#'*)
        continue
        ;;
    esac

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="$(trim "${BASH_REMATCH[2]}")"
      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      if [ -z "${!key+x}" ]; then
        export "$key=$value"
      fi
    fi
  done < "$env_file"
}

first_nonempty() {
  local name value
  for name in "$@"; do
    value="${!name:-}"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

upper_identifier() {
  local value="$1"
  value="${value^^}"
  value="${value//-/_}"
  printf '%s' "$value"
}

is_target_identity() {
  local value="$1"
  [[ "$value" =~ ^[a-z][a-z0-9-]*/(develop|main)/(bootstrap|foundation|app)$ ]]
}

require_reviewed_bootstrap_identity() {
  local identity="$1"

  if [ "$reviewed_target_environment_id" != "develop" ]; then
    echo "Production Bootstrap requires its explicit bounded initializer or the managed saved-plan lane." >&2
    exit 2
  fi
  if [ "$reviewed_target_scope" != "bootstrap" ] || [ "$identity" != "$reviewed_target_state_identity" ]; then
    echo "This bootstrap helper requires the exact reviewed Bootstrap state identity." >&2
    exit 2
  fi
}

parse_target_identity() {
  local identity="$1"
  IFS=/ read -r target_account_alias target_environment target_state_scope <<< "$identity"
}

expected_target_terraform_working_dir() {
  case "$reviewed_target_scope" in
    bootstrap)
      printf '%s' "infra/terraform/bootstrap"
      ;;
    foundation)
      printf '%s' "infra/terraform/foundation"
      ;;
    app)
      printf '%s' "infra/terraform/app"
      ;;
    *)
      echo "No Terraform root is authorized for target identity ${reviewed_target_state_identity}." >&2
      exit 2
      ;;
  esac
}

require_target_terraform_working_dir() {
  local identity="$1"
  local working_dir="$2"
  local expected_working_dir

  expected_working_dir="$(expected_target_terraform_working_dir)"
  if [ "$working_dir" != "$expected_working_dir" ]; then
    echo "Terraform working directory mismatch for target account mode." >&2
    echo "Expected TERRAFORM_WORKING_DIR: $expected_working_dir" >&2
    echo "Current TERRAFORM_WORKING_DIR: $working_dir" >&2
    exit 2
  fi
}

require_canonical_deployment_target_admission() {
  if ! node --input-type=module --eval 'await import(process.argv[1]);' "$deployment_authority_module_path" >/dev/null 2>&1; then
    echo "Reviewed deployment target configuration failed canonical admission." >&2
    exit 2
  fi
}

resolve_reviewed_target_root() {
  local identity="$1"
  local lane="$2"
  local resolved target_key

  require_canonical_deployment_target_admission
  target_key="${target_account_alias}/${target_environment}"
  if ! resolved="$({
    jq -er \
      --arg identity "$identity" \
      --arg lane "$lane" \
      --arg target_key "$target_key" \
      '
        select(keys == ["allowedTargets", "configurationType"])
        | select(.configurationType == "deployment-target-configuration")
        | .allowedTargets[$target_key] as $target
        | $target.lanes[$lane] as $root
        | [
            $target.accountId,
            $target.accountLabel,
            $target.environmentId,
            $target.projectId,
            $target.region,
            $target.sourceBranch,
            $root.scope,
            $root.stateIdentity,
            $root.backendKey,
            $root.names.terraformPlanRole,
            $root.names.terraformApplyRole,
            $root.names.terraformSmokeRole,
            $target.sharedNames.appSignaturePreflightPlanRole,
            $target.sharedNames.appSignaturePreflightApplyRole,
            $target.sharedNames.terraformStateBucket,
            $target.sharedNames.terraformStateKmsAlias
          ] as $values
        | select(
            $target.targetKey == $target_key
            and $target.accountLabel == ($target_key | split("/")[0])
            and $target.environmentId == ($target_key | split("/")[1])
            and $root.scope == $lane
            and $root.stateIdentity == $identity
            and all($values[]; type == "string" and length > 0)
          )
        | $values
        | @tsv
      ' "$deployment_target_configuration_path"
  } 2>/dev/null)"; then
    echo "Terraform target ${identity} is not authorized by the reviewed deployment configuration." >&2
    exit 2
  fi

  IFS=$'\t' read -r \
    reviewed_target_account_id \
    reviewed_target_account_label \
    reviewed_target_environment_id \
    reviewed_target_project_id \
    reviewed_target_region \
    reviewed_target_source_branch \
    reviewed_target_scope \
    reviewed_target_state_identity \
    reviewed_target_backend_key \
    reviewed_terraform_plan_role \
    reviewed_terraform_apply_role \
    reviewed_terraform_smoke_role \
    reviewed_app_signature_preflight_plan_role \
    reviewed_app_signature_preflight_apply_role \
    reviewed_target_state_bucket \
    reviewed_target_state_kms_alias \
    <<< "$resolved"
}

resolve_var_file() {
  local var_file="$1"
  local candidate

  if [[ "$var_file" = /* ]]; then
    candidate="$var_file"
  else
    candidate="${terraform_working_dir}/${var_file}"
  fi

  if [ -f "$candidate" ]; then
    (
      cd "$(dirname "$candidate")"
      printf '%s/%s' "$(pwd -P)" "$(basename "$candidate")"
    )
    return 0
  fi

  if [ -f "$var_file" ]; then
    (
      cd "$(dirname "$var_file")"
      printf '%s/%s' "$(pwd -P)" "$(basename "$var_file")"
    )
    return 0
  fi

  echo "Terraform var-file not found: $var_file" >&2
  exit 2
}

is_protected_target_var_key() {
  local key="$1"

  case "$key" in
    account_alias|aws_account_id|deployment_environment|github_full_repository_id|pipeline_artifact_bucket_name|project_name|source_branch|state_backend_key|state_bucket_name|state_kms_alias|state_kms_key_id|state_scope)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

reject_cli_var_assignment() {
  local assignment="$1"
  local key

  key="${assignment%%=*}"
  key="$(trim "$key")"
  if [ "${mode:-legacy}" = "target" ] && is_protected_target_var_key "$key"; then
    echo "Do not pass ${key} through -var in target account mode; set it only in the guarded tfvars file." >&2
    exit 2
  fi
  if [ "$key" = "environment" ]; then
    echo "Do not pass environment through -var; set it only in the guarded tfvars file." >&2
    exit 2
  fi
}

read_tfvars_scalar() {
  local var_file="$1"
  local requested_key="$2"
  local line key value

  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    case "$line" in
      ''|'#'*)
        continue
        ;;
    esac
    case "$line" in
      *=*)
        key="${line%%=*}"
        key="$(trim "$key")"
        if [ "$key" != "$requested_key" ]; then
          continue
        fi
        value="${line#*=}"
        value="$(trim "$value")"
        value="${value%%#*}"
        value="$(trim "$value")"
        value="${value%\"}"
        value="${value#\"}"
        printf '%s' "$value"
        return 0
        ;;
    esac
  done < "$var_file"

  return 1
}

read_tfvars_environment() {
  local var_file="$1"
  local value

  if value="$(read_tfvars_scalar "$var_file" deployment_environment)"; then
    printf 'deployment_environment:%s' "$value"
    return 0
  fi
  if value="$(read_tfvars_scalar "$var_file" environment)"; then
    printf 'environment:%s' "$value"
    return 0
  fi

  echo "Terraform var-file must include environment or deployment_environment set to \"develop\" or \"main\"." >&2
  exit 2
}

require_target_tfvars_value() {
  local var_file="$1"
  local key="$2"
  local expected="$3"
  local actual

  if ! actual="$(read_tfvars_scalar "$var_file" "$key")"; then
    echo "target account tfvars must set ${key} for ${identity_arg}." >&2
    exit 2
  fi
  if [ "$actual" != "$expected" ]; then
    echo "target account tfvars ${key} mismatch." >&2
    echo "Expected ${key}: ${expected}" >&2
    echo "tfvars ${key}: ${actual}" >&2
    exit 2
  fi
}

validate_optional_target_tfvars_value() {
  local var_file="$1"
  local key="$2"
  local expected="$3"
  local actual

  if ! actual="$(read_tfvars_scalar "$var_file" "$key")"; then
    return 0
  fi
  if [ "$actual" != "$expected" ]; then
    echo "target account tfvars ${key} mismatch." >&2
    echo "Expected ${key}: ${expected}" >&2
    echo "tfvars ${key}: ${actual}" >&2
    exit 2
  fi
}

validate_target_tfvars_identity() {
  local var_file="$1"

  require_target_tfvars_value "$var_file" aws_account_id "$expected_account_id"
  require_target_tfvars_value "$var_file" account_alias "$reviewed_target_account_label"
  require_target_tfvars_value "$var_file" aws_region "$reviewed_target_region"
  require_target_tfvars_value "$var_file" deployment_environment "$reviewed_target_environment_id"
  require_target_tfvars_value "$var_file" state_scope "$reviewed_target_scope"
  require_target_tfvars_value "$var_file" state_backend_key "$reviewed_target_backend_key"
  validate_optional_target_tfvars_value "$var_file" project_name "$reviewed_target_project_id"
  validate_optional_target_tfvars_value "$var_file" source_branch "$reviewed_target_source_branch"
}

require_expected_account() {
  local env_upper="$1"
  local expected_account_id

  expected_account_id="$(
    first_nonempty "TERRAFORM_AWS_ACCOUNT_ID_${env_upper}" TERRAFORM_AWS_ACCOUNT_ID AWS_ACCOUNT_ID || true
  )"
  if [[ ! "$expected_account_id" =~ ^[0-9]{12}$ ]]; then
    echo "Missing or invalid TERRAFORM_AWS_ACCOUNT_ID for Terraform guard." >&2
    exit 2
  fi

  printf '%s' "$expected_account_id"
}

require_expected_target_account() {
  local account_alias="$1"
  local account_upper expected_account_id

  account_upper="$(upper_identifier "$account_alias")"
  expected_account_id="$(
    first_nonempty "TERRAFORM_AWS_ACCOUNT_ID_${account_upper}" TERRAFORM_AWS_ACCOUNT_ID AWS_ACCOUNT_ID || true
  )"
  if [[ ! "$expected_account_id" =~ ^[0-9]{12}$ ]]; then
    echo "Missing or invalid TERRAFORM_AWS_ACCOUNT_ID for target Terraform guard." >&2
    exit 2
  fi
  if [ "$expected_account_id" != "$reviewed_target_account_id" ]; then
    echo "Terraform target account does not match the reviewed deployment configuration." >&2
    echo "Reviewed target account: $reviewed_target_account_id" >&2
    exit 2
  fi

  printf '%s' "$reviewed_target_account_id"
}

require_allowed_caller() {
  local expected_account_id="$1"
  local required_pattern="$2"
  local role_error="$3"
  local caller account arn

  if ! caller="$(aws sts get-caller-identity --query '[Account,Arn]' --output text --no-cli-pager)"; then
    echo "Failed to read AWS caller identity. Check AWS_PROFILE or aws-vault credentials and try again." >&2
    exit 2
  fi

  account="$(printf '%s\n' "$caller" | awk '{print $1}')"
  arn="$(printf '%s\n' "$caller" | awk '{print $2}')"

  if [ "$account" != "$expected_account_id" ]; then
    echo "AWS account mismatch for Terraform." >&2
    echo "Expected account: $expected_account_id" >&2
    echo "Current account: $account" >&2
    exit 2
  fi

  if [[ ! "$arn" =~ $required_pattern ]]; then
    echo "$role_error" >&2
    echo "Current caller ARN did not match the required role." >&2
    exit 2
  fi

}

require_terraform_admin_caller() {
  local expected_account_id="$1"
  local required_pattern role_error

  required_pattern="^arn:aws:sts::${expected_account_id}:assumed-role/terraform-admin/.+$"
  role_error="Terraform must run as arn:aws:sts::${expected_account_id}:assumed-role/terraform-admin/*."
  require_allowed_caller "$expected_account_id" "$required_pattern" "$role_error"
}

require_target_caller() {
  local expected_account_id="$1"
  local state_scope="$2"
  local required_pattern role_error

  required_pattern="${TERRAFORM_ALLOWED_PRINCIPAL_ARN_PATTERN:-}"
  if [ -z "$required_pattern" ]; then
    case "$state_scope" in
      bootstrap)
        required_pattern="^arn:aws:sts::${expected_account_id}:assumed-role/AWSReservedSSO_AdministratorAccess_[0-9a-f]{16}/[A-Za-z0-9+=,.@_-]+$"
        ;;
      *)
        echo "TERRAFORM_ALLOWED_PRINCIPAL_ARN_PATTERN is required for target state scope ${state_scope}." >&2
        exit 2
        ;;
    esac
  fi
  role_error="Terraform target account guard rejected the current caller for state scope ${state_scope}."
  require_allowed_caller "$expected_account_id" "$required_pattern" "$role_error"
}

is_app_signature_preflight_plan_caller() {
  [ "${current_terraform_caller_role_name:-}" = "$reviewed_app_signature_preflight_plan_role" ]
}

require_allowed_role_caller() {
  local expected_account_id="$1"
  local role_error="$2"
  shift 2
  local allowed_role_name assumed_role_prefix caller account arn role_and_session role_name

  if ! caller="$(aws sts get-caller-identity --query '[Account,Arn]' --output text --no-cli-pager)"; then
    echo "Failed to read AWS caller identity. Check AWS_PROFILE or aws-vault credentials and try again." >&2
    exit 2
  fi

  account="$(printf '%s\n' "$caller" | awk '{print $1}')"
  arn="$(printf '%s\n' "$caller" | awk '{print $2}')"

  if [ "$account" != "$expected_account_id" ]; then
    echo "AWS account mismatch for Terraform." >&2
    echo "Expected account: $expected_account_id" >&2
    echo "Current account: $account" >&2
    exit 2
  fi

  assumed_role_prefix="arn:aws:sts::${expected_account_id}:assumed-role/"
  role_and_session="${arn#"$assumed_role_prefix"}"
  if [ "$role_and_session" = "$arn" ] || [[ "$role_and_session" != */* ]]; then
    echo "$role_error" >&2
    echo "Current caller ARN was not an assumed-role session in the target account." >&2
    exit 2
  fi

  role_name="${role_and_session%%/*}"
  if [ -z "$role_name" ] || [ -z "${role_and_session#*/}" ]; then
    echo "$role_error" >&2
    echo "Current caller ARN was not an assumed-role session in the target account." >&2
    exit 2
  fi

  for allowed_role_name in "$@"; do
    if [ "$role_name" = "$allowed_role_name" ]; then
      current_terraform_caller_role_name="$role_name"
      return 0
    fi
  done

  echo "$role_error" >&2
  echo "Current caller ARN did not match the required role." >&2
  exit 2
}

require_app_caller_for_command() {
  local expected_account_id="$1"
  local command_name="$2"
  local role_label role_error
  local -a allowed_role_names

  case "$command_name" in
    init)
      allowed_role_names=(
        "$reviewed_terraform_plan_role"
        "$reviewed_terraform_apply_role"
        "$reviewed_app_signature_preflight_plan_role"
        "$reviewed_app_signature_preflight_apply_role"
      )
      role_label="plan or apply"
      ;;
    validate|plan)
      allowed_role_names=(
        "$reviewed_terraform_plan_role"
        "$reviewed_app_signature_preflight_plan_role"
      )
      role_label="plan"
      ;;
    apply)
      allowed_role_names=(
        "$reviewed_terraform_apply_role"
        "$reviewed_app_signature_preflight_apply_role"
      )
      role_label="apply"
      ;;
    smoke)
      allowed_role_names=("$reviewed_terraform_smoke_role")
      role_label="smoke"
      ;;
    destroy)
      echo "destroy is not authorized for target app state." >&2
      exit 2
      ;;
    *)
      echo "Unsupported app Terraform command: ${command_name}." >&2
      echo "Allowed app commands are init, validate, plan, apply, and smoke." >&2
      exit 2
      ;;
  esac

  role_error="Terraform app guard requires the app ${role_label} CodeBuild role for ${command_name}."
  require_allowed_role_caller "$expected_account_id" "$role_error" "${allowed_role_names[@]}"
}

require_foundation_caller_for_command() {
  local expected_account_id="$1"
  local command_name="$2"
  local role_label role_error
  local -a allowed_role_names

  case "$command_name" in
    init)
      allowed_role_names=(
        "$reviewed_terraform_plan_role"
        "$reviewed_terraform_apply_role"
      )
      role_label="plan or apply"
      ;;
    validate|plan)
      allowed_role_names=("$reviewed_terraform_plan_role")
      role_label="plan"
      ;;
    apply)
      allowed_role_names=("$reviewed_terraform_apply_role")
      role_label="apply"
      ;;
    smoke)
      allowed_role_names=("$reviewed_terraform_smoke_role")
      role_label="smoke"
      ;;
    destroy)
      echo "destroy is not authorized for target foundation state." >&2
      exit 2
      ;;
    *)
      echo "Unsupported foundation Terraform command: ${command_name}." >&2
      echo "Allowed foundation commands are init, validate, plan, apply, and smoke." >&2
      exit 2
      ;;
  esac

  role_error="Terraform foundation guard requires the foundation ${role_label} CodeBuild role for ${command_name}."
  require_allowed_role_caller "$expected_account_id" "$role_error" "${allowed_role_names[@]}"
}

require_matching_workspace() {
  local expected_workspace="$1"
  local workspace

  if ! workspace="$(terraform -chdir="$terraform_working_dir" workspace show)"; then
    echo "Failed to read Terraform workspace. Run terraform init first if this checkout is not initialized." >&2
    exit 2
  fi
  workspace="$(trim "$workspace")"

  if [ "$workspace" != "$expected_workspace" ]; then
    echo "Terraform workspace mismatch." >&2
    echo "Expected workspace: $expected_workspace" >&2
    echo "Current workspace: $workspace" >&2
    exit 2
  fi
}

require_matching_tfvars_environment() {
  local env_name="$1"
  local command_name="$2"
  shift 2
  local arg expected_var_file_name positional_arg_count resolved_var_file tfvars_env tfvars_env_record var_file
  local next_is_var=0 next_is_var_file=0 var_file_count=0
  positional_arg_count=0

  case "$command_name" in
    plan|apply|destroy)
      ;;
    *)
      return 0
      ;;
  esac

  if [ "$#" -gt 0 ] && [ "$1" = "$command_name" ]; then
    shift
  fi

  for arg in "$@"; do
    if [ "$next_is_var_file" -eq 1 ]; then
      var_file="$arg"
      var_file_count=$((var_file_count + 1))
      next_is_var_file=0
      continue
    fi

    if [ "$next_is_var" -eq 1 ]; then
      reject_cli_var_assignment "$arg"
      next_is_var=0
      continue
    fi

    case "$arg" in
      -var-file=*)
        var_file="${arg#-var-file=}"
        var_file_count=$((var_file_count + 1))
        ;;
      -var-file)
        next_is_var_file=1
        ;;
      -var=*)
        reject_cli_var_assignment "${arg#-var=}"
        ;;
      -var)
        next_is_var=1
        ;;
      -*)
        ;;
      *)
        positional_arg_count=$((positional_arg_count + 1))
        ;;
    esac
  done

  if [ "$next_is_var_file" -eq 1 ]; then
    echo "$command_name received -var-file without a value." >&2
    exit 2
  fi
  if [ "$next_is_var" -eq 1 ]; then
    echo "$command_name received -var without a value." >&2
    exit 2
  fi

  if [ "$var_file_count" -eq 0 ]; then
    if [ "$command_name" = "apply" ] && [ "$positional_arg_count" -eq 1 ]; then
      return 0
    fi
    echo "$command_name requires -var-file=<env>.local.tfvars when using terraform-guarded.sh." >&2
    exit 2
  fi
  if [ "$var_file_count" -ne 1 ]; then
    echo "$command_name accepts exactly one -var-file when using terraform-guarded.sh." >&2
    exit 2
  fi

  if [ "$mode" = "target" ] && { [ "${reviewed_target_scope:-}" = "app" ] || [ "${reviewed_target_scope:-}" = "foundation" ]; }; then
    expected_var_file_name="pipeline.auto.tfvars"
    if [ "$(basename "$var_file")" != "$expected_var_file_name" ]; then
      echo "$command_name requires -var-file=${expected_var_file_name} for target ${reviewed_target_scope} state." >&2
      exit 2
    fi
  else
    expected_var_file_name="${env_name}.local.tfvars"
    if [ "$(basename "$var_file")" != "$expected_var_file_name" ]; then
      echo "$command_name requires -var-file=${expected_var_file_name} when using terraform-guarded.sh." >&2
      exit 2
    fi
  fi

  resolved_var_file="$(resolve_var_file "$var_file")"
  tfvars_env_record="$(read_tfvars_environment "$resolved_var_file")"
  tfvars_env="${tfvars_env_record#*:}"
  if [ "$tfvars_env" != "$env_name" ]; then
    echo "tfvars environment mismatch." >&2
    echo "Expected environment: $env_name" >&2
    echo "tfvars environment: $tfvars_env" >&2
    exit 2
  fi
  if [ "$mode" = "target" ]; then
    validate_target_tfvars_identity "$resolved_var_file"
  fi

  printf '%s' "$resolved_var_file"
}

require_app_apply_saved_plan_args() {
  shift
  if [ "$#" -ne 2 ] || [ "$1" != "-auto-approve" ] || [ "$2" != "tfplan" ]; then
    echo "app apply accepts only the reviewed pipeline saved plan command shape: apply -auto-approve tfplan." >&2
    exit 2
  fi
}

require_app_plan_args() {
  shift

  if is_app_signature_preflight_plan_caller; then
    local -a actual_args=("$@")
    local -a expected_args=(
      "-out=tfplan"
      "-var-file=pipeline.auto.tfvars"
      "-target=terraform_data.image_signature_verifier_reconciliation_authority"
      "-target=aws_lambda_alias.image_signature_verifier_preflight"
    )
    if [ "$reviewed_target_environment_id" = "main" ] && [ "$#" -eq 10 ]; then
      require_target_tfvars_value "$terraform_working_dir/pipeline.auto.tfvars" verifier_phase prerequisite
      local initialization_targets
      initialization_targets="$(node --input-type=module --eval '
        const { resolveAppVerifierInitializationScope } = await import(process.argv[1]);
        const scope = resolveAppVerifierInitializationScope("prerequisite", process.argv[2]);
        process.stdout.write(scope.resourceAddresses.map((address) => `-target=${address}`).join("\n"));
      ' "${terraform_guard_script_dir}/../../packages/deployment-authority/src/app-verifier-initialization.js" "${reviewed_target_account_label}/${reviewed_target_environment_id}")"
      local -a prerequisite_targets
      mapfile -t prerequisite_targets <<< "$initialization_targets"
      if [ "${#prerequisite_targets[@]}" -ne 8 ]; then
        echo "Initial verifier plan requires the exact canonical resource scope." >&2
        exit 2
      fi
      expected_args=("-out=tfplan" "-var-file=pipeline.auto.tfvars" "${prerequisite_targets[@]}")
    fi
    if [ "$#" -ne "${#expected_args[@]}" ]; then
      echo "signature preflight plan accepts only the exact verifier-only saved-plan target set." >&2
      exit 2
    fi
    local index
    for index in "${!expected_args[@]}"; do
      if [ "${actual_args[$index]}" != "${expected_args[$index]}" ]; then
        echo "signature preflight plan accepts only the exact verifier-only saved-plan target set." >&2
        exit 2
      fi
    done
    return 0
  fi

  if [ "$#" -ne 2 ] || [ "$1" != "-out=tfplan" ] || [ "$2" != "-var-file=pipeline.auto.tfvars" ]; then
    echo "app plan accepts only the reviewed pipeline plan command shape: plan -out=tfplan -var-file=pipeline.auto.tfvars." >&2
    exit 2
  fi
}

require_app_init_args() {
  shift

  if [ "$#" -ne 1 ]; then
    echo "app init requires exactly one backend config argument: -backend-config=backend.pipeline.hcl." >&2
    exit 2
  fi

  case "$1" in
    -backend-config=backend.pipeline.hcl)
      ;;
    *)
      echo "app init requires exactly one backend config argument: -backend-config=backend.pipeline.hcl." >&2
      exit 2
      ;;
  esac
}

require_foundation_apply_saved_plan_args() {
  shift
  if [ "$#" -ne 2 ] || [ "$1" != "-auto-approve" ] || [ "$2" != "tfplan" ]; then
    echo "foundation apply accepts only the reviewed pipeline saved plan command shape: apply -auto-approve tfplan." >&2
    exit 2
  fi
}

require_foundation_plan_args() {
  shift
  if [ "$#" -ne 2 ] || [ "$1" != "-out=tfplan" ] || [ "$2" != "-var-file=pipeline.auto.tfvars" ]; then
    echo "foundation plan accepts only the reviewed pipeline plan command shape: plan -out=tfplan -var-file=pipeline.auto.tfvars." >&2
    exit 2
  fi
}

require_foundation_init_args() {
  shift

  if [ "$#" -ne 1 ]; then
    echo "foundation init requires exactly one backend config argument: -backend-config=backend.pipeline.hcl." >&2
    exit 2
  fi

  case "$1" in
    -backend-config=backend.pipeline.hcl)
      ;;
    *)
      echo "foundation init requires exactly one backend config argument: -backend-config=backend.pipeline.hcl." >&2
      exit 2
      ;;
  esac
}

normalize_terraform_args() {
  local resolved_var_file="$1"
  shift
  local arg
  local next_is_var_file=0
  TERRAFORM_ARGS=()

  for arg in "$@"; do
    if [ "$next_is_var_file" -eq 1 ]; then
      TERRAFORM_ARGS+=("$resolved_var_file")
      next_is_var_file=0
      continue
    fi

    case "$arg" in
      -var-file=*)
        TERRAFORM_ARGS+=("-var-file=${resolved_var_file}")
        ;;
      -var-file)
        TERRAFORM_ARGS+=("$arg")
        next_is_var_file=1
        ;;
      *)
        TERRAFORM_ARGS+=("$arg")
        ;;
    esac
  done
}

resolve_backend_config_file() {
  local backend_file="$1"
  local candidate

  if [[ "$backend_file" = /* ]]; then
    candidate="$backend_file"
  else
    candidate="${terraform_working_dir}/${backend_file}"
  fi

  if [ -f "$candidate" ]; then
    (
      cd "$(dirname "$candidate")"
      printf '%s/%s' "$(pwd -P)" "$(basename "$candidate")"
    )
    return 0
  fi

  if [ -f "$backend_file" ]; then
    (
      cd "$(dirname "$backend_file")"
      printf '%s/%s' "$(pwd -P)" "$(basename "$backend_file")"
    )
    return 0
  fi

  echo "Terraform backend config not found: $backend_file" >&2
  exit 2
}

read_backend_scalar() {
  local backend_file="$1"
  local requested_key="$2"
  local line key value

  while IFS= read -r line || [ -n "$line" ]; do
    line="$(trim "$line")"
    case "$line" in
      ''|'#'*)
        continue
        ;;
    esac
    case "$line" in
      *=*)
        key="${line%%=*}"
        key="$(trim "$key")"
        if [ "$key" != "$requested_key" ]; then
          continue
        fi
        value="${line#*=}"
        value="$(trim "$value")"
        value="${value%%#*}"
        value="$(trim "$value")"
        value="${value%\"}"
        value="${value#\"}"
        printf '%s' "$value"
        return 0
        ;;
    esac
  done < "$backend_file"

  return 1
}

require_target_backend_value() {
  local backend_file="$1"
  local key="$2"
  local expected="$3"
  local actual

  if ! actual="$(read_backend_scalar "$backend_file" "$key")"; then
    echo "Terraform target backend config must include ${key}." >&2
    exit 2
  fi
  if [ "$actual" != "$expected" ]; then
    if [ "$key" = "key" ]; then
      echo "Terraform backend key mismatch." >&2
      echo "Expected key: ${expected}" >&2
      echo "Backend key: ${actual}" >&2
      exit 2
    fi
    echo "Terraform target backend ${key} mismatch." >&2
    exit 2
  fi
}

require_matching_target_backend_identity() {
  local _identity="$1"
  shift
  local backend_file resolved_backend_file arg
  local next_is_backend_config=0 backend_config_count=0

  for arg in "$@"; do
    if [ "$next_is_backend_config" -eq 1 ]; then
      backend_file="$arg"
      backend_config_count=$((backend_config_count + 1))
      next_is_backend_config=0
      continue
    fi

    case "$arg" in
      -backend-config=*)
        backend_file="${arg#-backend-config=}"
        backend_config_count=$((backend_config_count + 1))
        ;;
      -backend-config)
        next_is_backend_config=1
        ;;
    esac
  done

  if [ "$next_is_backend_config" -eq 1 ]; then
    echo "init received -backend-config without a value." >&2
    exit 2
  fi
  if [ "$backend_config_count" -eq 0 ]; then
    echo "target account init requires -backend-config=backend.local.hcl." >&2
    exit 2
  fi
  if [ "$backend_config_count" -ne 1 ]; then
    echo "target account init accepts exactly one -backend-config file." >&2
    exit 2
  fi

  resolved_backend_file="$(resolve_backend_config_file "$backend_file")"
  require_target_backend_value "$resolved_backend_file" bucket "$reviewed_target_state_bucket"
  require_target_backend_value "$resolved_backend_file" key "$reviewed_target_backend_key"
  require_target_backend_value "$resolved_backend_file" region "$reviewed_target_region"
  require_target_backend_value "$resolved_backend_file" kms_key_id "$reviewed_target_state_kms_alias"
  require_target_backend_value "$resolved_backend_file" use_lockfile true
  require_target_backend_value "$resolved_backend_file" encrypt true
}

require_backend_value() {
  local backend_file="$1"
  local key="$2"
  local expected="$3"
  local label="$4"
  local actual

  if ! actual="$(read_backend_scalar "$backend_file" "$key")"; then
    echo "Terraform app backend config must include ${key}." >&2
    exit 2
  fi
  if [ "$actual" != "$expected" ]; then
    echo "Terraform app backend ${label} mismatch." >&2
    echo "Expected ${label}: ${expected}" >&2
    echo "Backend ${label}: ${actual}" >&2
    exit 2
  fi
}

require_expected_app_backend_value() {
  local label="$1"
  shift
  local value

  value="$(first_nonempty "$@" || true)"
  if [ -z "$value" ]; then
    echo "Missing expected app backend ${label} for the reviewed App init." >&2
    exit 2
  fi

  printf '%s' "$value"
}

require_matching_app_backend_identity() {
  local _identity="$1"
  shift
  local backend_file resolved_backend_file
  local configured_region expected_bucket expected_key expected_region expected_kms_key_id

  if [ "$#" -gt 0 ] && [ "$1" = "init" ]; then
    shift
  fi
  backend_file="${1#-backend-config=}"
  resolved_backend_file="$(resolve_backend_config_file "$backend_file")"
  expected_bucket="$(
    require_expected_app_backend_value bucket TERRAFORM_APP_BACKEND_BUCKET TERRAFORM_STATE_BUCKET_NAME TERRAFORM_STATE_BUCKET
  )"
  expected_key="$reviewed_target_backend_key"
  configured_region="$(first_nonempty TERRAFORM_APP_BACKEND_REGION TERRAFORM_AWS_REGION AWS_REGION AWS_DEFAULT_REGION || true)"
  if [ -n "$configured_region" ] && [ "$configured_region" != "$reviewed_target_region" ]; then
    echo "Terraform app backend configured region mismatch." >&2
    echo "Reviewed target region: $reviewed_target_region" >&2
    exit 2
  fi
  expected_region="$reviewed_target_region"
  expected_kms_key_id="$(
    require_expected_app_backend_value kms_key_id TERRAFORM_APP_BACKEND_KMS_KEY_ID TERRAFORM_STATE_KMS_KEY_ID TERRAFORM_STATE_KMS_ALIAS
  )"

  require_backend_value "$resolved_backend_file" bucket "$expected_bucket" bucket
  require_backend_value "$resolved_backend_file" key "$expected_key" key
  require_backend_value "$resolved_backend_file" region "$expected_region" region
  require_backend_value "$resolved_backend_file" encrypt "true" encrypt
  require_backend_value "$resolved_backend_file" kms_key_id "$expected_kms_key_id" kms_key_id
  require_backend_value "$resolved_backend_file" use_lockfile "true" use_lockfile
}

if [ "$#" -lt 2 ]; then
  usage >&2
  exit 2
fi

identity_arg="$1"
shift
mode="legacy"
case "$identity_arg" in
  develop|main)
    env_name="$identity_arg"
    ;;
  *)
    if is_target_identity "$identity_arg"; then
      mode="target"
      parse_target_identity "$identity_arg"
      resolve_reviewed_target_root "$identity_arg" "$target_state_scope"
      env_name="$reviewed_target_environment_id"
    else
      echo "Environment must be develop, main, or <account-alias>/<environment>/<state-scope>." >&2
      usage >&2
      exit 2
    fi
    ;;
esac

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
load_env_file ".env.local"
terraform_working_dir="${TERRAFORM_WORKING_DIR:-infra/terraform/legacy}"
if [[ "$terraform_working_dir" = /* ]]; then
  echo "TERRAFORM_WORKING_DIR must be relative to the repository root." >&2
  exit 2
fi
if [[ "$terraform_working_dir" == *..* ]]; then
  echo "TERRAFORM_WORKING_DIR must not contain '..'." >&2
  exit 2
fi
if [ "$mode" = "target" ]; then
  require_target_terraform_working_dir "$identity_arg" "$terraform_working_dir"
fi
if [ ! -d "$terraform_working_dir" ]; then
  echo "Terraform working directory not found: $terraform_working_dir" >&2
  exit 2
fi

if [ "$mode" = "legacy" ]; then
  env_upper="${env_name^^}"
  expected_account_id="$(require_expected_account "$env_upper")"
  require_terraform_admin_caller "$expected_account_id"
  require_matching_workspace "$env_name"
else
  expected_account_id="$(require_expected_target_account "$reviewed_target_account_label")"
  if [ "$reviewed_target_scope" = "app" ]; then
    require_app_caller_for_command "$expected_account_id" "$1"
  elif [ "$reviewed_target_scope" = "foundation" ]; then
    require_foundation_caller_for_command "$expected_account_id" "$1"
  else
    require_reviewed_bootstrap_identity "$identity_arg"
    require_target_caller "$expected_account_id" "$target_state_scope"
  fi
  if [ "$reviewed_target_scope" = "app" ] && [ "$1" = "apply" ]; then
    require_app_apply_saved_plan_args "$@"
  fi
  if [ "$reviewed_target_scope" = "foundation" ] && [ "$1" = "apply" ]; then
    require_foundation_apply_saved_plan_args "$@"
  fi
  if [ "$reviewed_target_scope" = "app" ] && [ "$1" = "plan" ]; then
    require_app_plan_args "$@"
  fi
  if [ "$reviewed_target_scope" = "foundation" ] && [ "$1" = "plan" ]; then
    require_foundation_plan_args "$@"
  fi
  if [ "$reviewed_target_scope" = "app" ] && [ "$1" = "init" ]; then
    require_app_init_args "$@"
    require_matching_app_backend_identity "$identity_arg" "$@"
  fi
  if [ "$reviewed_target_scope" = "foundation" ] && [ "$1" = "init" ]; then
    require_foundation_init_args "$@"
  fi
  if [ "$1" = "smoke" ] && [ "$reviewed_target_scope" = "app" ]; then
    echo "App smoke guard passed for ${identity_arg}."
    exit 0
  elif [ "$1" = "smoke" ] && [ "$reviewed_target_scope" = "foundation" ]; then
    echo "foundation smoke guard passed for ${identity_arg}."
    exit 0
  elif [ "$1" = "init" ]; then
    if [ "$reviewed_target_scope" != "app" ]; then
      require_matching_target_backend_identity "$identity_arg" "$@"
    fi
  else
    require_matching_workspace "default"
  fi
fi

validated_var_file="$(require_matching_tfvars_environment "$env_name" "$1" "$@")"
if [ -n "$validated_var_file" ]; then
  normalize_terraform_args "$validated_var_file" "$@"
else
  TERRAFORM_ARGS=("$@")
fi

if [ "$mode" = "legacy" ]; then
  echo "Terraform guard passed for ${env_name}."
else
  echo "Terraform guard passed for ${identity_arg}."
fi
exec terraform -chdir="$terraform_working_dir" "${TERRAFORM_ARGS[@]}"

#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

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

require_current_phase04_target_identity() {
  local identity="$1"

  if [ "$identity" != "stark-dev/develop/bootstrap" ]; then
    echo "Current Phase 04 helper execution is authorized only for stark-dev/develop/bootstrap." >&2
    echo "Production bootstrap and app state identities require a later authorization record." >&2
    exit 2
  fi
}

parse_target_identity() {
  local identity="$1"
  IFS=/ read -r target_account_alias target_environment target_state_scope <<< "$identity"
}

expected_target_terraform_working_dir() {
  local identity="$1"

  case "$identity" in
    stark-dev/develop/bootstrap)
      printf '%s' "infra/terraform/bootstrap"
      ;;
    stark-dev/develop/foundation)
      printf '%s' "infra/terraform/foundation"
      ;;
    stark-dev/develop/app|stark-prod/main/app)
      printf '%s' "infra/terraform/app"
      ;;
    *)
      echo "No Terraform root is authorized for target identity ${identity}." >&2
      exit 2
      ;;
  esac
}

require_target_terraform_working_dir() {
  local identity="$1"
  local working_dir="$2"
  local expected_working_dir

  expected_working_dir="$(expected_target_terraform_working_dir "$identity")"
  if [ "$working_dir" != "$expected_working_dir" ]; then
    echo "Terraform working directory mismatch for target account mode." >&2
    echo "Expected TERRAFORM_WORKING_DIR: $expected_working_dir" >&2
    echo "Current TERRAFORM_WORKING_DIR: $working_dir" >&2
    exit 2
  fi
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
  local expected_key

  expected_key="stark-ballot-simulator/${identity_arg}/terraform.tfstate"
  require_target_tfvars_value "$var_file" aws_account_id "$expected_account_id"
  require_target_tfvars_value "$var_file" account_alias "$target_account_alias"
  require_target_tfvars_value "$var_file" deployment_environment "$target_environment"
  require_target_tfvars_value "$var_file" state_scope "$target_state_scope"
  require_target_tfvars_value "$var_file" state_backend_key "$expected_key"
  validate_optional_target_tfvars_value "$var_file" project_name "stark-ballot-simulator"
  validate_optional_target_tfvars_value "$var_file" source_branch "$target_environment"
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

  printf '%s' "$expected_account_id"
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
        required_pattern="^arn:aws:sts::${expected_account_id}:assumed-role/AWSReservedSSO_AdministratorAccess_[A-Za-z0-9]+/.+$"
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

app_plan_role_name() {
  printf 'stark-ballot-sim-tf-plan-%s-%s-app' "$target_account_alias" "$target_environment"
}

app_apply_role_name() {
  printf 'stark-ballot-sim-tf-apply-%s-%s-app' "$target_account_alias" "$target_environment"
}

app_smoke_role_name() {
  printf 'stark-ballot-sim-tf-smoke-%s-%s-app' "$target_account_alias" "$target_environment"
}

foundation_plan_role_name() {
  printf 'stark-ballot-sim-tf-plan-%s-%s-foundation' "$target_account_alias" "$target_environment"
}

foundation_apply_role_name() {
  printf 'stark-ballot-sim-tf-apply-%s-%s-foundation' "$target_account_alias" "$target_environment"
}

foundation_smoke_role_name() {
  printf 'stark-ballot-sim-tf-smoke-%s-%s-foundation' "$target_account_alias" "$target_environment"
}

require_app_caller_for_command() {
  local expected_account_id="$1"
  local command_name="$2"
  local role_name role_label required_pattern role_error

  case "$command_name" in
    init)
      role_name="$(app_plan_role_name)|$(app_apply_role_name)"
      role_label="plan or apply"
      ;;
    validate|plan)
      role_name="$(app_plan_role_name)"
      role_label="plan"
      ;;
    apply)
      role_name="$(app_apply_role_name)"
      role_label="apply"
      ;;
    smoke)
      role_name="$(app_smoke_role_name)"
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

  required_pattern="^arn:aws:sts::${expected_account_id}:assumed-role/(${role_name})/.+$"
  role_error="Terraform app guard requires the app ${role_label} CodeBuild role for ${command_name}."
  require_allowed_caller "$expected_account_id" "$required_pattern" "$role_error"
}

require_foundation_caller_for_command() {
  local expected_account_id="$1"
  local command_name="$2"
  local role_name role_label required_pattern role_error

  case "$command_name" in
    init)
      role_name="$(foundation_plan_role_name)|$(foundation_apply_role_name)"
      role_label="plan or apply"
      ;;
    validate|plan)
      role_name="$(foundation_plan_role_name)"
      role_label="plan"
      ;;
    apply)
      role_name="$(foundation_apply_role_name)"
      role_label="apply"
      ;;
    smoke)
      role_name="$(foundation_smoke_role_name)"
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

  required_pattern="^arn:aws:sts::${expected_account_id}:assumed-role/(${role_name})/.+$"
  role_error="Terraform foundation guard requires the foundation ${role_label} CodeBuild role for ${command_name}."
  require_allowed_caller "$expected_account_id" "$required_pattern" "$role_error"
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

  if [ "$mode" = "target" ] && { [ "${target_state_scope:-}" = "app" ] || [ "${target_state_scope:-}" = "foundation" ]; }; then
    expected_var_file_name="pipeline.auto.tfvars"
    if [ "$(basename "$var_file")" != "$expected_var_file_name" ]; then
      echo "$command_name requires -var-file=${expected_var_file_name} for target ${target_state_scope} state." >&2
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

read_backend_key() {
  local backend_file="$1"
  local value

  if value="$(read_backend_scalar "$backend_file" key)"; then
    printf '%s' "$value"
    return 0
  fi

  echo "Terraform backend config must include key for target account mode." >&2
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

require_matching_backend_key() {
  local identity="$1"
  shift
  local expected_key backend_file resolved_backend_file backend_key arg
  local next_is_backend_config=0 backend_config_count=0

  expected_key="stark-ballot-simulator/${identity}/terraform.tfstate"

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
  backend_key="$(read_backend_key "$resolved_backend_file")"
  if [ "$backend_key" != "$expected_key" ]; then
    echo "Terraform backend key mismatch." >&2
    echo "Expected key: $expected_key" >&2
    echo "Backend key: $backend_key" >&2
    exit 2
  fi
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
    echo "Missing expected app backend ${label} for stark-dev/develop/app init." >&2
    exit 2
  fi

  printf '%s' "$value"
}

require_matching_app_backend_identity() {
  local identity="$1"
  shift
  local backend_file resolved_backend_file
  local expected_bucket expected_key expected_region expected_kms_key_id

  if [ "$#" -gt 0 ] && [ "$1" = "init" ]; then
    shift
  fi
  backend_file="${1#-backend-config=}"
  resolved_backend_file="$(resolve_backend_config_file "$backend_file")"
  expected_bucket="$(
    require_expected_app_backend_value bucket TERRAFORM_APP_BACKEND_BUCKET TERRAFORM_STATE_BUCKET_NAME TERRAFORM_STATE_BUCKET
  )"
  expected_key="stark-ballot-simulator/${identity}/terraform.tfstate"
  expected_region="$(
    require_expected_app_backend_value region TERRAFORM_APP_BACKEND_REGION TERRAFORM_AWS_REGION AWS_REGION AWS_DEFAULT_REGION
  )"
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
      if [ "$identity_arg" != "stark-dev/develop/bootstrap" ] && [ "$identity_arg" != "stark-dev/develop/foundation" ] && [ "$identity_arg" != "stark-dev/develop/app" ] && [ "$identity_arg" != "stark-prod/main/app" ]; then
        echo "Current target helper execution is authorized only for stark-dev/develop/bootstrap, stark-dev/develop/foundation, stark-dev/develop/app, and protected-production app static contract checks." >&2
        echo "Production bootstrap requires a later authorization record." >&2
        exit 2
      fi
      env_name="$target_environment"
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
  expected_account_id="$(require_expected_target_account "$target_account_alias")"
  if [ "$target_state_scope" = "app" ]; then
    require_app_caller_for_command "$expected_account_id" "$1"
  elif [ "$target_state_scope" = "foundation" ]; then
    require_foundation_caller_for_command "$expected_account_id" "$1"
  else
    require_current_phase04_target_identity "$identity_arg"
    require_target_caller "$expected_account_id" "$target_state_scope"
  fi
  if [ "$target_state_scope" = "app" ] && [ "$1" = "apply" ]; then
    require_app_apply_saved_plan_args "$@"
  fi
  if [ "$target_state_scope" = "foundation" ] && [ "$1" = "apply" ]; then
    require_foundation_apply_saved_plan_args "$@"
  fi
  if [ "$target_state_scope" = "app" ] && [ "$1" = "plan" ]; then
    require_app_plan_args "$@"
  fi
  if [ "$target_state_scope" = "foundation" ] && [ "$1" = "plan" ]; then
    require_foundation_plan_args "$@"
  fi
  if [ "$target_state_scope" = "app" ] && [ "$1" = "init" ]; then
    require_app_init_args "$@"
    require_matching_app_backend_identity "$identity_arg" "$@"
  fi
  if [ "$target_state_scope" = "foundation" ] && [ "$1" = "init" ]; then
    require_foundation_init_args "$@"
  fi
  if [ "$1" = "smoke" ] && [ "$target_state_scope" = "app" ]; then
    echo "App smoke guard passed for ${identity_arg}."
    exit 0
  elif [ "$1" = "smoke" ] && [ "$target_state_scope" = "foundation" ]; then
    echo "foundation smoke guard passed for ${identity_arg}."
    exit 0
  elif [ "$1" = "init" ]; then
    if [ "$target_state_scope" != "app" ]; then
      require_matching_backend_key "$identity_arg" "$@"
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
